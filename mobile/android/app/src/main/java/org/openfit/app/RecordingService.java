package org.openfit.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import java.io.BufferedWriter;
import java.io.File;
import java.io.FileWriter;

/**
 * Foreground workout-recording engine. Samples GPS (1 Hz) + accelerometer &
 * gyroscope (25 Hz) on a dedicated HandlerThread and appends each reading to a
 * crash-safe JSONL file under filesDir/recordings/&lt;sessionId&gt;/. Holds a
 * PARTIAL_WAKE_LOCK so sampling continues with the screen off (the foreground
 * service keeps the process alive but NOT the CPU). Heart rate is fed in from the
 * existing Helio BLE stream via {@link #feedHeartRate}. Controlled by the plugin
 * through Intent actions; emits a 1 Hz live summary via {@link #liveListener}.
 *
 * See docs/WORKOUT-RECORDING-DESIGN.md §3.
 */
public class RecordingService extends Service implements SensorEventListener, LocationListener {
    private static final String TAG = "RecordingService";
    static final String CHANNEL_ID = "openfit_recording";
    static final int NOTIF_ID = 1001;
    private static final long IMU_PERIOD_NS = 40_000_000L; // 25 Hz throttle
    private static final int IMU_PERIOD_US = 40_000;
    private static final String PREFS = "ofit_recording";

    static final String ACTION_START = "org.openfit.app.REC_START";
    static final String ACTION_PAUSE = "org.openfit.app.REC_PAUSE";
    static final String ACTION_RESUME = "org.openfit.app.REC_RESUME";
    static final String ACTION_STOP = "org.openfit.app.REC_STOP";

    /** Live 1 Hz summary + lifecycle, consumed by RecordingPlugin to update the UI. */
    public interface LiveListener {
        void onTick(long elapsedMs, double distanceM, double speedMps, int hr, int cadence,
                    int power, double altitudeM, double ascentM, boolean paused);
        void onStopped(String sessionDir, long elapsedMs);
    }
    private static volatile LiveListener liveListener;
    public static void setLiveListener(LiveListener l) { liveListener = l; }

    /**
     * Additive seam for device data to reach an in-progress recording. BLE
     * protocols post live metrics here by kind ("heart_rate", "cadence", "power", …)
     * instead of being hard-wired to HR. Mirrors the existing static feedHeartRate
     * pattern; the recorder registers its sink while a session is active.
     */
    public interface MetricsSink {
        void onMetric(String kind, double value, long ts);
    }

    public static final String KIND_HEART_RATE = "heart_rate";
    public static final String KIND_CADENCE = "cadence";
    public static final String KIND_POWER = "power";

    private static volatile MetricsSink metricsSink;
    public static void setMetricsSink(MetricsSink sink) { metricsSink = sink; }

    /** Route a live metric into the recording, if a sink is registered. */
    public static void feedMetric(String kind, double value, long ts) {
        MetricsSink s = metricsSink;
        if (s != null) s.onMetric(kind, value, ts);
    }

    /** Most-recent live HR from the Helio stream, written into the recording. */
    private static volatile int latestHr = 0;
    private static volatile long latestHrAt = 0;
    /** Kept for compatibility: HR feed delegates to the metrics sink. */
    public static void feedHeartRate(int bpm) {
        feedMetric(KIND_HEART_RATE, bpm, SystemClock.elapsedRealtime());
    }

    /** Whether a session is active (so the BLE plugin only feeds HR when recording). */
    private static volatile boolean recording = false;
    public static boolean isRecording() { return recording; }

    private HandlerThread thread;
    private Handler handler;
    private SensorManager sm;
    private LocationManager lm;
    private PowerManager.WakeLock wl;

    private String sport = "running";
    private String sessionId;
    private File sessionDir;
    private BufferedWriter writer;
    private long startElapsedNs;
    private long startWallMs;
    private boolean paused = false;
    private boolean gpsEnabled = false;
    // Timer (moving) time = total elapsed MINUS paused stretches. Sample/event `t`
    // stay total-elapsed (monotonic, for FIT records); this drives the displayed clock.
    private long timerBaseMs = 0;
    private long segStartRtMs = 0;

    private final long[] lastImuEmit = new long[64]; // per sensor.type throttle
    private double cumDistanceM = 0;
    private double lastSpeedMps = 0;
    private double lastLat = Double.NaN, lastLon = Double.NaN;
    private double lastAltM = Double.NaN, cumAscentM = 0;
    private int lastCadence = 0, lastPower = 0;
    private long lastFlush = 0;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (action == null) action = ACTION_START; // null = sticky restart → resume
        switch (action) {
            case ACTION_PAUSE:
                setPaused(true);
                return START_STICKY;
            case ACTION_RESUME:
                setPaused(false);
                return START_STICKY;
            case ACTION_STOP:
                finishSession();
                return START_NOT_STICKY;
            default: // START (or sticky restart)
                startSession(intent);
                return START_STICKY;
        }
    }

    private void startSession(Intent intent) {
        SharedPreferences p = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (intent != null && intent.hasExtra("sport")) {
            sport = intent.getStringExtra("sport");
            sessionId = intent.getStringExtra("sessionId");
            startWallMs = intent.getLongExtra("startWallMs", System.currentTimeMillis());
            p.edit().putString("sport", sport).putString("sessionId", sessionId)
                .putLong("startWallMs", startWallMs).apply();
        } else {
            // Sticky restart after a process kill — resume the persisted session.
            sport = p.getString("sport", "running");
            sessionId = p.getString("sessionId", null);
            startWallMs = p.getLong("startWallMs", System.currentTimeMillis());
            if (sessionId == null) {
                stopSelf();
                return;
            }
        }
        startElapsedNs = SystemClock.elapsedRealtimeNanos();
        timerBaseMs = 0;
        segStartRtMs = SystemClock.elapsedRealtime();

        createChannel();
        startInForeground();

        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "openfit:recording");
        wl.setReferenceCounted(false);
        wl.acquire();

        thread = new HandlerThread("recording-sensors");
        thread.start();
        handler = new Handler(thread.getLooper());

        openWriter();
        writeLine("{\"k\":\"ev\",\"v\":\"start\",\"t\":0,\"sport\":\"" + sport + "\"}");
        // Receive live device metrics (HR, and where available cadence/power) for the
        // duration of the session. Cleared on finish/destroy.
        setMetricsSink(this::ingestMetric);
        startImu();
        if (!"calisthenics".equals(sport)) startGps();
        recording = true;
        handler.postDelayed(ticker, 1000);
        Log.i(TAG, "session started sport=" + sport + " id=" + sessionId + " gps=" + gpsEnabled);
    }

    /** 1 Hz live summary to the UI (never per-sample — 25 Hz would flood the bridge). */
    private final Runnable ticker = new Runnable() {
        @Override
        public void run() {
            // Record HR into the file at 1 Hz (it arrives from the Helio stream, not
            // a sensor callback, so the ticker is where we sample it).
            if (!paused) {
                int hr = snapHr();
                if (hr > 0) writeLine("{\"k\":\"hr\",\"t\":" + nowMs() + ",\"v\":" + hr + "}");
            }
            LiveListener l = liveListener;
            if (l != null) {
                l.onTick(snapElapsedMs(), snapDistanceM(), snapSpeedMps(), snapHr(),
                    snapCadence(), snapPower(), snapAltitude(), snapAscent(), snapPaused());
            }
            if (recording && handler != null) handler.postDelayed(this, 1000);
        }
    };

    private void startInForeground() {
        Notification n = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Recording " + sport)
            .setContentText("GPS + motion sensors active")
            .setSmallIcon(getApplicationInfo().icon)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();
        int type = ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE;
        if (!"calisthenics".equals(sport)) type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, n, type);
        } else {
            startForeground(NOTIF_ID, n);
        }
    }

    private void openWriter() {
        try {
            File root = new File(getFilesDir(), "recordings/" + sessionId);
            //noinspection ResultOfMethodCallIgnored
            root.mkdirs();
            sessionDir = root;
            writer = new BufferedWriter(new FileWriter(new File(root, "samples.jsonl"), true));
            // session.meta.json
            try (BufferedWriter mw = new BufferedWriter(new FileWriter(new File(root, "session.meta.json"), false))) {
                mw.write("{\"sessionId\":\"" + sessionId + "\",\"sport\":\"" + sport
                    + "\",\"startedAtUnixMs\":" + startWallMs + ",\"endedAtUnixMs\":null}");
            }
        } catch (Exception e) {
            Log.w(TAG, "openWriter failed: " + e.getMessage());
        }
    }

    private synchronized void writeLine(String json) {
        if (writer == null) return;
        try {
            writer.write(json);
            writer.write('\n');
            long now = SystemClock.elapsedRealtime();
            if (now - lastFlush > 1000) {
                writer.flush();
                lastFlush = now;
            }
        } catch (Exception e) {
            Log.w(TAG, "writeLine failed: " + e.getMessage());
        }
    }

    private long elapsedMsFromNanos(long eventNanos) {
        return Math.max(0, (eventNanos - startElapsedNs) / 1_000_000L);
    }

    private void startImu() {
        sm = (SensorManager) getSystemService(SENSOR_SERVICE);
        Sensor a = sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
        Sensor g = sm.getDefaultSensor(Sensor.TYPE_GYROSCOPE);
        if (a != null) sm.registerListener(this, a, IMU_PERIOD_US, 0, handler);
        if (g != null) sm.registerListener(this, g, IMU_PERIOD_US, 0, handler);
    }

    @SuppressWarnings("MissingPermission")
    private void startGps() {
        lm = (LocationManager) getSystemService(LOCATION_SERVICE);
        try {
            lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000L, 0f, this, thread.getLooper());
            gpsEnabled = true;
        } catch (SecurityException e) {
            Log.w(TAG, "no location permission: " + e.getMessage());
        } catch (Exception e) {
            Log.w(TAG, "startGps failed: " + e.getMessage());
        }
    }

    @Override
    public void onSensorChanged(SensorEvent e) {
        if (paused) return;
        int t = e.sensor.getType();
        if (t < lastImuEmit.length && e.timestamp - lastImuEmit[t] < IMU_PERIOD_NS) return;
        if (t < lastImuEmit.length) lastImuEmit[t] = e.timestamp;
        long ms = elapsedMsFromNanos(e.timestamp);
        String k = t == Sensor.TYPE_ACCELEROMETER ? "acc" : t == Sensor.TYPE_GYROSCOPE ? "gyr" : null;
        if (k == null) return;
        writeLine("{\"k\":\"" + k + "\",\"t\":" + ms
            + ",\"x\":" + f(e.values[0]) + ",\"y\":" + f(e.values[1]) + ",\"z\":" + f(e.values[2]) + "}");
    }

    @Override
    public void onAccuracyChanged(Sensor s, int a) {}

    @Override
    public void onLocationChanged(Location loc) {
        if (paused) return;
        if (!loc.hasAccuracy() || loc.getAccuracy() > 50f) return; // drop poor fixes
        long ms = elapsedMsFromNanos(loc.getElapsedRealtimeNanos());
        double lat = loc.getLatitude(), lon = loc.getLongitude();
        double alt = loc.hasAltitude() ? loc.getAltitude() : 0;
        double spd = loc.hasSpeed() ? loc.getSpeed() : 0;
        if (!Double.isNaN(lastLat)) {
            cumDistanceM += haversine(lastLat, lastLon, lat, lon);
        }
        if (loc.hasAltitude()) {
            if (!Double.isNaN(lastAltM) && alt > lastAltM) cumAscentM += (alt - lastAltM);
            lastAltM = alt;
        }
        lastLat = lat;
        lastLon = lon;
        lastSpeedMps = spd;
        writeLine("{\"k\":\"gps\",\"t\":" + ms + ",\"lat\":" + d(lat) + ",\"lng\":" + d(lon)
            + ",\"alt\":" + f((float) alt) + ",\"spd\":" + f((float) spd)
            + ",\"hacc\":" + f(loc.getAccuracy()) + "}");
        writeLine("{\"k\":\"dist\",\"t\":" + ms + ",\"v\":" + f((float) cumDistanceM) + "}");
    }

    @Override public void onProviderEnabled(String p) {}
    @Override public void onProviderDisabled(String p) {}
    @Override public void onStatusChanged(String p, int st, Bundle b) {}

    private void setPaused(boolean p) {
        if (paused == p) return;
        if (p) {
            // close the active segment into the timer accumulator
            timerBaseMs += SystemClock.elapsedRealtime() - segStartRtMs;
        } else {
            segStartRtMs = SystemClock.elapsedRealtime();
        }
        paused = p;
        writeLine("{\"k\":\"ev\",\"v\":\"" + (p ? "pause" : "resume") + "\",\"t\":" + nowMs() + "}");
    }

    /** Total elapsed since start (monotonic) — for FIT record/event timestamps. */
    private long nowMs() {
        return Math.max(0, SystemClock.elapsedRealtimeNanos() - startElapsedNs) / 1_000_000L;
    }

    /** Moving time (excludes paused stretches) — for the displayed clock + duration. */
    private long timerMs() {
        return paused ? timerBaseMs : timerBaseMs + (SystemClock.elapsedRealtime() - segStartRtMs);
    }

    private void finishSession() {
        recording = false;
        setMetricsSink(null);       // stop receiving device metrics
        long elapsed = timerMs();   // moving time = the workout duration shown/saved
        long totalMs = nowMs();     // monotonic file timestamp for the stop event
        writeLine("{\"k\":\"ev\",\"v\":\"stop\",\"t\":" + totalMs + "}");
        try { if (sm != null) sm.unregisterListener(this); } catch (Exception ignored) {}
        try { if (lm != null) lm.removeUpdates(this); } catch (Exception ignored) {}
        synchronized (this) {
            try {
                if (writer != null) { writer.flush(); writer.close(); }
            } catch (Exception ignored) {}
            writer = null;
        }
        // patch endedAt into the meta file
        try (BufferedWriter mw = new BufferedWriter(new FileWriter(new File(sessionDir, "session.meta.json"), false))) {
            mw.write("{\"sessionId\":\"" + sessionId + "\",\"sport\":\"" + sport
                + "\",\"startedAtUnixMs\":" + startWallMs + ",\"endedAtUnixMs\":" + System.currentTimeMillis()
                + ",\"elapsedMs\":" + elapsed + ",\"distanceM\":" + f((float) cumDistanceM) + "}");
        } catch (Exception ignored) {}
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply();
        LiveListener l = liveListener;
        if (l != null && sessionDir != null) l.onStopped(sessionDir.getAbsolutePath(), elapsed);
        stopForegroundCompat();
        if (wl != null && wl.isHeld()) wl.release();
        if (thread != null) thread.quitSafely();
        stopSelf();
    }

    @Override
    public void onDestroy() {
        recording = false;
        setMetricsSink(null);
        try { if (sm != null) sm.unregisterListener(this); } catch (Exception ignored) {}
        try { if (lm != null) lm.removeUpdates(this); } catch (Exception ignored) {}
        synchronized (this) {
            try { if (writer != null) { writer.flush(); writer.close(); } } catch (Exception ignored) {}
            writer = null;
        }
        if (wl != null && wl.isHeld()) wl.release();
        if (thread != null) thread.quitSafely();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent i) { return null; }

    private void stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(Service.STOP_FOREGROUND_REMOVE);
        else stopForeground(true);
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
                NotificationChannel c = new NotificationChannel(
                    CHANNEL_ID, "Workout recording", NotificationManager.IMPORTANCE_LOW);
                c.setDescription("Records GPS + motion while a workout is in progress.");
                nm.createNotificationChannel(c);
            }
        }
    }

    /** Sink target: fold a live device metric into the recorder's latest-value state.
     *  HR keeps its existing freshness-gated path (latestHr/latestHrAt); cadence/power
     *  update their snapshot fields. Unknown kinds are ignored.
     *  <p>HR freshness ({@link #snapHr()}) is measured against {@code elapsedRealtime},
     *  so latestHrAt is stamped from that clock here regardless of the source ts. */
    private void ingestMetric(String kind, double value, long ts) {
        if (KIND_HEART_RATE.equals(kind)) {
            latestHr = (int) Math.round(value);
            latestHrAt = SystemClock.elapsedRealtime();
        } else if (KIND_CADENCE.equals(kind)) {
            lastCadence = (int) Math.round(value);
        } else if (KIND_POWER.equals(kind)) {
            lastPower = (int) Math.round(value);
        }
    }

    // --- live snapshot accessors (read by the plugin's 1 Hz tick) ---
    double snapDistanceM() { return cumDistanceM; }
    double snapSpeedMps() { return lastSpeedMps; }
    long snapElapsedMs() { return timerMs(); }
    boolean snapPaused() { return paused; }
    int snapHr() { return (SystemClock.elapsedRealtime() - latestHrAt) < 8000 ? latestHr : 0; }
    int snapCadence() { return lastCadence; }
    int snapPower() { return lastPower; }
    double snapAltitude() { return Double.isNaN(lastAltM) ? 0 : lastAltM; }
    double snapAscent() { return cumAscentM; }

    // --- helpers ---
    private static String f(float v) {
        if (Float.isNaN(v) || Float.isInfinite(v)) return "0";
        return String.valueOf(Math.round(v * 100f) / 100f);
    }
    private static String d(double v) {
        if (Double.isNaN(v) || Double.isInfinite(v)) return "0";
        return String.format(java.util.Locale.US, "%.6f", v);
    }
    private static double haversine(double lat1, double lon1, double lat2, double lon2) {
        double R = 6371000.0;
        double dLat = Math.toRadians(lat2 - lat1);
        double dLon = Math.toRadians(lon2 - lon1);
        double a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
            + Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2))
            * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }
}

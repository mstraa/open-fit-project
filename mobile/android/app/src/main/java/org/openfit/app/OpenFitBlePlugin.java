package org.openfit.app;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanResult;
import android.bluetooth.BluetoothStatusCodes;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.openfit.app.huami.HuamiSession;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * OpenFit native BLE plugin. Two modes:
 *  - "standard": read the standard Heart Rate service (0x180D/0x2A37). [M0]
 *  - "huami":    Zepp-OS / Huami auth handshake + encrypted transport → realtime
 *                HR over the standard 0x2A37 char, gated behind auth. [M1]
 * See docs/NATIVE-BLE-PORT.md. The serialized GATT op queue + scan/connect are
 * shared; the Huami protocol logic lives under org.openfit.app.huami.
 */
@CapacitorPlugin(
    name = "OpenFitBle",
    permissions = {
        @Permission(
            alias = "ble",
            strings = {Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT}
        )
    }
)
public class OpenFitBlePlugin extends Plugin {

    private static final UUID HR_SERVICE = uuid16("180d");
    private static final UUID HR_MEASUREMENT = uuid16("2a37");
    private static final UUID CCCD = uuid16("2902");
    private static final UUID CHUNK_WRITE = UUID.fromString("00000016-0000-3512-2118-0009af100700");
    private static final UUID CHUNK_READ = UUID.fromString("00000017-0000-3512-2118-0009af100700");
    private static final UUID ACTIVITY_CONTROL = UUID.fromString("00000004-0000-3512-2118-0009af100700");
    private static final UUID ACTIVITY_DATA = UUID.fromString("00000005-0000-3512-2118-0009af100700");
    // Garmin GFDI multi-link service + first receive(notify)/send(write) pair.
    private static final UUID GARMIN_ML_SERVICE = UUID.fromString("6a4e2800-667b-11e3-949a-0800200c9a66");
    private static final UUID GARMIN_ML_RECV = UUID.fromString("6a4e2810-667b-11e3-949a-0800200c9a66");
    private static final UUID GARMIN_ML_SEND = UUID.fromString("6a4e2820-667b-11e3-949a-0800200c9a66");

    private final Handler main = new Handler(Looper.getMainLooper());

    private BluetoothAdapter adapter;
    private BluetoothLeScanner scanner;
    private ScanCallback scanCallback;

    // Each added device gets its own DeviceLink (independent GATT + op queue), so
    // the Helio and the Garmin can stream live simultaneously. Keyed by deviceId.
    private final java.util.Map<String, DeviceLink> links = new java.util.concurrent.ConcurrentHashMap<>();

    private static final java.text.SimpleDateFormat RFC3339;
    static {
        RFC3339 = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", java.util.Locale.US);
        RFC3339.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
    }

    // Native ingest (survives screen-lock; the WebView JS is suspended then).
    private final ExecutorService ingestExec = Executors.newSingleThreadExecutor();
    private String apiBase;
    private String authToken;
    private long lastIngest = 0;

    // M2 stored-data sync: a per-device watermark so each sync pulls only NEW data
    // (the device keeps ~40 days). First sync (no watermark) pulls the full window.
    private static final long DEFAULT_WINDOW_MS = 40L * 24 * 3600 * 1000;
    private static final long SYNC_OVERLAP_MS = 10L * 60 * 1000;        // re-pull last 10 min (idempotent)
    private static final long AUTO_SYNC_MIN_INTERVAL_MS = 10L * 60 * 1000; // throttle auto-sync on (re)connect
    private static final long PERIODIC_SYNC_MS = 15L * 60 * 1000;        // background refresh while connected
    private static final long RECOMPUTE_MIN_INTERVAL_MS = 20L * 60 * 1000; // throttle auto-recompute after sync

    private static UUID uuid16(String s) {
        return UUID.fromString("0000" + s + "-0000-1000-8000-00805f9b34fb");
    }

    private BluetoothAdapter adapter() {
        if (adapter == null) {
            BluetoothManager bm = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
            adapter = bm != null ? bm.getAdapter() : null;
        }
        return adapter;
    }

    // ----------------------------------------------------------------- scan

    @PluginMethod
    public void startScan(PluginCall call) {
        if (getPermissionState("ble") != PermissionState.GRANTED) {
            requestPermissionForAlias("ble", call, "blePermsCallback");
            return;
        }
        doStartScan(call);
    }

    @PermissionCallback
    private void blePermsCallback(PluginCall call) {
        if (getPermissionState("ble") != PermissionState.GRANTED) {
            call.reject("Bluetooth permission denied");
            return;
        }
        if ("connect".equals(call.getMethodName())) {
            doConnect(call);
        } else {
            doStartScan(call);
        }
    }

    private void doStartScan(PluginCall call) {
        BluetoothAdapter a = adapter();
        if (a == null || !a.isEnabled()) {
            call.reject("Bluetooth is off");
            return;
        }
        scanner = a.getBluetoothLeScanner();
        if (scanner == null) {
            call.reject("No BLE scanner");
            return;
        }
        stopScanInternal();
        scanCallback = new ScanCallback() {
            @Override
            public void onScanResult(int callbackType, ScanResult result) {
                BluetoothDevice d = result.getDevice();
                JSObject ev = new JSObject();
                ev.put("deviceId", d.getAddress());
                String name = result.getScanRecord() != null ? result.getScanRecord().getDeviceName() : null;
                ev.put("name", name != null ? name : (d.getName() != null ? d.getName() : "(unknown)"));
                ev.put("rssi", result.getRssi());
                // Advertised service UUIDs (if any) → let the add-device UI suggest a
                // protocol instead of the user guessing. Many devices advertise none
                // (services appear only post-connect); that's fine — no hint then.
                java.util.List<UUID> services = new java.util.ArrayList<>();
                if (result.getScanRecord() != null && result.getScanRecord().getServiceUuids() != null) {
                    for (android.os.ParcelUuid pu : result.getScanRecord().getServiceUuids()) {
                        services.add(pu.getUuid());
                    }
                }
                com.getcapacitor.JSArray svcArr = new com.getcapacitor.JSArray();
                for (UUID u : services) svcArr.put(u.toString());
                ev.put("services", svcArr);
                String suggested = org.openfit.app.protocol.ProtocolRegistry.detectFromServices(services);
                if (suggested != null) ev.put("suggestedType", suggested);
                notifyListeners("scanResult", ev);
            }
        };
        try {
            scanner.startScan(scanCallback);
        } catch (SecurityException e) {
            call.reject("scan permission: " + e.getMessage());
            return;
        }
        main.postDelayed(this::stopScanInternal, 10_000);
        call.resolve();
    }

    @PluginMethod
    public void stopScan(PluginCall call) {
        stopScanInternal();
        call.resolve();
    }

    private void stopScanInternal() {
        if (scanner != null && scanCallback != null) {
            try {
                scanner.stopScan(scanCallback);
            } catch (SecurityException ignored) {
            }
        }
        scanCallback = null;
    }

    // -------------------------------------------------------------- connect

    @PluginMethod
    public void connect(PluginCall call) {
        if (getPermissionState("ble") != PermissionState.GRANTED) {
            requestPermissionForAlias("ble", call, "blePermsCallback");
            return;
        }
        doConnect(call);
    }

    private void doConnect(PluginCall call) {
        String id = call.getString("deviceId");
        if (id == null) {
            call.reject("deviceId required");
            return;
        }
        String mode = call.getString("deviceType", "standard");
        String authKey = call.getString("authKey");
        if ("huami".equals(mode) && (authKey == null || authKey.isEmpty())) {
            call.reject("authKey required for huami devices");
            return;
        }
        BluetoothAdapter a = adapter();
        if (a == null) {
            call.reject("No Bluetooth adapter");
            return;
        }
        stopScanInternal();
        // Replace any existing link to the same device; OTHER devices stay connected.
        DeviceLink old = links.remove(id);
        if (old != null) old.teardown();
        BluetoothDevice device;
        try {
            device = a.getRemoteDevice(id);
        } catch (IllegalArgumentException e) {
            call.reject("bad deviceId");
            return;
        }
        DeviceLink link = new DeviceLink(id, mode, authKey);
        links.put(id, link);
        // Garmin uses BLE passkey pairing — explicitly createBond() so Android shows
        // the code-entry dialog (the watch displays the passkey). GATT comes after.
        if ("garmin".equals(mode) && device.getBondState() != BluetoothDevice.BOND_BONDED) {
            registerBondReceiver();
            try {
                if (!device.createBond()) {
                    links.remove(id);
                    call.reject("couldn't start pairing with the watch");
                    return;
                }
            } catch (SecurityException e) {
                links.remove(id);
                call.reject("bond permission: " + e.getMessage());
                return;
            }
            emitStatus(id, "connecting", "pairing — enter the code shown on your watch");
            call.resolve();
            return; // proceedConnect() runs on BOND_BONDED
        }
        link.proceedConnect(device);
        call.resolve();
    }

    private BroadcastReceiver bondReceiver;

    private void registerBondReceiver() {
        if (bondReceiver != null) return;
        bondReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context ctx, Intent intent) {
                BluetoothDevice d = intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
                int state = intent.getIntExtra(BluetoothDevice.EXTRA_BOND_STATE, -1);
                if (d == null) return;
                DeviceLink link = links.get(d.getAddress());
                if (link == null) return;
                if (state == BluetoothDevice.BOND_BONDED) {
                    Log.i(TAG, "bond complete → connecting GATT");
                    // Bonding is done; stop processing further broadcasts (it's only
                    // needed during the one-time pairing handshake).
                    unregisterBondReceiver();
                    emitStatus(d.getAddress(), "connecting", "paired — connecting…");
                    main.post(() -> link.proceedConnect(d));
                } else if (state == BluetoothDevice.BOND_NONE) {
                    emitStatus(d.getAddress(), "error", "pairing failed or was cancelled");
                }
            }
        };
        getContext().registerReceiver(bondReceiver, new IntentFilter(BluetoothDevice.ACTION_BOND_STATE_CHANGED));
    }

    /** Tear down the bond receiver once pairing is done (idempotent: guards against
     *  double-unregister, which throws IllegalArgumentException). */
    private void unregisterBondReceiver() {
        BroadcastReceiver r = bondReceiver;
        if (r == null) return;
        bondReceiver = null;
        try {
            getContext().unregisterReceiver(r);
        } catch (IllegalArgumentException ignored) {
        }
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        String id = call.getString("deviceId");
        try {
            if (id != null) {
                DeviceLink link = links.remove(id);
                if (link != null) link.teardown();
            } else {
                disconnectAll();
            }
        } finally {
            // Always stop the foreground service once the last link is gone, even if
            // teardown()/GATT close threw — otherwise the service leaks (battery + notif).
            if (links.isEmpty()) stopForegroundService();
        }
        call.resolve();
    }

    private void disconnectAll() {
        for (DeviceLink link : links.values()) link.teardown();
        links.clear();
    }

    private void stopForegroundService() {
        try {
            BleForegroundService.stop(getContext());
        } catch (Exception ignored) {
        }
    }

    private void emitStatus(String deviceId, String status, String message) {
        JSObject ev = new JSObject();
        ev.put("deviceId", deviceId);
        ev.put("status", status);
        if (message != null) ev.put("message", message);
        notifyListeners("status", ev);
    }

    private void emitSample(String deviceId, String kind, double value) {
        JSObject ev = new JSObject();
        ev.put("deviceId", deviceId);
        ev.put("kind", kind);
        ev.put("value", value);
        ev.put("ts", System.currentTimeMillis());
        notifyListeners("sample", ev);
        nativeIngest(kind, value); // POST natively so it keeps flowing when locked
        // Feed live device metrics (HR, and where available cadence/power) into an
        // in-progress workout recording via the metrics sink. The recorder ignores
        // kinds it doesn't track, so it's safe to forward all of them.
        if (RecordingService.isRecording()) {
            RecordingService.feedMetric(kind, value, System.currentTimeMillis());
        }
    }

    /** JS hands us the server base + session token so we can POST samples even
     *  when the WebView is suspended (screen locked / app backgrounded). */
    @PluginMethod
    public void configure(PluginCall call) {
        apiBase = call.getString("apiBase");
        authToken = call.getString("token");
        // Share the server URL + token so the workout recorder can upload its .fit
        // (it has no connection of its own).
        prefs().edit().putString("apiBase", apiBase == null ? "" : apiBase)
            .putString("token", authToken == null ? "" : authToken).apply();
        ingestExec.execute(this::flushOutbox); // drain anything buffered while offline
        call.resolve();
    }

    /** Offline-buffer status for the UI: how many samples are queued, the cap, and
     *  the file size. (Read on the ingest thread so the count stays consistent.) */
    @PluginMethod
    public void getOutboxStatus(PluginCall call) {
        ingestExec.execute(() -> {
            ensureOutboxCount();
            java.io.File f = outboxFile();
            JSObject r = new JSObject();
            r.put("count", outboxCount);
            r.put("maxLines", OUTBOX_MAX_LINES);
            r.put("bytes", f.exists() ? f.length() : 0);
            call.resolve(r);
        });
    }

    /** Pull stored wellness from every connected device that supports it (Helio).
     *  Garmin links are live-only here (history is imported from Garmin Connect). */
    @PluginMethod
    public void syncNow(PluginCall call) {
        if (links.isEmpty()) {
            call.reject("no device connected");
            return;
        }
        Double sinceD = call.getDouble("sinceMillis");
        Long since = sinceD != null ? sinceD.longValue() : null;
        for (DeviceLink link : links.values()) {
            if (link.huami != null) link.syncNow(since);
        }
        call.resolve();
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences("ofit_ble", Context.MODE_PRIVATE);
    }

    /** Live HR sample → ingest (throttled). Carries its own ts so it stays correct
     *  even if it has to be buffered offline and flushed later. */
    private void nativeIngest(String kind, double value) {
        long now = System.currentTimeMillis();
        if (now - lastIngest < 900) return;
        lastIngest = now;
        java.util.List<String> one = new java.util.ArrayList<>(1);
        one.add("{\"kind\":\"" + kind + "\",\"value\":" + value
            + ",\"ts\":\"" + RFC3339.format(new java.util.Date(now)) + "\"}");
        sendOrQueue(one);
    }

    // ---- ingest with an offline outbox (all file access on the single ingestExec) ----

    private static final int OUTBOX_MAX_LINES = 300_000; // ~3.5 days of 1 Hz HR
    private static final double OUTBOX_WARN_FRACTION = 0.75; // notify "connect to LAN" here
    private static final String BUFFER_CHANNEL = "ofit_buffer";
    private static final int BUFFER_NOTIF_ID = 4243;
    private int outboxCount = -1; // in-memory line count (lazy-loaded); -1 = unknown

    /** POST the samples; if the server is unreachable, append them to a local outbox
     *  to flush on reconnect, so nothing is lost off-network (e.g. a workout away
     *  from the LAN). A successful POST opportunistically drains the backlog. */
    private void sendOrQueue(java.util.List<String> samples) {
        if (samples.isEmpty()) return;
        ingestExec.execute(() -> {
            if (apiBase == null || apiBase.isEmpty() || !doPostBatch(apiBase, authToken, samples)) {
                appendOutbox(samples);
            } else {
                flushOutbox();
            }
        });
    }

    /** After a sync that wrote new data, run the analytics recompute server-side so
     *  derived metrics (sleep, body battery, resting HR) refresh automatically.
     *  Throttled, queued AFTER the batch flush (same single ingest thread), and
     *  signals the UI to soft-refresh when done. */
    private void maybeRecompute() {
        if (apiBase == null || apiBase.isEmpty()) return;
        long now = System.currentTimeMillis();
        if (now - prefs().getLong("last_recompute", 0L) < RECOMPUTE_MIN_INTERVAL_MS) return;
        prefs().edit().putLong("last_recompute", now).apply();
        final String base = apiBase;
        final String tok = authToken;
        ingestExec.execute(() -> {
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(base + "/api/analytics/recompute").openConnection();
                c.setConnectTimeout(8000);
                c.setReadTimeout(180000); // a full recompute can take a while
                c.setRequestMethod("POST");
                if (tok != null && !tok.isEmpty()) c.setRequestProperty("Authorization", "Bearer " + tok);
                int code = c.getResponseCode();
                Log.i(TAG, "auto-recompute → " + code);
                if (code >= 200 && code < 300) {
                    main.post(() -> emitStatus(null, "ready", "recomputed"));
                }
            } catch (Exception e) {
                Log.w(TAG, "auto-recompute failed: " + e.getMessage());
            } finally {
                if (c != null) c.disconnect();
            }
        });
    }

    /** POST a list of sample-JSONs as one JSON array. Returns true on 2xx. */
    private boolean doPostBatch(String base, String tok, java.util.List<String> samples) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(base + "/api/wellness").openConnection();
            c.setConnectTimeout(5000);
            c.setReadTimeout(5000);
            c.setRequestMethod("POST");
            c.setRequestProperty("Content-Type", "application/json");
            if (tok != null && !tok.isEmpty()) c.setRequestProperty("Authorization", "Bearer " + tok);
            c.setDoOutput(true);
            try (OutputStream os = c.getOutputStream()) {
                os.write(("[" + String.join(",", samples) + "]").getBytes(StandardCharsets.UTF_8));
            }
            int code = c.getResponseCode();
            return code >= 200 && code < 300;
        } catch (Exception e) {
            return false;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private java.io.File outboxFile() {
        return new java.io.File(getContext().getFilesDir(), "ofit_outbox.jsonl");
    }

    private void ensureOutboxCount() {
        if (outboxCount < 0) outboxCount = readOutbox().size();
    }

    private void appendOutbox(java.util.List<String> samples) {
        ensureOutboxCount();
        try (java.io.FileWriter w = new java.io.FileWriter(outboxFile(), true)) {
            for (String s : samples) {
                w.write(s);
                w.write('\n');
            }
        } catch (Exception e) {
            Log.w(TAG, "outbox append failed: " + e.getMessage());
            return;
        }
        outboxCount += samples.size();
        if (outboxCount > OUTBOX_MAX_LINES) { // drop oldest, keep the most recent window
            java.util.List<String> lines = readOutbox();
            java.util.List<String> keep = new java.util.ArrayList<>(
                lines.subList(Math.max(0, lines.size() - OUTBOX_MAX_LINES), lines.size()));
            writeOutbox(keep);
            outboxCount = keep.size();
        }
        // Warn once when crossing the high-water mark so the user can get on the LAN.
        if (outboxCount >= OUTBOX_MAX_LINES * OUTBOX_WARN_FRACTION
            && !prefs().getBoolean("buf_warned", false)) {
            prefs().edit().putBoolean("buf_warned", true).apply();
            postBufferWarning(outboxCount);
        }
    }

    /** Drain buffered samples to the server (oldest first); stop if it's still down. */
    private void flushOutbox() {
        java.io.File f = outboxFile();
        if (apiBase == null || apiBase.isEmpty() || !f.exists() || f.length() == 0) return;
        java.util.List<String> lines = readOutbox();
        int sent = 0;
        while (sent < lines.size()) {
            java.util.List<String> batch = lines.subList(sent, Math.min(sent + 500, lines.size()));
            if (!doPostBatch(apiBase, authToken, batch)) break; // still unreachable; keep the rest
            sent += batch.size();
        }
        if (sent == 0) return;
        if (sent >= lines.size()) {
            f.delete();
            outboxCount = 0;
            Log.i(TAG, "outbox flushed " + sent + " buffered samples");
        } else {
            writeOutbox(new java.util.ArrayList<>(lines.subList(sent, lines.size())));
            outboxCount = lines.size() - sent;
        }
        // Clear the warning (+ its notification) once we're well back under the mark.
        if (outboxCount < OUTBOX_MAX_LINES * 0.5 && prefs().getBoolean("buf_warned", false)) {
            prefs().edit().putBoolean("buf_warned", false).apply();
            NotificationManager nm = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.cancel(BUFFER_NOTIF_ID);
        }
    }

    /** Notify the user that the offline buffer is filling up — connect to the LAN. */
    private void postBufferWarning(int count) {
        try {
            NotificationManager nm = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(BUFFER_CHANNEL) == null) {
                NotificationChannel ch = new NotificationChannel(
                    BUFFER_CHANNEL, "Offline buffer", NotificationManager.IMPORTANCE_DEFAULT);
                ch.setDescription("Warns when offline health data is piling up and needs syncing.");
                nm.createNotificationChannel(ch);
            }
            int pct = (int) (100L * count / OUTBOX_MAX_LINES);
            Notification n = new NotificationCompat.Builder(getContext(), BUFFER_CHANNEL)
                .setContentTitle("OpenFit — offline buffer " + pct + "% full")
                .setContentText(count + " readings are waiting. Connect to your network to back them up.")
                .setSmallIcon(getContext().getApplicationInfo().icon)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setAutoCancel(true)
                .build();
            nm.notify(BUFFER_NOTIF_ID, n);
        } catch (Exception e) {
            Log.w(TAG, "buffer warning failed: " + e.getMessage());
        }
    }

    private java.util.List<String> readOutbox() {
        java.util.List<String> out = new java.util.ArrayList<>();
        try (java.io.BufferedReader r = new java.io.BufferedReader(new java.io.FileReader(outboxFile()))) {
            String line;
            while ((line = r.readLine()) != null) {
                if (!line.isEmpty()) out.add(line);
            }
        } catch (Exception e) {
            Log.w(TAG, "outbox read failed: " + e.getMessage());
        }
        return out;
    }

    private void writeOutbox(java.util.List<String> lines) {
        try (java.io.FileWriter w = new java.io.FileWriter(outboxFile(), false)) {
            for (String s : lines) {
                w.write(s);
                w.write('\n');
            }
        } catch (Exception e) {
            Log.w(TAG, "outbox rewrite failed: " + e.getMessage());
        }
    }

    private static final String TAG = "OpenFitBle";

    private static BluetoothGattCharacteristic findChar(BluetoothGatt g, UUID uuid) {
        for (BluetoothGattService s : g.getServices()) {
            BluetoothGattCharacteristic c = s.getCharacteristic(uuid);
            if (c != null) return c;
        }
        return null;
    }

    /** Heart Rate Measurement (0x2A37): flags byte, then uint8 or uint16 LE HR. */
    private static Integer parseHeartRate(byte[] v) {
        if (v == null || v.length < 2) return null;
        int flags = v[0] & 0xff;
        if ((flags & 0x01) != 0) {
            if (v.length < 3) return null;
            return (v[1] & 0xff) | ((v[2] & 0xff) << 8);
        }
        return v[1] & 0xff;
    }

    // ============================================================= DeviceLink
    // One per added device: its own GATT, serialized op queue, characteristics,
    // and protocol session. Multiple links run concurrently (Helio + Garmin),
    // each streaming live independently. Huami links also do stored-data sync.

    private final class DeviceLink {
        final String deviceId;
        final String mode;
        final String authKey;
        private BluetoothGatt gatt;

        private final ArrayDeque<Runnable> opQueue = new ArrayDeque<>();
        private boolean opInFlight = false;

        private HuamiSession huami;
        private org.openfit.app.garmin.GarminSession garmin;
        private BluetoothGattCharacteristic garminSend;
        private BluetoothGattCharacteristic chunkWriteChar;
        private BluetoothGattCharacteristic chunkReadChar;
        private BluetoothGattCharacteristic hrChar;
        private BluetoothGattCharacteristic activityControlChar;
        private BluetoothGattCharacteristic activityDataChar;

        // Stored-data fetch state (Huami only).
        private boolean fetchInProgress = false;
        private long maxFetchedTs = 0L;
        private final java.util.List<String> fetchBatch = new java.util.ArrayList<>();

        DeviceLink(String deviceId, String mode, String authKey) {
            this.deviceId = deviceId;
            this.mode = mode;
            this.authKey = authKey;
        }

        void proceedConnect(BluetoothDevice device) {
            try {
                gatt = device.connectGatt(getContext(), false, gattCallback, BluetoothDevice.TRANSPORT_LE);
            } catch (SecurityException e) {
                emitStatus(deviceId, "error", "connect permission: " + e.getMessage());
                return;
            }
            // Keep the process alive in the background so the connection + ingest
            // survive a screen lock (needed for workout recording).
            try {
                BleForegroundService.start(getContext(), "Connected — streaming wellness");
            } catch (Exception e) {
                Log.w(TAG, "foreground service start failed: " + e.getMessage());
            }
        }

        void teardown() {
            fetchInProgress = false;
            main.removeCallbacks(periodicSync);
            main.removeCallbacks(fetchWatchdog);
            synchronized (opQueue) {
                opQueue.clear();
                opInFlight = false;
            }
            if (huami != null) {
                huami.stop();
                huami = null;
            }
            garmin = null;
            garminSend = null;
            chunkWriteChar = chunkReadChar = hrChar = null;
            if (gatt != null) {
                try {
                    gatt.disconnect();
                    gatt.close();
                } catch (SecurityException ignored) {
                }
                gatt = null;
            }
        }

        // ----- stored-data sync (Huami only) -----

        void syncNow(Long sinceMillis) {
            if (huami == null || fetchInProgress) return;
            long since = sinceMillis != null ? sinceMillis : computeSince();
            beginSync(since);
        }

        private void beginSync(long since) {
            if (huami == null || fetchInProgress) return;
            fetchInProgress = true;
            maxFetchedTs = 0L;
            synchronized (fetchBatch) {
                fetchBatch.clear();
            }
            main.removeCallbacks(fetchWatchdog);
            main.postDelayed(fetchWatchdog, 180_000);
            huami.startActivityFetch(since);
        }

        private final Runnable fetchWatchdog = new Runnable() {
            @Override
            public void run() {
                if (fetchInProgress) {
                    fetchInProgress = false;
                    flushFetchBatch();
                    emitStatus(deviceId, "ready", "sync timed out");
                    if (huami != null) huami.enableHeartRate();
                }
            }
        };

        private long computeSince() {
            long now = System.currentTimeMillis();
            long floor = now - DEFAULT_WINDOW_MS;
            long wm = prefs().getLong("wm_" + deviceId, 0L);
            return wm <= 0 ? floor : Math.max(floor, wm - SYNC_OVERLAP_MS);
        }

        /** True while this link is still the one registered for its deviceId. A
         *  torn-down/replaced link's pending main-thread runnables (auto/periodic
         *  sync) must no-op so they don't touch a stale/null session. */
        private boolean isCurrentLink() {
            return links.get(deviceId) == this;
        }

        private void maybeAutoSync() {
            long now = System.currentTimeMillis();
            if (now - prefs().getLong("last_autosync_" + deviceId, 0L) < AUTO_SYNC_MIN_INTERVAL_MS) return;
            main.postDelayed(() -> {
                if (!isCurrentLink() || huami == null || fetchInProgress) return;
                prefs().edit().putLong("last_autosync_" + deviceId, System.currentTimeMillis()).apply();
                emitStatus(deviceId, "connected", "auto-syncing stored data…");
                beginSync(computeSince());
            }, 4000);
        }

        private final Runnable periodicSync = new Runnable() {
            @Override
            public void run() {
                // After an unexpected disconnect this can fire on a stale link; bail
                // (and don't reschedule) if we're no longer the current link.
                if (!isCurrentLink()) return;
                if (huami != null && !fetchInProgress) {
                    beginSync(computeSince());
                }
                main.postDelayed(this, PERIODIC_SYNC_MS);
            }
        };

        private void startPeriodicSync() {
            main.removeCallbacks(periodicSync);
            main.postDelayed(periodicSync, PERIODIC_SYNC_MS);
        }

        private void addFetchSample(String kind, double value, long tsMillis) {
            if (tsMillis > maxFetchedTs) maxFetchedTs = tsMillis;
            synchronized (fetchBatch) {
                fetchBatch.add("{\"kind\":\"" + kind + "\",\"value\":" + value
                    + ",\"ts\":\"" + RFC3339.format(new java.util.Date(tsMillis)) + "\"}");
                if (fetchBatch.size() >= 1000) flushFetchBatchLocked();
            }
        }

        private void flushFetchBatch() {
            synchronized (fetchBatch) {
                flushFetchBatchLocked();
            }
        }

        private void flushFetchBatchLocked() {
            if (fetchBatch.isEmpty()) return;
            java.util.List<String> batch = new java.util.ArrayList<>(fetchBatch);
            fetchBatch.clear();
            sendOrQueue(batch);
        }

        // ----- serialized op queue (per GATT) -----

        private void enqueue(Runnable op) {
            synchronized (opQueue) {
                opQueue.add(op);
                if (!opInFlight) runNextOp();
            }
        }

        private void runNextOp() {
            synchronized (opQueue) {
                if (opInFlight) return;
                Runnable op = opQueue.poll();
                if (op == null) return;
                opInFlight = true;
                main.post(op);
            }
        }

        private void opComplete() {
            synchronized (opQueue) {
                opInFlight = false;
            }
            runNextOp();
        }

        @SuppressWarnings("deprecation")
        private void enqueueWrite(BluetoothGattCharacteristic c, byte[] value) {
            enqueue(() -> {
                try {
                    if (gatt == null) {
                        opComplete();
                        return;
                    }
                    int props = c.getProperties();
                    int writeType = (props & BluetoothGattCharacteristic.PROPERTY_WRITE) != 0
                        ? BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                        : BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE;
                    boolean ok;
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        int r = gatt.writeCharacteristic(c, value, writeType);
                        ok = r == BluetoothStatusCodes.SUCCESS;
                        if (!ok) Log.w(TAG, "writeCharacteristic " + c.getUuid() + " failed code=" + r);
                    } else {
                        c.setValue(value);
                        c.setWriteType(writeType);
                        ok = gatt.writeCharacteristic(c);
                        if (!ok) Log.w(TAG, "writeCharacteristic(legacy) " + c.getUuid() + " returned false");
                    }
                    if (!ok) opComplete();
                } catch (SecurityException e) {
                    opComplete();
                }
            });
        }

        @SuppressWarnings("deprecation")
        private void enqueueNotify(BluetoothGattCharacteristic c) {
            enqueue(() -> {
                try {
                    if (gatt == null) {
                        opComplete();
                        return;
                    }
                    gatt.setCharacteristicNotification(c, true);
                    BluetoothGattDescriptor d = c.getDescriptor(CCCD);
                    if (d == null) {
                        Log.w(TAG, "no CCCD on " + c.getUuid());
                        opComplete();
                        return;
                    }
                    byte[] enable = (c.getProperties() & BluetoothGattCharacteristic.PROPERTY_NOTIFY) != 0
                        ? BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                        : BluetoothGattDescriptor.ENABLE_INDICATION_VALUE;
                    boolean ok;
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        int r = gatt.writeDescriptor(d, enable);
                        ok = r == BluetoothStatusCodes.SUCCESS;
                        if (!ok) Log.w(TAG, "writeDescriptor " + c.getUuid() + " failed code=" + r);
                    } else {
                        d.setValue(enable);
                        ok = gatt.writeDescriptor(d);
                        if (!ok) Log.w(TAG, "writeDescriptor(legacy) " + c.getUuid() + " returned false");
                    }
                    if (!ok) opComplete(); // else → onDescriptorWrite → opComplete()
                } catch (SecurityException e) {
                    opComplete();
                }
            });
        }

        // ----- GATT callback (per link) -----

        private final BluetoothGattCallback gattCallback = new BluetoothGattCallback() {
            @Override
            public void onConnectionStateChange(BluetoothGatt g, int status, int newState) {
                if (newState == BluetoothProfile.STATE_CONNECTED) {
                    emitStatus(deviceId, "connected", null);
                    try {
                        g.discoverServices();
                    } catch (SecurityException ignored) {
                    }
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    emitStatus(deviceId, "disconnected", "status=" + status);
                }
            }

            @Override
            public void onServicesDiscovered(BluetoothGatt g, int status) {
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    emitStatus(deviceId, "error", "service discovery failed: " + status);
                    return;
                }
                if ("huami".equals(mode)) {
                    setupHuami(g);
                } else if ("garmin".equals(mode)) {
                    setupGarmin(g);
                } else {
                    setupStandardHr(g);
                }
            }

            @Override
            public void onMtuChanged(BluetoothGatt g, int mtu, int status) {
                if ("huami".equals(mode)) {
                    startHuamiSession(g, mtu);
                } else if ("garmin".equals(mode)) {
                    startGarminSession(g, mtu);
                }
            }

            @Override
            public void onDescriptorWrite(BluetoothGatt g, BluetoothGattDescriptor descriptor, int status) {
                opComplete();
            }

            @Override
            public void onCharacteristicWrite(BluetoothGatt g, BluetoothGattCharacteristic c, int status) {
                opComplete();
            }

            @SuppressWarnings("deprecation")
            @Override
            public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c) {
                byte[] v = c.getValue();
                UUID u = c.getUuid();
                if (CHUNK_READ.equals(u)) {
                    if (huami != null) huami.onChunkedRead(v);
                } else if (ACTIVITY_CONTROL.equals(u)) {
                    if (huami != null) huami.onActivityControl(v);
                } else if (ACTIVITY_DATA.equals(u)) {
                    if (huami != null) huami.onActivityData(v);
                } else if (GARMIN_ML_RECV.equals(u)) {
                    if (garmin != null) garmin.onNotify(v);
                } else if (HR_MEASUREMENT.equals(u)) {
                    if (huami != null) {
                        huami.onHrMeasurement(v);
                    } else {
                        Integer hr = parseHeartRate(v);
                        if (hr != null) emitSample(deviceId, "heart_rate", hr);
                    }
                }
            }
        };

        // ----- standard HR (M0) -----

        private void setupStandardHr(BluetoothGatt g) {
            BluetoothGattService svc = g.getService(HR_SERVICE);
            if (svc == null) {
                // Consistent with the Garmin/Huami setup paths: a missing required
                // service/char is an error, not a "ready" state.
                emitStatus(deviceId, "error", "no standard Heart Rate service");
                return;
            }
            BluetoothGattCharacteristic hr = svc.getCharacteristic(HR_MEASUREMENT);
            if (hr == null) {
                emitStatus(deviceId, "error", "no HR measurement characteristic");
                return;
            }
            enqueueNotify(hr);
            emitStatus(deviceId, "ready", "streaming heart rate");
        }

        // ----- garmin (GFDI live HR) -----

        private void setupGarmin(BluetoothGatt g) {
            if (g.getService(GARMIN_ML_SERVICE) == null) {
                emitStatus(deviceId, "error", "no Garmin GFDI service (bond it + remove from Garmin Connect)");
                return;
            }
            emitStatus(deviceId, "connected", "Garmin found, negotiating MTU…");
            boolean requested = false;
            try {
                requested = g.requestMtu(515);
            } catch (SecurityException ignored) {
            }
            if (!requested) startGarminSession(g, 23);
        }

        private void startGarminSession(BluetoothGatt g, int mtu) {
            if (garmin != null) return; // onMtuChanged can fire once; guard re-entry
            BluetoothGattService svc = g.getService(GARMIN_ML_SERVICE);
            if (svc == null) {
                emitStatus(deviceId, "error", "Garmin service missing");
                return;
            }
            BluetoothGattCharacteristic recv = svc.getCharacteristic(GARMIN_ML_RECV);
            garminSend = svc.getCharacteristic(GARMIN_ML_SEND);
            if (recv == null || garminSend == null) {
                emitStatus(deviceId, "error", "Garmin GFDI characteristics missing");
                return;
            }
            String btName = "OpenFit";
            try {
                if (adapter() != null && adapter().getName() != null) btName = adapter().getName();
            } catch (SecurityException ignored) {
            }
            garmin = new org.openfit.app.garmin.GarminSession(
                btName,
                (chunk) -> enqueueWrite(garminSend, chunk),
                new org.openfit.app.garmin.GarminSession.Listener() {
                    @Override
                    public void onLog(String msg) {
                        main.post(() -> emitStatus(deviceId, "connected", msg));
                    }

                    @Override
                    public void onReady() {
                        main.post(() -> emitStatus(deviceId, "ready", "Garmin connected"));
                    }

                    @Override
                    public void onHeartRate(int bpm) {
                        emitSample(deviceId, "heart_rate", bpm);
                    }
                });
            garmin.setMaxWriteSize(mtu);
            emitStatus(deviceId, "connected", "negotiated MTU " + mtu + ", Garmin handshake…");
            enqueueNotify(recv);
            garmin.start();
        }

        // ----- huami (M1/M2) -----

        private void setupHuami(BluetoothGatt g) {
            chunkWriteChar = findChar(g, CHUNK_WRITE);
            chunkReadChar = findChar(g, CHUNK_READ);
            hrChar = findChar(g, HR_MEASUREMENT);
            activityControlChar = findChar(g, ACTIVITY_CONTROL);
            activityDataChar = findChar(g, ACTIVITY_DATA);
            if (chunkWriteChar == null || chunkReadChar == null) {
                emitStatus(deviceId, "error", "Zepp-OS chunked-transfer characteristics not found");
                return;
            }
            boolean requested = false;
            try {
                requested = g.requestMtu(517);
            } catch (SecurityException ignored) {
            }
            if (!requested) {
                startHuamiSession(g, 23); // fall back to the BLE minimum
            }
        }

        private void startHuamiSession(BluetoothGatt g, int mtu) {
            if (huami != null) return; // onMtuChanged can fire once; guard re-entry
            emitStatus(deviceId, "connected", "negotiated MTU " + mtu + ", authenticating…");
            huami = new HuamiSession(
                authKey,
                mtu,
                (chunk) -> enqueueWrite(chunkWriteChar, chunk),
                (ack) -> enqueueWrite(chunkReadChar, ack),
                new HuamiSession.Listener() {
                    @Override
                    public void onAuthSuccess() {
                        main.post(() -> {
                            emitStatus(deviceId, "ready", "authenticated · streaming heart rate");
                            if (hrChar != null) enqueueNotify(hrChar);
                            if (activityControlChar != null) enqueueNotify(activityControlChar);
                            if (activityDataChar != null) enqueueNotify(activityDataChar);
                            huami.enableHeartRate();
                            maybeAutoSync();      // zero-tap pull on (re)connect / app launch
                            startPeriodicSync();  // …and keep refreshing every 15 min
                        });
                    }

                    @Override
                    public void onAuthFailed(String reason) {
                        main.post(() -> emitStatus(deviceId, "error", "auth failed: " + reason));
                    }

                    @Override
                    public void onHeartRate(int bpm) {
                        emitSample(deviceId, "heart_rate", bpm);
                    }

                    @Override
                    public void onLog(String msg) {
                        emitStatus(deviceId, "connected", msg);
                    }

                    @Override
                    public void onFetchSample(String kind, double value, long tsMillis) {
                        addFetchSample(kind, value, tsMillis);
                    }

                    @Override
                    public void onFetchDone(boolean ok) {
                        fetchInProgress = false;
                        main.removeCallbacks(fetchWatchdog);
                        flushFetchBatch();
                        final boolean gotData = maxFetchedTs > 0;
                        if (ok && gotData) {
                            prefs().edit().putLong("wm_" + deviceId, maxFetchedTs).apply();
                        }
                        if (ok && gotData) maybeRecompute();
                        main.post(() -> {
                            emitStatus(deviceId, "ready", !ok ? "sync failed" : gotData ? "sync complete" : "sync up to date");
                            if (huami != null) huami.enableHeartRate(); // resume live HR
                        });
                    }
                }
            );
            if (activityControlChar != null) {
                huami.setActivityControlWriter((cmd) -> enqueueWrite(activityControlChar, cmd));
            }
            enqueueNotify(chunkReadChar);
            huami.startAuth();
        }
    }

    // ------------------------------------------------------------- liveness

    @PluginMethod
    public void echo(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("value", call.getString("value", ""));
        ret.put("available", adapter() != null);
        call.resolve(ret);
    }

    @Override
    protected void handleOnDestroy() {
        stopScanInternal();
        disconnectAll();
        stopForegroundService();
        unregisterBondReceiver();
        // Stop the ingest worker so its thread (and the Context/HTTP state it
        // captures) doesn't outlive the plugin; drain briefly for an in-flight POST.
        ingestExec.shutdown();
        try {
            if (!ingestExec.awaitTermination(2, TimeUnit.SECONDS)) ingestExec.shutdownNow();
        } catch (InterruptedException e) {
            ingestExec.shutdownNow();
            Thread.currentThread().interrupt();
        }
        super.handleOnDestroy();
    }
}

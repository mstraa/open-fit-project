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
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

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

    private final Handler main = new Handler(Looper.getMainLooper());

    private BluetoothAdapter adapter;
    private BluetoothLeScanner scanner;
    private ScanCallback scanCallback;

    private BluetoothGatt gatt;
    private String connectedId;
    private String mode = "standard";
    private String authKey;

    private HuamiSession huami;
    private BluetoothGattCharacteristic chunkWriteChar;
    private BluetoothGattCharacteristic chunkReadChar;
    private BluetoothGattCharacteristic hrChar;
    private BluetoothGattCharacteristic activityControlChar;
    private BluetoothGattCharacteristic activityDataChar;

    // Batched POST of fetched (historical) samples → /api/wellness.
    private final java.util.List<String> fetchBatch = new java.util.ArrayList<>();
    private static final java.text.SimpleDateFormat RFC3339;
    static {
        RFC3339 = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", java.util.Locale.US);
        RFC3339.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
    }

    private final ArrayDeque<Runnable> opQueue = new ArrayDeque<>();
    private boolean opInFlight = false;

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
    private long maxFetchedTs = 0L;                                      // newest ts seen this sync → next watermark

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
        mode = call.getString("deviceType", "standard");
        authKey = call.getString("authKey");
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
        disconnectInternal();
        BluetoothDevice device;
        try {
            device = a.getRemoteDevice(id);
        } catch (IllegalArgumentException e) {
            call.reject("bad deviceId");
            return;
        }
        connectedId = id;
        try {
            gatt = device.connectGatt(getContext(), false, gattCallback, BluetoothDevice.TRANSPORT_LE);
        } catch (SecurityException e) {
            call.reject("connect permission: " + e.getMessage());
            return;
        }
        // Keep the process alive in the background so the connection + ingest
        // survive a screen lock (needed for workout recording).
        try {
            BleForegroundService.start(getContext(), "Connected — streaming wellness");
        } catch (Exception e) {
            Log.w(TAG, "foreground service start failed: " + e.getMessage());
        }
        call.resolve();
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        disconnectInternal();
        call.resolve();
    }

    private void disconnectInternal() {
        fetchInProgress = false;
        main.removeCallbacks(periodicSync);
        synchronized (opQueue) {
            opQueue.clear();
            opInFlight = false;
        }
        if (huami != null) {
            huami.stop();
            huami = null;
        }
        chunkWriteChar = chunkReadChar = hrChar = null;
        if (gatt != null) {
            try {
                gatt.disconnect();
                gatt.close();
            } catch (SecurityException ignored) {
            }
            gatt = null;
        }
        connectedId = null;
        try {
            BleForegroundService.stop(getContext());
        } catch (Exception ignored) {
        }
    }

    private void emitStatus(String status, String message) {
        JSObject ev = new JSObject();
        ev.put("deviceId", connectedId);
        ev.put("status", status);
        if (message != null) ev.put("message", message);
        notifyListeners("status", ev);
    }

    private void emitSample(String kind, double value) {
        JSObject ev = new JSObject();
        ev.put("deviceId", connectedId);
        ev.put("kind", kind);
        ev.put("value", value);
        ev.put("ts", System.currentTimeMillis());
        notifyListeners("sample", ev);
        nativeIngest(kind, value); // POST natively so it keeps flowing when locked
    }

    /** JS hands us the server base + session token so we can POST samples even
     *  when the WebView is suspended (screen locked / app backgrounded). */
    @PluginMethod
    public void configure(PluginCall call) {
        apiBase = call.getString("apiBase");
        authToken = call.getString("token");
        ingestExec.execute(this::flushOutbox); // drain anything buffered while offline
        call.resolve();
    }

    /** Pull stored wellness since `sinceMillis` (default: 2 days) from the Helio. */
    private boolean fetchInProgress = false;

    @PluginMethod
    public void syncNow(PluginCall call) {
        Log.i(TAG, "syncNow called, huami=" + (huami != null) + " inProgress=" + fetchInProgress);
        if (huami == null) {
            call.reject("not connected to a Zepp-OS device");
            return;
        }
        if (fetchInProgress) {
            call.reject("already syncing");
            return;
        }
        // Explicit sinceMillis forces a window; otherwise pull from the watermark
        // (or the full 40-day window the first time).
        Double sinceD = call.getDouble("sinceMillis");
        long since = sinceD != null ? sinceD.longValue() : computeSince(connectedId);
        beginSync(since);
        call.resolve();
    }

    /** Recover if a fetch stalls (e.g. the link drops mid-sync). Cancelled on done. */
    private final Runnable fetchWatchdog = () -> {
        if (fetchInProgress) {
            fetchInProgress = false;
            flushFetchBatch();
            emitStatus("ready", "sync timed out");
            if (huami != null) huami.enableHeartRate();
        }
    };

    /** Start a stored-data fetch from {@code since} (pauses live HR, resumes on done). */
    private void beginSync(long since) {
        if (huami == null || fetchInProgress) return;
        fetchInProgress = true;
        maxFetchedTs = 0L;
        synchronized (fetchBatch) {
            fetchBatch.clear();
        }
        main.removeCallbacks(fetchWatchdog);
        // A first-time 40-day pull is far larger than an incremental one — be generous.
        main.postDelayed(fetchWatchdog, 180_000);
        huami.startActivityFetch(since);
    }

    /** Lower bound for the next sync: the saved watermark (minus a small overlap),
     *  clamped to the device's ~40-day retention; full window if never synced. */
    private long computeSince(String deviceId) {
        long now = System.currentTimeMillis();
        long floor = now - DEFAULT_WINDOW_MS;
        long wm = deviceId != null ? prefs().getLong("wm_" + deviceId, 0L) : 0L;
        return wm <= 0 ? floor : Math.max(floor, wm - SYNC_OVERLAP_MS);
    }

    /** Auto-sync shortly after a (re)connect, throttled so reconnect storms don't
     *  thrash. With the watermark, a no-new-data sync returns near-instantly. */
    private void maybeAutoSync() {
        long now = System.currentTimeMillis();
        if (now - prefs().getLong("last_autosync", 0L) < AUTO_SYNC_MIN_INTERVAL_MS) return;
        main.postDelayed(() -> {
            if (huami == null || fetchInProgress || connectedId == null) return;
            prefs().edit().putLong("last_autosync", System.currentTimeMillis()).apply();
            emitStatus("connected", "auto-syncing stored data…");
            beginSync(computeSince(connectedId));
        }, 4000);
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences("ofit_ble", Context.MODE_PRIVATE);
    }

    /** Background refresh while connected: pull only new data every PERIODIC_SYNC_MS
     *  so history stays current without any taps (survives screen-lock via the
     *  foreground service). Self-reschedules; cancelled on disconnect. */
    private final Runnable periodicSync = new Runnable() {
        @Override
        public void run() {
            if (huami != null && !fetchInProgress && connectedId != null) {
                beginSync(computeSince(connectedId));
            }
            main.postDelayed(this, PERIODIC_SYNC_MS);
        }
    };

    private void startPeriodicSync() {
        main.removeCallbacks(periodicSync);
        main.postDelayed(periodicSync, PERIODIC_SYNC_MS);
    }

    /** Accumulate a fetched historical sample; flush in batches of 1000. */
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

    private static final int OUTBOX_MAX_LINES = 200_000; // ~2 days of 1 Hz HR

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

    private void appendOutbox(java.util.List<String> samples) {
        try (java.io.FileWriter w = new java.io.FileWriter(outboxFile(), true)) {
            for (String s : samples) {
                w.write(s);
                w.write('\n');
            }
        } catch (Exception e) {
            Log.w(TAG, "outbox append failed: " + e.getMessage());
            return;
        }
        if (outboxFile().length() > 12_000_000) { // cap unbounded offline growth
            java.util.List<String> lines = readOutbox();
            if (lines.size() > OUTBOX_MAX_LINES) {
                writeOutbox(new java.util.ArrayList<>(lines.subList(lines.size() - OUTBOX_MAX_LINES, lines.size())));
            }
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
            Log.i(TAG, "outbox flushed " + sent + " buffered samples");
        } else {
            writeOutbox(new java.util.ArrayList<>(lines.subList(sent, lines.size())));
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

    // --------------------------------------------------- serialized op queue

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

    private static final String TAG = "OpenFitBle";

    @SuppressWarnings("deprecation")
    private void enqueueWrite(BluetoothGattCharacteristic c, byte[] value) {
        enqueue(() -> {
            try {
                if (gatt == null) {
                    opComplete();
                    return;
                }
                // Pick the write type the characteristic actually supports. The
                // Huami chunked-write char typically advertises WRITE_NO_RESPONSE.
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
                Log.i(TAG, "write " + c.getUuid() + " len=" + value.length + " wt=" + writeType + " props=0x" + Integer.toHexString(props) + " ok=" + ok);
                // For write-without-response, onCharacteristicWrite still fires; if
                // it somehow doesn't, the queue would stall — but DEFAULT/NO_RESPONSE
                // both deliver the callback on Android.
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
                // Notify vs indicate, based on the characteristic's properties.
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
                Log.i(TAG, "notify " + c.getUuid() + " ok=" + ok);
                if (!ok) opComplete(); // else → onDescriptorWrite → opComplete()
            } catch (SecurityException e) {
                opComplete();
            }
        });
    }

    private static BluetoothGattCharacteristic findChar(BluetoothGatt g, UUID uuid) {
        for (BluetoothGattService s : g.getServices()) {
            BluetoothGattCharacteristic c = s.getCharacteristic(uuid);
            if (c != null) return c;
        }
        return null;
    }

    // -------------------------------------------------------- gatt callback

    private final BluetoothGattCallback gattCallback = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt g, int status, int newState) {
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                emitStatus("connected", null);
                try {
                    g.discoverServices();
                } catch (SecurityException ignored) {
                }
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                emitStatus("disconnected", "status=" + status);
            }
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt g, int status) {
            if (status != BluetoothGatt.GATT_SUCCESS) {
                emitStatus("error", "service discovery failed: " + status);
                return;
            }
            if ("huami".equals(mode)) {
                setupHuami(g);
            } else {
                setupStandardHr(g);
            }
        }

        @Override
        public void onMtuChanged(BluetoothGatt g, int mtu, int status) {
            if ("huami".equals(mode)) {
                startHuamiSession(g, mtu);
            }
        }

        @Override
        public void onDescriptorWrite(BluetoothGatt g, BluetoothGattDescriptor descriptor, int status) {
            Log.i(TAG, "onDescriptorWrite " + descriptor.getCharacteristic().getUuid() + " status=" + status);
            opComplete();
        }

        @Override
        public void onCharacteristicWrite(BluetoothGatt g, BluetoothGattCharacteristic c, int status) {
            Log.i(TAG, "onCharacteristicWrite " + c.getUuid() + " status=" + status);
            opComplete();
        }

        @SuppressWarnings("deprecation")
        @Override
        public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c) {
            byte[] v = c.getValue();
            UUID u = c.getUuid();
            Log.i(TAG, "notif " + u + " len=" + (v != null ? v.length : -1));
            if (CHUNK_READ.equals(u)) {
                if (huami != null) huami.onChunkedRead(v);
            } else if (ACTIVITY_CONTROL.equals(u)) {
                if (huami != null) huami.onActivityControl(v);
            } else if (ACTIVITY_DATA.equals(u)) {
                if (huami != null) huami.onActivityData(v);
            } else if (HR_MEASUREMENT.equals(u)) {
                if (huami != null) {
                    huami.onHrMeasurement(v);
                } else {
                    Integer hr = parseHeartRate(v);
                    if (hr != null) emitSample("heart_rate", hr);
                }
            }
        }
    };

    // -------------------------------------------------------- standard (M0)

    private void setupStandardHr(BluetoothGatt g) {
        BluetoothGattService svc = g.getService(HR_SERVICE);
        if (svc == null) {
            emitStatus("ready", "no standard Heart Rate service");
            return;
        }
        BluetoothGattCharacteristic hr = svc.getCharacteristic(HR_MEASUREMENT);
        if (hr == null) {
            emitStatus("ready", "no HR measurement characteristic");
            return;
        }
        enqueueNotify(hr);
        emitStatus("ready", "streaming heart rate");
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

    // ------------------------------------------------------------ huami (M1)

    private void setupHuami(BluetoothGatt g) {
        chunkWriteChar = findChar(g, CHUNK_WRITE);
        chunkReadChar = findChar(g, CHUNK_READ);
        hrChar = findChar(g, HR_MEASUREMENT);
        activityControlChar = findChar(g, ACTIVITY_CONTROL);
        activityDataChar = findChar(g, ACTIVITY_DATA);
        if (chunkWriteChar == null || chunkReadChar == null) {
            emitStatus("error", "Zepp-OS chunked-transfer characteristics not found");
            return;
        }
        Log.i(TAG, "huami chars: write props=0x" + Integer.toHexString(chunkWriteChar.getProperties())
            + " read props=0x" + Integer.toHexString(chunkReadChar.getProperties()));
        // Negotiate a large MTU first; the session starts in onMtuChanged.
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
        Log.i(TAG, "startHuamiSession mtu=" + mtu + " write=" + (chunkWriteChar != null)
            + " read=" + (chunkReadChar != null) + " hr=" + (hrChar != null));
        emitStatus("connected", "negotiated MTU " + mtu + ", authenticating…");
        huami = new HuamiSession(
            authKey,
            mtu,
            // writeChunk → chunked-write char
            (chunk) -> enqueueWrite(chunkWriteChar, chunk),
            // writeAck → chunked-read char (Gadgetbridge acks on the READ char)
            (ack) -> enqueueWrite(chunkReadChar, ack),
            new HuamiSession.Listener() {
                @Override
                public void onAuthSuccess() {
                    main.post(() -> {
                        emitStatus("ready", "authenticated · streaming heart rate");
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
                    main.post(() -> emitStatus("error", "auth failed: " + reason));
                }

                @Override
                public void onHeartRate(int bpm) {
                    emitSample("heart_rate", bpm);
                }

                @Override
                public void onLog(String msg) {
                    emitStatus("connected", msg);
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
                    // Advance the watermark so the next sync only pulls newer data.
                    if (ok && gotData && connectedId != null) {
                        prefs().edit().putLong("wm_" + connectedId, maxFetchedTs).apply();
                    }
                    main.post(() -> {
                        // "sync complete" signals the UI to reload (new data landed);
                        // "sync up to date" finishes quietly so auto-sync isn't noisy.
                        emitStatus("ready", !ok ? "sync failed" : gotData ? "sync complete" : "sync up to date");
                        if (huami != null) huami.enableHeartRate(); // resume live HR
                    });
                }
            }
        );
        // Fetch (M2) writes its control commands raw to char 0x0004.
        if (activityControlChar != null) {
            huami.setActivityControlWriter((cmd) -> enqueueWrite(activityControlChar, cmd));
        }
        // Receive the handshake responses, then kick off auth.
        enqueueNotify(chunkReadChar);
        huami.startAuth();
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
        disconnectInternal();
        super.handleOnDestroy();
    }
}

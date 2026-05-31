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
        call.resolve();
    }

    /** Pull stored wellness since `sinceMillis` (default: 2 days) from the Helio. */
    @PluginMethod
    public void syncNow(PluginCall call) {
        if (huami == null) {
            call.reject("not connected to a Zepp-OS device");
            return;
        }
        long since = call.getLong("sinceMillis") != null
            ? call.getLong("sinceMillis")
            : System.currentTimeMillis() - 2L * 24 * 3600 * 1000;
        synchronized (fetchBatch) {
            fetchBatch.clear();
        }
        huami.startActivityFetch(since);
        call.resolve();
    }

    /** Accumulate a fetched historical sample; flush in batches of 1000. */
    private void addFetchSample(String kind, double value, long tsMillis) {
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
        if (fetchBatch.isEmpty() || apiBase == null) {
            fetchBatch.clear();
            return;
        }
        final String body = "[" + String.join(",", fetchBatch) + "]";
        fetchBatch.clear();
        final String base = apiBase;
        final String tok = authToken;
        ingestExec.execute(() -> postJson(base, tok, body));
    }

    private void postJson(String base, String tok, String body) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(base + "/api/wellness").openConnection();
            c.setConnectTimeout(8000);
            c.setReadTimeout(8000);
            c.setRequestMethod("POST");
            c.setRequestProperty("Content-Type", "application/json");
            if (tok != null && !tok.isEmpty()) c.setRequestProperty("Authorization", "Bearer " + tok);
            c.setDoOutput(true);
            try (OutputStream os = c.getOutputStream()) {
                os.write(body.getBytes(StandardCharsets.UTF_8));
            }
            Log.i(TAG, "fetch batch POST → " + c.getResponseCode());
        } catch (Exception e) {
            Log.w(TAG, "fetch batch POST failed: " + e.getMessage());
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** POST one sample to {apiBase}/api/wellness, throttled, off the BLE thread. */
    private void nativeIngest(String kind, double value) {
        final String base = apiBase;
        if (base == null || base.isEmpty()) return;
        long now = System.currentTimeMillis();
        if (now - lastIngest < 900) return;
        lastIngest = now;
        final String tok = authToken;
        ingestExec.execute(() -> {
            HttpURLConnection c = null;
            try {
                URL url = new URL(base + "/api/wellness");
                c = (HttpURLConnection) url.openConnection();
                c.setConnectTimeout(4000);
                c.setReadTimeout(4000);
                c.setRequestMethod("POST");
                c.setRequestProperty("Content-Type", "application/json");
                if (tok != null && !tok.isEmpty()) c.setRequestProperty("Authorization", "Bearer " + tok);
                c.setDoOutput(true);
                String body = "[{\"kind\":\"" + kind + "\",\"value\":" + value + "}]";
                try (OutputStream os = c.getOutputStream()) {
                    os.write(body.getBytes(StandardCharsets.UTF_8));
                }
                c.getResponseCode();
            } catch (Exception e) {
                Log.w(TAG, "native ingest failed: " + e.getMessage());
            } finally {
                if (c != null) c.disconnect();
            }
        });
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
                        if (activityDataChar != null) enqueueNotify(activityDataChar);
                        huami.enableHeartRate();
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
                    flushFetchBatch();
                    main.post(() -> emitStatus("ready", ok ? "sync complete" : "sync failed"));
                }
            }
        );
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

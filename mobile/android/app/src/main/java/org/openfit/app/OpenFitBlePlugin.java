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

    // Client Characteristic Config Descriptor — enables notify/indicate on a char.
    // (Per-protocol service/characteristic UUIDs now live in their protocol classes.)
    private static final UUID CCCD = uuid16("2902");

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

    // Throttle the auto-recompute kicked after a sync wrote new data. (Per-device
    // sync-window tuning now lives in HuamiProtocol.)
    private static final long RECOMPUTE_MIN_INTERVAL_MS = 20L * 60 * 1000;

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

    /** This phone's Bluetooth adapter name (fallback "OpenFit") — Garmin handshake identity. */
    private String adapterName() {
        try {
            if (adapter() != null && adapter().getName() != null) return adapter().getName();
        } catch (SecurityException ignored) {
        }
        return "OpenFit";
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
            link.requestSync(since);
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

    // ============================================================= DeviceLink
    // One per added device: its own GATT, serialized op queue, characteristics,
    // and protocol session. Multiple links run concurrently (Helio + Garmin),
    // each streaming live independently. Huami links also do stored-data sync.

    private final class DeviceLink implements org.openfit.app.protocol.LinkContext {
        final String deviceId;
        final String mode;
        final String authKey;
        private BluetoothGatt gatt;

        private final ArrayDeque<Runnable> opQueue = new ArrayDeque<>();
        private boolean opInFlight = false;

        /** The device-specific protocol (standard HR / Huami / Garmin). Owns its
         *  session, characteristics, and (for Huami) the stored-data sync. */
        private final org.openfit.app.protocol.DeviceProtocol protocol;

        DeviceLink(String deviceId, String mode, String authKey) {
            this.deviceId = deviceId;
            this.mode = mode;
            this.authKey = authKey;
            this.protocol = org.openfit.app.protocol.ProtocolRegistry.create(mode, authKey, this);
        }

        void proceedConnect(BluetoothDevice device) {
            try {
                gatt = device.connectGatt(getContext(), false, gattCallback, BluetoothDevice.TRANSPORT_LE);
            } catch (SecurityException e) {
                OpenFitBlePlugin.this.emitStatus(deviceId, "error", "connect permission: " + e.getMessage());
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
            if (protocol != null) protocol.teardown();
            synchronized (opQueue) {
                opQueue.clear();
                opInFlight = false;
            }
            if (gatt != null) {
                try {
                    gatt.disconnect();
                    gatt.close();
                } catch (SecurityException ignored) {
                }
                gatt = null;
            }
        }

        /** Pull stored history (delegated to the protocol; no-op for live-only). */
        void requestSync(Long sinceMillis) {
            protocol.requestSync(sinceMillis);
        }

        // ----- LinkContext: the capabilities exposed to the protocol -----

        @Override public String deviceId() { return deviceId; }

        /** True while this link is still the registered one for its device id, so a
         *  torn-down/replaced link's pending runnables (auto/periodic sync) no-op. */
        @Override public boolean isCurrentLink() { return links.get(deviceId) == this; }

        @Override public boolean requestMtu(int mtu) {
            try {
                return gatt != null && gatt.requestMtu(mtu);
            } catch (SecurityException e) {
                return false;
            }
        }

        @Override public void emitStatus(String status, String message) {
            OpenFitBlePlugin.this.emitStatus(deviceId, status, message);
        }

        @Override public void emitSample(String kind, double value) {
            OpenFitBlePlugin.this.emitSample(deviceId, kind, value);
        }

        @Override public void sendOrQueue(java.util.List<String> samples) {
            OpenFitBlePlugin.this.sendOrQueue(samples);
        }

        @Override public void scheduleRecompute() {
            OpenFitBlePlugin.this.maybeRecompute();
        }

        @Override public android.os.Handler main() { return main; }

        @Override public android.content.SharedPreferences prefs() {
            return OpenFitBlePlugin.this.prefs();
        }

        @Override public String btName() { return adapterName(); }

        @Override public String formatTs(long epochMs) {
            return RFC3339.format(new java.util.Date(epochMs));
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

        @Override
        @SuppressWarnings("deprecation")
        public void enqueueWrite(BluetoothGattCharacteristic c, byte[] value) {
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

        @Override
        @SuppressWarnings("deprecation")
        public void enqueueNotify(BluetoothGattCharacteristic c) {
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
                    OpenFitBlePlugin.this.emitStatus(deviceId, "connected", null);
                    try {
                        g.discoverServices();
                    } catch (SecurityException ignored) {
                    }
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    OpenFitBlePlugin.this.emitStatus(deviceId, "disconnected", "status=" + status);
                }
            }

            @Override
            public void onServicesDiscovered(BluetoothGatt g, int status) {
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    OpenFitBlePlugin.this.emitStatus(deviceId, "error", "service discovery failed: " + status);
                    return;
                }
                protocol.onServicesDiscovered(g);
            }

            @Override
            public void onMtuChanged(BluetoothGatt g, int mtu, int status) {
                protocol.onMtuNegotiated(g, mtu);
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
                protocol.onCharacteristicChanged(c.getUuid(), c.getValue());
            }
        };

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

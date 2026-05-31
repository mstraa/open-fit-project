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
import android.content.Context;
import android.os.Handler;
import android.os.Looper;

import androidx.annotation.NonNull;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayDeque;
import java.util.UUID;

/**
 * OpenFit native BLE plugin — M0 of the direct-device port (see docs/NATIVE-BLE-PORT.md).
 *
 * This is the device-AGNOSTIC backbone every future device protocol plugs into:
 *  - a native {@link BluetoothGatt} connection (full control of MTU/notify/bonding,
 *    unlike the Web-Bluetooth bridge),
 *  - a SERIALIZED GATT operation queue (Android runs one GATT op at a time; each op
 *    waits for its callback before the next is issued),
 *  - JS↔native event streaming via {@code notifyListeners}.
 *
 * M0 proves the round-trip by reading the STANDARD Heart Rate service (0x180D / 0x2A37)
 * over this native path. The Huami (Helio) and Garmin protocols (M1+) reuse the same
 * queue/connection and add their auth + message parsers.
 */
@CapacitorPlugin(
    name = "OpenFitBle",
    permissions = {
        @Permission(
            alias = "ble",
            strings = {
                Manifest.permission.BLUETOOTH_SCAN,
                Manifest.permission.BLUETOOTH_CONNECT
            }
        )
    }
)
public class OpenFitBlePlugin extends Plugin {

    private static final UUID HR_SERVICE = uuid16("180d");
    private static final UUID HR_MEASUREMENT = uuid16("2a37");
    private static final UUID CCCD = uuid16("2902");

    private final Handler main = new Handler(Looper.getMainLooper());

    private BluetoothAdapter adapter;
    private BluetoothLeScanner scanner;
    private ScanCallback scanCallback;

    private BluetoothGatt gatt;
    private String connectedId;

    // Serialized GATT operation queue. Each op runs, then waits for the matching
    // gatt callback (which calls opComplete()) before the next op is dequeued.
    private final ArrayDeque<Runnable> opQueue = new ArrayDeque<>();
    private boolean opInFlight = false;

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
        // Resume whichever method asked (scan or connect) based on its name.
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
        // Auto-stop after 10s (BLE scans should be time-boxed).
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
        if (gatt != null) {
            try {
                gatt.disconnect();
                gatt.close();
            } catch (SecurityException ignored) {
            }
            gatt = null;
        }
        connectedId = null;
    }

    private void emitStatus(String status, String message) {
        JSObject ev = new JSObject();
        ev.put("deviceId", connectedId);
        ev.put("status", status);
        if (message != null) ev.put("message", message);
        notifyListeners("status", ev);
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
            // Run on main thread; the gatt callback will call opComplete().
            main.post(op);
        }
    }

    private void opComplete() {
        synchronized (opQueue) {
            opInFlight = false;
        }
        runNextOp();
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
            // M0: subscribe to the standard Heart Rate measurement, if present.
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
            enqueueEnableNotify(g, hr);
            emitStatus("ready", "streaming heart rate");
        }

        @Override
        public void onDescriptorWrite(BluetoothGatt g, BluetoothGattDescriptor descriptor, int status) {
            opComplete();
        }

        @SuppressWarnings("deprecation")
        @Override
        public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c) {
            if (HR_MEASUREMENT.equals(c.getUuid())) {
                byte[] v = c.getValue();
                Integer hr = parseHeartRate(v);
                if (hr != null) emitSample("heart_rate", hr);
            }
        }
    };

    private void enqueueEnableNotify(BluetoothGatt g, BluetoothGattCharacteristic c) {
        enqueue(() -> {
            try {
                g.setCharacteristicNotification(c, true);
                BluetoothGattDescriptor d = c.getDescriptor(CCCD);
                if (d == null) {
                    opComplete();
                    return;
                }
                d.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                g.writeDescriptor(d); // → onDescriptorWrite → opComplete()
            } catch (SecurityException e) {
                opComplete();
            }
        });
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

    private void emitSample(String kind, double value) {
        JSObject ev = new JSObject();
        ev.put("deviceId", connectedId);
        ev.put("kind", kind);
        ev.put("value", value);
        ev.put("ts", System.currentTimeMillis());
        notifyListeners("sample", ev);
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

    @SuppressWarnings("unused")
    private void noop(@NonNull BluetoothGatt g) {
    }
}

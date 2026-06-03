package org.openfit.app.protocol;

import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCharacteristic;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import org.openfit.app.huami.HuamiSession;

/**
 * Zepp-OS / Huami: encrypted auth handshake, realtime HR, and the stored-data
 * sync orchestration (auto-sync on connect, 15-min periodic refresh, watermarks,
 * batched ingest, watchdog). Mirrors the previous {@code setupHuami} +
 * {@code startHuamiSession} and the sync machinery that used to live in DeviceLink.
 * The {@link HuamiSession} crypto/transport is unchanged — this only drives it and
 * the fetch lifecycle over the {@link LinkContext}.
 */
public final class HuamiProtocol implements DeviceProtocol {
    // Zepp-OS chunked-transfer + activity-fetch characteristics.
    private static final UUID CHUNK_WRITE = UUID.fromString("00000016-0000-3512-2118-0009af100700");
    private static final UUID CHUNK_READ = UUID.fromString("00000017-0000-3512-2118-0009af100700");
    private static final UUID ACTIVITY_CONTROL = UUID.fromString("00000004-0000-3512-2118-0009af100700");
    private static final UUID ACTIVITY_DATA = UUID.fromString("00000005-0000-3512-2118-0009af100700");

    // Stored-data sync tuning (Huami-specific).
    private static final long DEFAULT_WINDOW_MS = 40L * 24 * 3600 * 1000; // device keeps ~40 days
    private static final long SYNC_OVERLAP_MS = 10L * 60 * 1000;          // re-pull last 10 min (idempotent)
    private static final long AUTO_SYNC_MIN_INTERVAL_MS = 10L * 60 * 1000; // throttle auto-sync on (re)connect
    private static final long PERIODIC_SYNC_MS = 15L * 60 * 1000;         // background refresh while connected

    private final LinkContext ctx;
    private final String authKey;

    private HuamiSession huami;
    private BluetoothGattCharacteristic chunkWriteChar;
    private BluetoothGattCharacteristic chunkReadChar;
    private BluetoothGattCharacteristic hrChar;
    private BluetoothGattCharacteristic activityControlChar;
    private BluetoothGattCharacteristic activityDataChar;

    // Stored-data fetch state.
    private boolean fetchInProgress = false;
    private long maxFetchedTs = 0L;
    private final List<String> fetchBatch = new ArrayList<>();

    public HuamiProtocol(String authKey, LinkContext ctx) {
        this.authKey = authKey;
        this.ctx = ctx;
    }

    @Override
    public void onServicesDiscovered(BluetoothGatt g) {
        chunkWriteChar = BleGatt.findChar(g, CHUNK_WRITE);
        chunkReadChar = BleGatt.findChar(g, CHUNK_READ);
        hrChar = BleGatt.findChar(g, BleGatt.HR_MEASUREMENT);
        activityControlChar = BleGatt.findChar(g, ACTIVITY_CONTROL);
        activityDataChar = BleGatt.findChar(g, ACTIVITY_DATA);
        if (chunkWriteChar == null || chunkReadChar == null) {
            ctx.emitStatus("error", "Zepp-OS chunked-transfer characteristics not found");
            return;
        }
        if (!ctx.requestMtu(517)) onMtuNegotiated(g, 23); // fall back to the BLE minimum
    }

    @Override
    public void onMtuNegotiated(BluetoothGatt g, int mtu) {
        if (huami != null) return; // onMtuChanged can fire once; guard re-entry
        ctx.emitStatus("connected", "negotiated MTU " + mtu + ", authenticating…");
        huami = new HuamiSession(
            authKey,
            mtu,
            (chunk) -> ctx.enqueueWrite(chunkWriteChar, chunk),
            (ack) -> ctx.enqueueWrite(chunkReadChar, ack),
            new HuamiSession.Listener() {
                @Override
                public void onAuthSuccess() {
                    ctx.main().post(() -> {
                        ctx.emitStatus("ready", "authenticated · streaming heart rate");
                        if (hrChar != null) ctx.enqueueNotify(hrChar);
                        if (activityControlChar != null) ctx.enqueueNotify(activityControlChar);
                        if (activityDataChar != null) ctx.enqueueNotify(activityDataChar);
                        huami.enableHeartRate();
                        maybeAutoSync();      // zero-tap pull on (re)connect / app launch
                        startPeriodicSync();  // …and keep refreshing every 15 min
                    });
                }

                @Override
                public void onAuthFailed(String reason) {
                    ctx.main().post(() -> ctx.emitStatus("error", "auth failed: " + reason));
                }

                @Override
                public void onHeartRate(int bpm) {
                    ctx.emitSample("heart_rate", bpm);
                }

                @Override
                public void onLog(String msg) {
                    ctx.emitStatus("connected", msg);
                }

                @Override
                public void onFetchSample(String kind, double value, long tsMillis) {
                    addFetchSample(kind, value, tsMillis);
                }

                @Override
                public void onFetchDone(boolean ok) {
                    fetchInProgress = false;
                    ctx.main().removeCallbacks(fetchWatchdog);
                    flushFetchBatch();
                    final boolean gotData = maxFetchedTs > 0;
                    if (ok && gotData) {
                        ctx.prefs().edit().putLong("wm_" + ctx.deviceId(), maxFetchedTs).apply();
                    }
                    if (ok && gotData) ctx.scheduleRecompute();
                    ctx.main().post(() -> {
                        ctx.emitStatus("ready", !ok ? "sync failed" : gotData ? "sync complete" : "sync up to date");
                        if (huami != null) huami.enableHeartRate(); // resume live HR
                    });
                }
            }
        );
        if (activityControlChar != null) {
            huami.setActivityControlWriter((cmd) -> ctx.enqueueWrite(activityControlChar, cmd));
        }
        ctx.enqueueNotify(chunkReadChar);
        huami.startAuth();
    }

    @Override
    public void onCharacteristicChanged(UUID uuid, byte[] value) {
        if (CHUNK_READ.equals(uuid)) {
            if (huami != null) huami.onChunkedRead(value);
        } else if (ACTIVITY_CONTROL.equals(uuid)) {
            if (huami != null) huami.onActivityControl(value);
        } else if (ACTIVITY_DATA.equals(uuid)) {
            if (huami != null) huami.onActivityData(value);
        } else if (BleGatt.HR_MEASUREMENT.equals(uuid)) {
            if (huami != null) huami.onHrMeasurement(value);
        }
    }

    @Override
    public void requestSync(Long sinceMillis) {
        if (huami == null || fetchInProgress) return;
        long since = sinceMillis != null ? sinceMillis : computeSince();
        beginSync(since);
    }

    @Override
    public void teardown() {
        if (huami != null) {
            huami.stop();
            huami = null;
        }
        ctx.main().removeCallbacks(periodicSync);
        ctx.main().removeCallbacks(fetchWatchdog);
        fetchInProgress = false;
    }

    // ----- stored-data sync -----

    private void beginSync(long since) {
        if (huami == null || fetchInProgress) return;
        fetchInProgress = true;
        maxFetchedTs = 0L;
        synchronized (fetchBatch) {
            fetchBatch.clear();
        }
        ctx.main().removeCallbacks(fetchWatchdog);
        ctx.main().postDelayed(fetchWatchdog, 180_000);
        huami.startActivityFetch(since);
    }

    private final Runnable fetchWatchdog = new Runnable() {
        @Override
        public void run() {
            if (fetchInProgress) {
                fetchInProgress = false;
                flushFetchBatch();
                ctx.emitStatus("ready", "sync timed out");
                if (huami != null) huami.enableHeartRate();
            }
        }
    };

    private long computeSince() {
        long now = System.currentTimeMillis();
        long floor = now - DEFAULT_WINDOW_MS;
        long wm = ctx.prefs().getLong("wm_" + ctx.deviceId(), 0L);
        return wm <= 0 ? floor : Math.max(floor, wm - SYNC_OVERLAP_MS);
    }

    private void maybeAutoSync() {
        long now = System.currentTimeMillis();
        if (now - ctx.prefs().getLong("last_autosync_" + ctx.deviceId(), 0L) < AUTO_SYNC_MIN_INTERVAL_MS) return;
        ctx.main().postDelayed(() -> {
            if (!ctx.isCurrentLink() || huami == null || fetchInProgress) return;
            ctx.prefs().edit().putLong("last_autosync_" + ctx.deviceId(), System.currentTimeMillis()).apply();
            ctx.emitStatus("connected", "auto-syncing stored data…");
            beginSync(computeSince());
        }, 4000);
    }

    private final Runnable periodicSync = new Runnable() {
        @Override
        public void run() {
            // After an unexpected disconnect this can fire on a stale link; bail
            // (and don't reschedule) if we're no longer the current link.
            if (!ctx.isCurrentLink()) return;
            if (huami != null && !fetchInProgress) {
                beginSync(computeSince());
            }
            ctx.main().postDelayed(this, PERIODIC_SYNC_MS);
        }
    };

    private void startPeriodicSync() {
        ctx.main().removeCallbacks(periodicSync);
        ctx.main().postDelayed(periodicSync, PERIODIC_SYNC_MS);
    }

    private void addFetchSample(String kind, double value, long tsMillis) {
        if (tsMillis > maxFetchedTs) maxFetchedTs = tsMillis;
        synchronized (fetchBatch) {
            fetchBatch.add("{\"kind\":\"" + kind + "\",\"value\":" + value
                + ",\"ts\":\"" + ctx.formatTs(tsMillis) + "\"}");
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
        List<String> batch = new ArrayList<>(fetchBatch);
        fetchBatch.clear();
        ctx.sendOrQueue(batch);
    }
}

package org.openfit.app.huami;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import java.util.Objects;
import java.util.Random;
import java.util.function.Consumer;

/**
 * Drives the Zepp-OS / Huami session over the chunked encrypted transport:
 * the ECDH-B163 + AES auth handshake (logic ported from Gadgetbridge's
 * ZeppOsAuthenticationService, AGPLv3) and realtime heart-rate enable/keepalive
 * (ZeppOsHeartRateService). It is transport-agnostic: it writes chunks via the
 * supplied callbacks (the plugin wires those to GATT chars 0x0016 / 0x0017) and
 * is fed inbound notifications via onChunkedRead / onHrMeasurement.
 */
public class HuamiSession implements Huami2021Handler {
    private static final String TAG = "HuamiSession";

    // Endpoints / commands
    private static final short EP_AUTH = 0x0082;
    private static final short EP_HEART_RATE = 0x001d;
    private static final short EP_FETCH = 0x004b; // ZeppOsActivityFetchService (encrypted)
    private static final byte RESPONSE = 0x10;
    private static final byte SUCCESS = 0x01;
    private static final byte CMD_PUB_KEY = 0x04;
    private static final byte CMD_SESSION_KEY = 0x05;
    private static final byte CMD_REALTIME_SET = 0x04;
    private static final byte MODE_START = 0x01;
    private static final byte MODE_CONTINUE = 0x02;

    public interface Listener {
        void onAuthSuccess();
        void onAuthFailed(String reason);
        void onHeartRate(int bpm);
        void onLog(String msg);
        /** A stored-wellness sample pulled by the fetch (M2). */
        void onFetchSample(String kind, double value, long tsMillis);
        /** Stored-wellness fetch finished. */
        void onFetchDone(boolean ok);
    }

    private final byte[] privateEC = new byte[24];
    private final byte[] publicEC = new byte[48];
    private final byte[] finalSharedSessionAES = new byte[16];
    private final byte[] secretKey; // 16-byte auth key

    private final Huami2021ChunkedEncoder encoder;
    private final Huami2021ChunkedDecoder decoder;
    private final Consumer<byte[]> writeChunk; // → GATT char 0x0016
    private final Consumer<byte[]> writeAck;    // → GATT char 0x0017
    private final Listener listener;
    private Consumer<byte[]> writeActivityControl; // → raw GATT char 0x0004 (set by plugin)

    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean realtimeStarted = false;
    private final HuamiFetch fetch;

    public HuamiSession(String authKeyHex, int mtu, Consumer<byte[]> writeChunk,
                        Consumer<byte[]> writeAck, Listener listener) {
        this.secretKey = HuamiCrypto.hexToBytes(authKeyHex);
        this.encoder = new Huami2021ChunkedEncoder(mtu);
        this.decoder = new Huami2021ChunkedDecoder(this, true);
        this.writeChunk = writeChunk;
        this.writeAck = writeAck;
        this.listener = listener;
        // Stored-wellness fetch: control is written RAW to char 0x0004 (the
        // legacy Huami activity-control char), responses come on char 0x0004 and
        // data records on char 0x0005. The plugin supplies the raw-write callback
        // via setActivityControlWriter(); until then writes are dropped.
        this.fetch = new HuamiFetch(
            (cmd) -> {
                if (writeActivityControl != null) writeActivityControl.accept(cmd);
            },
            new HuamiFetch.Sink() {
                @Override
                public void sample(String kind, double value, long ts) {
                    listener.onFetchSample(kind, value, ts);
                }

                @Override
                public void done(boolean ok) {
                    listener.onFetchDone(ok);
                }

                @Override
                public void log(String msg) {
                    listener.onLog(msg);
                }
            });
    }

    /** Start pulling stored ACTIVITY (steps + HR/minute) since {@code sinceMillis}. */
    public void startActivityFetch(long sinceMillis) {
        fetch.startActivity(sinceMillis);
    }

    /** Plugin supplies the raw-write callback for the activity-control char 0x0004. */
    public void setActivityControlWriter(Consumer<byte[]> writer) {
        this.writeActivityControl = writer;
    }

    /** Feed a raw activity-control notification (char 0x0004) to the fetch engine. */
    public void onActivityControl(byte[] value) {
        fetch.onControl(value);
    }

    /** Feed a raw activity-data notification (char 0x0005) to the fetch engine. */
    public void onActivityData(byte[] value) {
        fetch.onData(value);
    }

    public void setMtu(int mtu) {
        encoder.setMTU(mtu);
    }

    private void write(short endpoint, byte[] data, boolean encrypt) {
        encoder.write(writeChunk, endpoint, data, true, encrypt);
    }

    /** Step 1: send our public key (unencrypted) to start the handshake. */
    public void startAuth() {
        new Random().nextBytes(privateEC);
        final byte[] pub = ECDH_B163.ecdh_generate_public(privateEC);
        if (pub == null) {
            listener.onAuthFailed("ECDH public key generation failed");
            return;
        }
        System.arraycopy(pub, 0, publicEC, 0, 48);

        final byte[] cmd = new byte[48 + 4];
        cmd[0] = 0x04;
        cmd[1] = 0x02;
        cmd[2] = 0x00;
        cmd[3] = 0x02;
        System.arraycopy(publicEC, 0, cmd, 4, 48);
        listener.onLog("auth: sent public key");
        write(EP_AUTH, cmd, false);
    }

    /** Feed an inbound chunked-transfer notification (GATT char 0x0017). */
    public void onChunkedRead(byte[] value) {
        boolean needsAck = decoder.decode(value);
        if (needsAck) {
            byte handle = decoder.getLastHandle();
            byte count = decoder.getLastCount();
            writeAck.accept(new byte[]{0x04, 0x00, handle, 0x01, count});
        }
    }

    /** Feed a standard Heart Rate Measurement notification (GATT char 0x2A37). */
    public void onHrMeasurement(byte[] value) {
        if (value != null && value.length == 2 && value[0] == 0) {
            listener.onHeartRate(value[1] & 0xff);
        }
    }

    @Override
    public void handle2021Payload(short type, byte[] payload) {
        if (type == EP_AUTH) {
            handleAuth(payload);
        } else if (type == EP_FETCH) {
            fetch.onControl(payload);
        } else if (type == EP_HEART_RATE) {
            // CMD_REALTIME_ACK etc. — informational
            Log.d(TAG, "hr endpoint ack");
        }
    }

    private void handleAuth(byte[] payload) {
        if (payload[0] != RESPONSE) {
            Log.w(TAG, "non-response auth byte " + String.format("0x%02x", payload[0]));
            return;
        }
        switch (payload[1]) {
            case CMD_PUB_KEY: {
                if (payload[2] != SUCCESS) {
                    listener.onAuthFailed("pub-key rejected: " + String.format("0x%02x", payload[2]));
                    return;
                }
                final byte[] remoteRandom = new byte[16];
                final byte[] remotePublicEC = new byte[48];
                System.arraycopy(payload, 3, remoteRandom, 0, 16);
                System.arraycopy(payload, 19, remotePublicEC, 0, 48);
                final byte[] sharedEC = Objects.requireNonNull(ECDH_B163.ecdh_generate_shared(privateEC, remotePublicEC));
                final int encryptedSequenceNumber = HuamiCrypto.toUint32(sharedEC, 0);
                for (int i = 0; i < 16; i++) {
                    finalSharedSessionAES[i] = (byte) (sharedEC[i + 8] ^ secretKey[i]);
                }
                encoder.setEncryptionParameters(encryptedSequenceNumber, finalSharedSessionAES);
                decoder.setEncryptionParameters(finalSharedSessionAES);
                listener.onLog("auth: derived session key");
                try {
                    final byte[] enc1 = HuamiCrypto.encryptAES(remoteRandom, secretKey);
                    final byte[] enc2 = HuamiCrypto.encryptAES(remoteRandom, finalSharedSessionAES);
                    if (enc1.length == 16 && enc2.length == 16) {
                        byte[] cmd = new byte[33];
                        cmd[0] = 0x05;
                        System.arraycopy(enc1, 0, cmd, 1, 16);
                        System.arraycopy(enc2, 0, cmd, 17, 16);
                        // The auth endpoint is TRANSPORT-unencrypted (Gadgetbridge's
                        // ZeppOsAuthenticationService is super(support, false)); the
                        // AES here is purely the app-level random proof.
                        write(EP_AUTH, cmd, false);
                    }
                } catch (Exception e) {
                    listener.onAuthFailed("AES encryption failed: " + e.getMessage());
                }
                return;
            }
            case CMD_SESSION_KEY: {
                if (payload[2] == 0x25) {
                    listener.onAuthFailed("wrong auth key");
                } else if (payload[2] != SUCCESS) {
                    listener.onAuthFailed("session-key failure: " + String.format("0x%02x", payload[2]));
                } else {
                    listener.onLog("auth: success");
                    listener.onAuthSuccess();
                }
                return;
            }
        }
        Log.w(TAG, "unknown auth byte " + String.format("0x%02x", payload[1]));
    }

    /** Enable realtime HR (after the standard 0x2A37 notify is on) + keepalive.
     *  ZeppOsHeartRateService is also super(support, false) → transport-plaintext. */
    public void enableHeartRate() {
        if (realtimeStarted) return;
        realtimeStarted = true;
        write(EP_HEART_RATE, new byte[]{CMD_REALTIME_SET, MODE_START}, false);
        scheduleContinue();
    }

    private void scheduleContinue() {
        handler.removeCallbacksAndMessages(null);
        handler.postDelayed(() -> {
            if (!realtimeStarted) return;
            write(EP_HEART_RATE, new byte[]{CMD_REALTIME_SET, MODE_CONTINUE}, false);
            scheduleContinue();
        }, 1000L);
    }

    public void stop() {
        realtimeStarted = false;
        handler.removeCallbacksAndMessages(null);
    }
}

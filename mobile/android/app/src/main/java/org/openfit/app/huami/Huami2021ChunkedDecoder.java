/*  Ported from Gadgetbridge (AGPLv3):
    nodomain.freeyourgadget.gadgetbridge.service.devices.huami.Huami2021ChunkedDecoder
    Copyright (C) 2022-2024 José Rebelo. Adapted for Open Fit: CryptoUtils → HuamiCrypto,
    ArrayUtils.subarray → Arrays.copyOfRange, slf4j → android.util.Log; byte-level
    reassembly/decrypt logic unchanged. */
package org.openfit.app.huami;

import android.util.Log;

import java.nio.ByteBuffer;
import java.util.Arrays;

public class Huami2021ChunkedDecoder {
    private static final String TAG = "HuamiDecoder";

    private Byte currentHandle;
    private int currentType;
    private int currentLength;
    private ByteBuffer reassemblyBuffer;

    private byte lastHandle;
    private byte lastCount;

    private volatile byte[] sharedSessionKey;

    private Huami2021Handler huami2021Handler;
    private final boolean force2021Protocol;

    public Huami2021ChunkedDecoder(final Huami2021Handler huami2021Handler, final boolean force2021Protocol) {
        this.huami2021Handler = huami2021Handler;
        this.force2021Protocol = force2021Protocol;
    }

    public void setEncryptionParameters(final byte[] sharedSessionKey) {
        this.sharedSessionKey = sharedSessionKey;
    }

    public byte getLastHandle() {
        return lastHandle;
    }

    public byte getLastCount() {
        return lastCount;
    }

    public boolean decode(final byte[] data) {
        int i = 0;
        if (data[i++] != 0x03) {
            Log.w(TAG, "Ignoring non-chunked payload");
            return false;
        }
        final byte flags = data[i++];
        final boolean encrypted = ((flags & 0x08) == 0x08);
        final boolean firstChunk = ((flags & 0x01) == 0x01);
        final boolean lastChunk = ((flags & 0x02) == 0x02);
        final boolean needsAck = ((flags & 0x04) == 0x04);

        if (force2021Protocol) {
            i++; // skip extended header
        }
        final byte handle = data[i++];
        if (currentHandle != null && currentHandle != handle) {
            Log.w(TAG, "ignoring handle " + handle + ", expected " + currentHandle);
            return false;
        }
        lastHandle = handle;
        lastCount = data[i++];
        if (firstChunk) {
            int full_length = (data[i++] & 0xff) | ((data[i++] & 0xff) << 8) | ((data[i++] & 0xff) << 16) | ((data[i++] & 0xff) << 24);
            currentLength = full_length;
            if (encrypted) {
                int encrypted_length = full_length + 8;
                int overflow = encrypted_length % 16;
                if (overflow > 0) {
                    encrypted_length += (16 - overflow);
                }
                full_length = encrypted_length;
            }
            reassemblyBuffer = ByteBuffer.allocate(full_length);
            currentType = (data[i++] & 0xff) | ((data[i++] & 0xff) << 8);
            currentHandle = handle;
        }
        reassemblyBuffer.put(data, i, data.length - i);
        if (lastChunk) {
            byte[] buf = reassemblyBuffer.array();
            if (encrypted) {
                if (sharedSessionKey == null) {
                    Log.w(TAG, "Got encrypted message, but there's no shared session key");
                    reset();
                    return false;
                }

                byte[] messagekey = new byte[16];
                for (int j = 0; j < 16; j++) {
                    messagekey[j] = (byte) (sharedSessionKey[j] ^ handle);
                }
                try {
                    buf = HuamiCrypto.decryptAES(buf, messagekey);
                    buf = Arrays.copyOfRange(buf, 0, currentLength);
                } catch (Exception e) {
                    Log.w(TAG, "error decrypting " + e.getMessage());
                    reset();
                    return false;
                }
            }

            try {
                huami2021Handler.handle2021Payload((short) currentType, buf);
            } catch (final Exception e) {
                Log.e(TAG, "Failed to handle payload", e);
            }
            reset();
        }

        return needsAck;
    }

    public void reset() {
        currentHandle = null;
        currentType = 0;
    }
}

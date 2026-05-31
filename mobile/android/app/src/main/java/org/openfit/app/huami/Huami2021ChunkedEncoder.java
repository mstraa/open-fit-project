/*  Ported from Gadgetbridge (AGPLv3):
    nodomain.freeyourgadget.gadgetbridge.service.devices.huami.Huami2021ChunkedEncoder
    Copyright (C) 2022-2024 José Rebelo. Adapted for Open Fit: framework deps
    (CryptoUtils/CheckSums/calcMaxWriteChunk/slf4j) swapped for local equivalents;
    byte-level protocol logic is unchanged. */
package org.openfit.app.huami;

import android.util.Log;

import java.util.function.Consumer;

public class Huami2021ChunkedEncoder {
    private static final String TAG = "HuamiEncoder";

    private byte writeHandle;

    private volatile int encryptedSequenceNr;
    private volatile byte[] sharedSessionKey;
    private volatile int mMTU;

    public Huami2021ChunkedEncoder(final int mMTU) {
        this.mMTU = mMTU;
    }

    private static int calcMaxWriteChunk(int mtu) {
        return Math.min(512, Math.max(23, mtu) - 3);
    }

    public synchronized void setEncryptionParameters(final int encryptedSequenceNr, final byte[] sharedSessionKey) {
        this.encryptedSequenceNr = encryptedSequenceNr;
        this.sharedSessionKey = sharedSessionKey;
    }

    public synchronized void setMTU(int mMTU) {
        this.mMTU = mMTU;
    }

    public synchronized void write(final Consumer<byte[]> chunkWriter,
                                   final short type,
                                   final byte[] data,
                                   final boolean extended_flags,
                                   final boolean encrypt) {
        if (encrypt && sharedSessionKey == null) {
            Log.e(TAG, "Can't encrypt without the shared session key");
            return;
        }

        writeHandle++;

        int remaining = data.length;
        final int length = data.length;
        byte count = 0;
        int header_size = 10;

        if (extended_flags) {
            header_size++;
        }

        final byte[] dataToSend;
        if (extended_flags && encrypt) {
            final byte[] messageKey = new byte[16];
            for (int i = 0; i < 16; i++) {
                messageKey[i] = (byte) (sharedSessionKey[i] ^ writeHandle);
            }
            int encrypted_length = length + 8;
            int overflow = encrypted_length % 16;
            if (overflow > 0) {
                encrypted_length += (16 - overflow);
            }

            final byte[] encryptable_payload = new byte[encrypted_length];
            System.arraycopy(data, 0, encryptable_payload, 0, length);
            encryptable_payload[length] = (byte) (encryptedSequenceNr & 0xff);
            encryptable_payload[length + 1] = (byte) ((encryptedSequenceNr >> 8) & 0xff);
            encryptable_payload[length + 2] = (byte) ((encryptedSequenceNr >> 16) & 0xff);
            encryptable_payload[length + 3] = (byte) ((encryptedSequenceNr >> 24) & 0xff);
            encryptedSequenceNr++;
            int checksum = HuamiCrypto.crc32(encryptable_payload, 0, length + 4);
            encryptable_payload[length + 4] = (byte) (checksum & 0xff);
            encryptable_payload[length + 5] = (byte) ((checksum >> 8) & 0xff);
            encryptable_payload[length + 6] = (byte) ((checksum >> 16) & 0xff);
            encryptable_payload[length + 7] = (byte) ((checksum >> 24) & 0xff);
            remaining = encrypted_length;
            try {
                dataToSend = HuamiCrypto.encryptAES(encryptable_payload, messageKey);
            } catch (Exception e) {
                Log.e(TAG, "error while encrypting", e);
                return;
            }
        } else {
            dataToSend = data;
        }

        while (remaining > 0) {
            final int maxChunkLength = calcMaxWriteChunk(mMTU) - header_size;
            int copyBytes = Math.min(remaining, maxChunkLength);
            byte[] chunk = new byte[copyBytes + header_size];

            byte flags = 0;
            if (encrypt) {
                flags |= 0x08;
            }
            if (count == 0) {
                flags |= 0x01; // first chunk
                int i = 4;
                if (extended_flags) {
                    i++;
                }
                chunk[i++] = (byte) (length & 0xff);
                chunk[i++] = (byte) ((length >> 8) & 0xff);
                chunk[i++] = (byte) ((length >> 16) & 0xff);
                chunk[i++] = (byte) ((length >> 24) & 0xff);
                chunk[i++] = (byte) (type & 0xff);
                chunk[i] = (byte) ((type >> 8) & 0xff);
            }
            if (remaining <= maxChunkLength) {
                flags |= 0x02; // last chunk
                flags |= 0x04; // needs ack
            }
            chunk[0] = 0x03;
            chunk[1] = flags;
            if (extended_flags) {
                chunk[2] = 0;
                chunk[3] = writeHandle;
                chunk[4] = count;
            } else {
                chunk[2] = writeHandle;
                chunk[3] = count;
            }

            System.arraycopy(dataToSend, dataToSend.length - remaining, chunk, header_size, copyBytes);
            chunkWriter.accept(chunk);
            remaining -= copyBytes;
            header_size = 4;

            if (extended_flags) {
                header_size++;
            }

            count++;
        }
    }

    public void reset() {
        writeHandle = 0;
        encryptedSequenceNr = 0;
    }
}

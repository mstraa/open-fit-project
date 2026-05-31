package org.openfit.app.huami;

import java.util.zip.CRC32;

import javax.crypto.Cipher;
import javax.crypto.spec.SecretKeySpec;

/**
 * Crypto primitives for the Huami/Zepp-OS protocol, ported from Gadgetbridge
 * (AGPLv3 — nodomain.freeyourgadget.gadgetbridge.util.CryptoUtils + CheckSums).
 * AES-ECB/NoPadding for the per-message session cipher; CRC32 for the chunked
 * transport's integrity field.
 */
public final class HuamiCrypto {
    private HuamiCrypto() {}

    public static byte[] encryptAES(byte[] value, byte[] key) throws Exception {
        Cipher c = Cipher.getInstance("AES/ECB/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"));
        return c.doFinal(value);
    }

    public static byte[] decryptAES(byte[] value, byte[] key) throws Exception {
        Cipher c = Cipher.getInstance("AES/ECB/NoPadding");
        c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"));
        return c.doFinal(value);
    }

    public static int crc32(byte[] seq, int offset, int length) {
        CRC32 crc = new CRC32();
        crc.update(seq, offset, length);
        return (int) crc.getValue();
    }

    /** Little-endian uint32 read (Gadgetbridge BLETypeConversions.toUint32). */
    public static int toUint32(byte[] b, int o) {
        return (b[o] & 0xff) | ((b[o + 1] & 0xff) << 8) | ((b[o + 2] & 0xff) << 16) | ((b[o + 3] & 0xff) << 24);
    }

    /** Parse a 32-hex-char auth key (optionally "0x"-prefixed) into 16 bytes. */
    public static byte[] hexToBytes(String s) {
        String h = s.trim();
        if (h.startsWith("0x") || h.startsWith("0X")) h = h.substring(2);
        int n = h.length() / 2;
        byte[] out = new byte[n];
        for (int i = 0; i < n; i++) {
            out[i] = (byte) Integer.parseInt(h.substring(i * 2, i * 2 + 2), 16);
        }
        return out;
    }
}

package org.openfit.app.huami;

/** Sink for decoded Zepp-OS messages (ported seam from Gadgetbridge's
 *  Huami2021Handler). `type` is the endpoint/message type; `data` is the
 *  decrypted, reassembled payload. */
public interface Huami2021Handler {
    void handle2021Payload(short type, byte[] data);
}

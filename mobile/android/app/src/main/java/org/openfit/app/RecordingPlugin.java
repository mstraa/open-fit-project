package org.openfit.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Controls the native workout {@link RecordingService} (Stage 1: GPS + IMU + HR
 * capture to a crash-safe local file) and relays its 1 Hz live summary to the
 * React UI. The service does the sampling/writing so it survives screen-lock; the
 * plugin only starts/pauses/stops it and forwards ticks.
 *
 * A foreground service typed "location" with while-in-use FINE location keeps
 * sampling with the screen off, so background-location permission isn't required
 * for Stage 1 (the manifest declares it for later hardening).
 */
@CapacitorPlugin(
    name = "OpenFitRecording",
    permissions = {
        @Permission(strings = { Manifest.permission.ACCESS_FINE_LOCATION }, alias = "location"),
        @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications"),
    }
)
public class RecordingPlugin extends Plugin {
    private static final String TAG = "RecordingPlugin";

    private boolean listenerWired = false;
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    @Override
    public void load() {
        // Retry any workout .fit that didn't upload last time (offline on Stop).
        io.execute(this::flushPendingUploads);
    }

    @PluginMethod
    public void start(PluginCall call) {
        final String sport = call.getString("sport", "running");
        final boolean needLoc = !"calisthenics".equals(sport);
        boolean haveLoc = getPermissionState("location") == PermissionState.GRANTED;
        boolean haveNotif = Build.VERSION.SDK_INT < 33
            || getPermissionState("notifications") == PermissionState.GRANTED;
        if ((needLoc && !haveLoc) || !haveNotif) {
            requestPermissionForAliases(new String[]{ "location", "notifications" }, call, "afterPerms");
            return;
        }
        startInternal(call, sport);
    }

    @PermissionCallback
    private void afterPerms(PluginCall call) {
        final String sport = call.getString("sport", "running");
        if (!"calisthenics".equals(sport) && getPermissionState("location") != PermissionState.GRANTED) {
            call.reject("location permission denied");
            return;
        }
        startInternal(call, sport);
    }

    private void startInternal(PluginCall call, String sport) {
        wireListener();
        String sessionId = UUID.randomUUID().toString();
        Intent svc = new Intent(getContext(), RecordingService.class)
            .setAction(RecordingService.ACTION_START)
            .putExtra("sport", sport)
            .putExtra("sessionId", sessionId)
            .putExtra("startWallMs", System.currentTimeMillis());
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) getContext().startForegroundService(svc);
        else getContext().startService(svc);
        JSObject r = new JSObject();
        r.put("sessionId", sessionId);
        r.put("sport", sport);
        call.resolve(r);
    }

    @PluginMethod
    public void pause(PluginCall call) {
        send(RecordingService.ACTION_PAUSE);
        call.resolve();
    }

    @PluginMethod
    public void resume(PluginCall call) {
        send(RecordingService.ACTION_RESUME);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        send(RecordingService.ACTION_STOP);
        call.resolve();
    }

    @PluginMethod
    public void isActive(PluginCall call) {
        JSObject r = new JSObject();
        r.put("active", RecordingService.isRecording());
        call.resolve(r);
    }

    private void send(String action) {
        Intent svc = new Intent(getContext(), RecordingService.class).setAction(action);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) getContext().startForegroundService(svc);
        else getContext().startService(svc);
    }

    private void wireListener() {
        if (listenerWired) return;
        listenerWired = true;
        RecordingService.setLiveListener(new RecordingService.LiveListener() {
            @Override
            public void onTick(long elapsedMs, double distanceM, double speedMps, int hr,
                               int cadence, int power, double altitudeM, double ascentM, boolean paused) {
                JSObject ev = new JSObject();
                ev.put("elapsedMs", elapsedMs);
                ev.put("distanceM", distanceM);
                ev.put("speedMps", speedMps);
                ev.put("hr", hr);
                ev.put("cadence", cadence);
                ev.put("power", power);
                ev.put("altitudeM", altitudeM);
                ev.put("ascentM", ascentM);
                ev.put("paused", paused);
                notifyListeners("tick", ev);
            }

            @Override
            public void onStopped(String sessionDir, long elapsedMs) {
                JSObject ev = new JSObject();
                ev.put("sessionDir", sessionDir);
                ev.put("elapsedMs", elapsedMs);
                notifyListeners("recordingStopped", ev);
                io.execute(() -> encodeAndQueue(new File(sessionDir)));
            }
        });
    }

    /** Encode the recorded session to .fit, drop it in the pending-uploads dir, then
     *  try to upload (offline → it stays queued and retries on next launch). */
    private void encodeAndQueue(File sessionDir) {
        try {
            byte[] fit = FitEncoder.encode(sessionDir);
            File pending = new File(getContext().getFilesDir(), "pending_uploads");
            //noinspection ResultOfMethodCallIgnored
            pending.mkdirs();
            File out = new File(pending, "workout-" + sessionDir.getName() + ".fit");
            try (FileOutputStream fos = new FileOutputStream(out)) {
                fos.write(fit);
            }
            Log.i(TAG, "encoded " + fit.length + " bytes → " + out.getName());
        } catch (Exception e) {
            Log.w(TAG, "encode failed: " + e.getMessage());
        }
        flushPendingUploads();
    }

    /** Upload every queued .fit; delete each on success, keep the rest if offline. */
    private void flushPendingUploads() {
        SharedPreferences p = getContext().getSharedPreferences("ofit_ble", Context.MODE_PRIVATE);
        String base = p.getString("apiBase", "");
        String token = p.getString("token", "");
        File pending = new File(getContext().getFilesDir(), "pending_uploads");
        File[] files = pending.listFiles((d, n) -> n.endsWith(".fit"));
        if (files == null || files.length == 0 || base == null || base.isEmpty()) return;
        int ok = 0;
        for (File f : files) {
            if (postFit(base, token, f)) {
                //noinspection ResultOfMethodCallIgnored
                f.delete();
                ok++;
            } else {
                break; // server unreachable → keep the rest for next time
            }
        }
        if (ok > 0) {
            Log.i(TAG, "uploaded " + ok + " workout file(s)");
            final int n = ok;
            getActivity().runOnUiThread(() -> {
                JSObject ev = new JSObject();
                ev.put("count", n);
                notifyListeners("recordingUploaded", ev);
            });
        }
    }

    /** Multipart POST one .fit to {base}/api/import (field name "file", filename .fit). */
    private boolean postFit(String base, String token, File file) {
        String boundary = "----ofit" + System.currentTimeMillis();
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(base + "/api/import").openConnection();
            c.setConnectTimeout(8000);
            c.setReadTimeout(20000);
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
            if (token != null && !token.isEmpty()) c.setRequestProperty("Authorization", "Bearer " + token);
            byte[] fileBytes = readAll(file);
            String preamble = "--" + boundary + "\r\n"
                + "Content-Disposition: form-data; name=\"file\"; filename=\"" + file.getName() + "\"\r\n"
                + "Content-Type: application/octet-stream\r\n\r\n";
            String epilogue = "\r\n--" + boundary + "--\r\n";
            try (OutputStream os = c.getOutputStream()) {
                os.write(preamble.getBytes(StandardCharsets.UTF_8));
                os.write(fileBytes);
                os.write(epilogue.getBytes(StandardCharsets.UTF_8));
            }
            int code = c.getResponseCode();
            return code >= 200 && code < 300;
        } catch (Exception e) {
            Log.w(TAG, "upload failed: " + e.getMessage());
            return false;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static byte[] readAll(File f) throws Exception {
        byte[] buf = new byte[(int) f.length()];
        try (java.io.FileInputStream in = new java.io.FileInputStream(f)) {
            int off = 0, n;
            while (off < buf.length && (n = in.read(buf, off, buf.length - off)) > 0) off += n;
        }
        return buf;
    }
}

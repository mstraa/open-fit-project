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

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

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
        @Permission(strings = { Manifest.permission.ACTIVITY_RECOGNITION }, alias = "activity"),
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

    @Override
    protected void handleOnDestroy() {
        // Shut down the upload worker so its thread (and the captured Context/File
        // handles) doesn't outlive the plugin; drain briefly for an in-flight POST.
        io.shutdown();
        try {
            if (!io.awaitTermination(5, TimeUnit.SECONDS)) io.shutdownNow();
        } catch (InterruptedException e) {
            io.shutdownNow();
            Thread.currentThread().interrupt();
        }
        super.handleOnDestroy();
    }

    @PluginMethod
    public void start(PluginCall call) {
        final String sport = call.getString("sport", "running");
        final boolean needLoc = !"calisthenics".equals(sport);
        boolean haveLoc = getPermissionState("location") == PermissionState.GRANTED;
        boolean haveNotif = Build.VERSION.SDK_INT < 33
            || getPermissionState("notifications") == PermissionState.GRANTED;
        // ACTIVITY_RECOGNITION (steps/cadence via the step detector) is a runtime
        // permission on API 29+. We request it but DON'T require it — recording
        // proceeds without it; only steps/cadence are unavailable if it's denied.
        boolean haveActivity = Build.VERSION.SDK_INT < 29
            || getPermissionState("activity") == PermissionState.GRANTED;
        if ((needLoc && !haveLoc) || !haveNotif || !haveActivity) {
            requestPermissionForAliases(new String[]{ "location", "notifications", "activity" }, call, "afterPerms");
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

    /** Re-attempt any queued/failed uploads now (e.g. after the UI refreshed the
     *  server URL + token following an auth/credential failure). Unlike the
     *  on-launch auto-flush, an explicit Retry also re-tries server-rejected files. */
    @PluginMethod
    public void retryUploads(PluginCall call) {
        io.execute(() -> {
            requeueRejected();
            flushPendingUploads();
        });
        call.resolve();
    }

    /** Move any quarantined (server-rejected) files back into the upload queue so an
     *  explicit user Retry attempts them again. The on-launch auto-flush still skips
     *  the rejected/ folder, so a genuinely-bad file won't re-POST on every start. */
    private void requeueRejected() {
        File rejected = new File(new File(getContext().getFilesDir(), "pending_uploads"), "rejected");
        File[] files = rejected.listFiles((d, n) -> n.endsWith(".fit"));
        if (files == null) return;
        for (File f : files) {
            File dest = new File(f.getParentFile().getParentFile(), f.getName()); // → pending_uploads/
            //noinspection ResultOfMethodCallIgnored
            f.renameTo(dest);
        }
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
            notifyUploadFailed("Could not save the recording file: " + e.getMessage());
        }
        flushPendingUploads();
    }

    /** Outcome of one upload attempt — drives whether the local file is deleted,
     *  quarantined, or kept for retry. */
    private enum UploadResult { SAVED, REJECTED, UNREACHABLE }

    /** Upload outcome plus a human reason, so failures can be surfaced in the UI
     *  instead of dying silently in logcat. {@code detail} is null on success. */
    private static final class Upload {
        final UploadResult result;
        final String detail;
        Upload(UploadResult result, String detail) { this.result = result; this.detail = detail; }
    }

    /** Upload every queued .fit. Delete only on a CONFIRMED server-side ingest;
     *  quarantine (never delete) a file the server explicitly refused; keep the
     *  rest if the server is unreachable. A recording must never be silently lost
     *  just because the POST returned 2xx. */
    private void flushPendingUploads() {
        SharedPreferences p = getContext().getSharedPreferences("ofit_ble", Context.MODE_PRIVATE);
        String base = p.getString("apiBase", "");
        String token = p.getString("token", "");
        File pending = new File(getContext().getFilesDir(), "pending_uploads");
        File[] files = pending.listFiles((d, n) -> n.endsWith(".fit"));
        if (files == null || files.length == 0) return; // nothing queued → nothing to do
        if (base == null || base.isEmpty()) {
            // The recorder gets the server URL + token from the JS side (configure()).
            // Until that happens the .fit just waits here — tell the user instead of
            // failing silently, so a finished workout doesn't seem to vanish.
            notifyUploadFailed("No server configured yet — open the app once with the server set up, then tap Retry.");
            return;
        }
        int ok = 0;
        String lastFail = null;
        for (File f : files) {
            Upload res = postFit(base, token, f);
            if (res.result == UploadResult.SAVED) {
                //noinspection ResultOfMethodCallIgnored
                f.delete();
                ok++;
            } else if (res.result == UploadResult.REJECTED) {
                // Server got the file but couldn't ingest it. Move it out of the
                // retry queue so we don't re-POST a bad file every launch, but KEEP
                // it — losing a real recording is worse than a stuck upload.
                quarantine(f);
                lastFail = res.detail;
            } else {
                lastFail = res.detail;
                break; // server unreachable → keep the queue intact, retry later
            }
        }
        if (ok > 0) notifyUploaded(ok);
        if (ok == 0 && lastFail != null) notifyUploadFailed(lastFail);
    }

    private void notifyUploaded(int n) {
        Log.i(TAG, "uploaded " + n + " workout file(s)");
        // flushPendingUploads also runs from load() at app start (offline retry),
        // where no Activity is bound yet → getActivity() can be null.
        final android.app.Activity act = getActivity();
        if (act == null) return;
        act.runOnUiThread(() -> {
            JSObject ev = new JSObject();
            ev.put("count", n);
            notifyListeners("recordingUploaded", ev);
        });
    }

    private void notifyUploadFailed(String reason) {
        Log.w(TAG, "upload failed: " + reason);
        final android.app.Activity act = getActivity();
        if (act == null) return; // load() retry before UI is bound; logcat still has it
        act.runOnUiThread(() -> {
            JSObject ev = new JSObject();
            ev.put("reason", reason);
            notifyListeners("recordingUploadFailed", ev);
        });
    }

    /** Multipart POST one .fit to {base}/api/import (field name "file", filename
     *  .fit). Returns SAVED only when the server confirms the file was ingested
     *  (its per-file {@code ok == true}); REJECTED when the server parsed it but
     *  refused it; UNREACHABLE on a network error or non-2xx status. The batch
     *  endpoint returns 200 even for a file it failed to ingest, so the status
     *  code alone is not proof of success. */
    private Upload postFit(String base, String token, File file) {
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
            if (code < 200 || code >= 300) {
                Log.w(TAG, "upload HTTP " + code + " for " + file.getName());
                String why = code == 401 || code == 403
                    ? "Login expired (HTTP " + code + ") — reconnect a device or sign in again, then tap Retry."
                    : "Server returned HTTP " + code + ".";
                return new Upload(UploadResult.UNREACHABLE, why); // keep, retry later
            }
            String body;
            try (InputStream in = c.getInputStream()) {
                body = readStream(in);
            }
            try {
                JSONArray fs = new JSONObject(body).optJSONArray("files");
                if (fs != null && fs.length() > 0) {
                    JSONObject f0 = fs.getJSONObject(0);
                    if (f0.optBoolean("ok", false)) return new Upload(UploadResult.SAVED, null);
                    String err = f0.optString("error", "unknown");
                    Log.w(TAG, "server rejected " + file.getName() + ": " + err);
                    return new Upload(UploadResult.REJECTED, "Server couldn't read the recording: " + err);
                }
            } catch (Exception parse) {
                Log.w(TAG, "unparseable import response, assuming saved: " + parse.getMessage());
            }
            return new Upload(UploadResult.SAVED, null); // 2xx with no per-file verdict → assume accepted
        } catch (Exception e) {
            Log.w(TAG, "upload failed: " + e.getMessage());
            return new Upload(UploadResult.UNREACHABLE, "Couldn't reach the server: " + e.getMessage());
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** Move a server-rejected file into pending_uploads/rejected/ so it is kept
     *  for inspection/recovery but no longer re-uploaded on every launch. */
    private void quarantine(File f) {
        try {
            File dir = new File(f.getParentFile(), "rejected");
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
            File dest = new File(dir, f.getName());
            //noinspection ResultOfMethodCallIgnored
            if (f.renameTo(dest)) {
                Log.w(TAG, "quarantined rejected upload " + f.getName());
            } else {
                Log.w(TAG, "could not quarantine " + f.getName() + " (left in queue)");
            }
        } catch (Exception e) {
            Log.w(TAG, "quarantine failed: " + e.getMessage());
        }
    }

    private static String readStream(InputStream in) throws Exception {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        return new String(bos.toByteArray(), StandardCharsets.UTF_8);
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

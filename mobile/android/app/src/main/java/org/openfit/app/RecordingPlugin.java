package org.openfit.app;

import android.Manifest;
import android.content.Intent;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.UUID;

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

    private boolean listenerWired = false;

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
                               int cadence, int power, boolean paused) {
                JSObject ev = new JSObject();
                ev.put("elapsedMs", elapsedMs);
                ev.put("distanceM", distanceM);
                ev.put("speedMps", speedMps);
                ev.put("hr", hr);
                ev.put("cadence", cadence);
                ev.put("power", power);
                ev.put("paused", paused);
                notifyListeners("tick", ev);
            }

            @Override
            public void onStopped(String sessionDir, long elapsedMs) {
                JSObject ev = new JSObject();
                ev.put("sessionDir", sessionDir);
                ev.put("elapsedMs", elapsedMs);
                notifyListeners("recordingStopped", ev);
            }
        });
    }
}

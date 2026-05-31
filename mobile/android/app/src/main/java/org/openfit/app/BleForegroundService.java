package org.openfit.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;

/**
 * Foreground service that keeps the app process (and thus the native BLE
 * connection + its keepalive + native ingest) alive while the screen is locked /
 * the app is backgrounded — the foundation for background workout recording.
 * Started when a device connects, stopped on disconnect.
 */
public class BleForegroundService extends Service {
    static final String CHANNEL = "ofit_ble";
    static final int NOTIF_ID = 4242;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String text = intent != null && intent.getStringExtra("text") != null
            ? intent.getStringExtra("text")
            : "Streaming from your device";
        ensureChannel();
        Notification n = new NotificationCompat.Builder(this, CHANNEL)
            .setContentTitle("OpenFit")
            .setContentText(text)
            .setSmallIcon(getApplicationInfo().icon)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
        } else {
            startForeground(NOTIF_ID, n);
        }
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null && nm.getNotificationChannel(CHANNEL) == null) {
                NotificationChannel ch = new NotificationChannel(
                    CHANNEL, "Device connection", NotificationManager.IMPORTANCE_LOW);
                ch.setDescription("Keeps your wearable connected in the background.");
                nm.createNotificationChannel(ch);
            }
        }
    }

    static void start(Context ctx, String text) {
        Intent i = new Intent(ctx, BleForegroundService.class);
        i.putExtra("text", text);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ctx.startForegroundService(i);
        } else {
            ctx.startService(i);
        }
    }

    static void stop(Context ctx) {
        ctx.stopService(new Intent(ctx, BleForegroundService.class));
    }
}

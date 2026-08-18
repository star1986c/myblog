package io.qzz.superstar1014.mynotes;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.IBinder;
import android.util.Log;

import java.util.List;

/** Keeps the process-wide routed Hermes WebSocket eligible to run while the app is backgrounded. */
public final class HermesChatConnectionService extends Service {
  private static final String TAG = "HermesChatService";
  private static final String CHANNEL_ID = "hermes_chat_connection";
  private static final int NOTIFICATION_ID = 2204;

  static void startIfConfigured(Context context) {
    Context application = context.getApplicationContext();
    if (!hasConfiguredProfile(application)) {
      stop(application);
      return;
    }
    try {
      application.startForegroundService(
        new Intent(application, HermesChatConnectionService.class)
      );
    } catch (RuntimeException error) {
      // Android can reject a foreground-service start if the caller is no longer visible.
      // The process-wide socket remains active and the next visible activity retries.
      Log.w(TAG, "Unable to start Hermes foreground connection service", error);
    }
  }

  static void stop(Context context) {
    context.getApplicationContext().stopService(
      new Intent(context.getApplicationContext(), HermesChatConnectionService.class)
    );
  }

  private static boolean hasConfiguredProfile(Context context) {
    SecureSessionStore secureStore = new SecureSessionStore(context);
    for (Models.HermesChatProfile profile : new HermesChatProfileStore(context).load()) {
      if (!secureStore.loadHermesChatKey(profile.id).isEmpty()) return true;
    }
    return false;
  }

  @Override
  public void onCreate() {
    super.onCreate();
    createNotificationChannel();
    startForeground(
      NOTIFICATION_ID,
      connectionNotification(),
      ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING
    );
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    List<Models.HermesChatProfile> profiles = new HermesChatProfileStore(this).load();
    if (!hasConfiguredProfile(this)) {
      stopSelf();
      return START_NOT_STICKY;
    }
    HermesChatConnectionManager.get(this).syncProfiles(profiles);
    return START_NOT_STICKY;
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  private void createNotificationChannel() {
    NotificationChannel channel = new NotificationChannel(
      CHANNEL_ID,
      getString(R.string.hermes_chat_service_channel),
      NotificationManager.IMPORTANCE_LOW
    );
    channel.setDescription(getString(R.string.hermes_chat_service_channel_description));
    channel.setShowBadge(false);
    channel.enableVibration(false);
    channel.setSound(null, null);
    getSystemService(NotificationManager.class).createNotificationChannel(channel);
  }

  private Notification connectionNotification() {
    Intent openChats = new Intent(this, HermesConversationsActivity.class)
      .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    PendingIntent contentIntent = PendingIntent.getActivity(
      this,
      0,
      openChats,
      PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
    );
    return new Notification.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_chat)
      .setColor(getColor(R.color.brand_primary))
      .setContentTitle(getString(R.string.hermes_chat_service_title))
      .setContentText(getString(R.string.hermes_chat_service_description))
      .setContentIntent(contentIntent)
      .setCategory(Notification.CATEGORY_SERVICE)
      .setVisibility(Notification.VISIBILITY_PRIVATE)
      .setOnlyAlertOnce(true)
      .setOngoing(true)
      .build();
  }
}

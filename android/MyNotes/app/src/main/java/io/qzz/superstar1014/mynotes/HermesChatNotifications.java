package io.qzz.superstar1014.mynotes;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;

/** Posts privacy-preserving notifications for decrypted Hermes messages. */
final class HermesChatNotifications {
  private static final String CHANNEL_ID = "hermes_chat_messages_v1";
  private static final String GROUP_ID = "hermes_chat_messages";
  private static final int NOTIFICATION_PREFIX = 0x48430000;

  private final Context context;
  private final NotificationManager manager;

  HermesChatNotifications(Context context) {
    this.context = context.getApplicationContext();
    manager = this.context.getSystemService(NotificationManager.class);
    createChannel();
  }

  void showMessage(
    String profileId,
    String profileLabel,
    int unreadCount,
    HermesChatCrypto.ChatMessage message
  ) {
    if (profileId == null || profileId.trim().isEmpty() || manager == null) return;
    if (context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
        != PackageManager.PERMISSION_GRANTED) return;

    String title = normalizedLabel(profileId, profileLabel);
    boolean hasAttachment = message != null
      && message.attachments != null
      && message.attachments.length() > 0;
    String summary = context.getString(
      hasAttachment
        ? R.string.hermes_chat_message_attachment
        : R.string.hermes_chat_message_received
    );
    long sentAt = message == null || message.sentAt <= 0
      ? System.currentTimeMillis()
      : message.sentAt;

    Notification publicVersion = new Notification.Builder(context, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_chat)
      .setColor(context.getColor(R.color.brand_primary))
      .setContentTitle(context.getString(R.string.hermes_chat_message_public_title))
      .setContentText(context.getString(R.string.hermes_chat_message_public_text))
      .setCategory(Notification.CATEGORY_MESSAGE)
      .setVisibility(Notification.VISIBILITY_PUBLIC)
      .build();

    Notification notification = new Notification.Builder(context, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_chat)
      .setColor(context.getColor(R.color.brand_primary))
      .setContentTitle(title)
      .setContentText(summary)
      .setContentIntent(openConversationPendingIntent(profileId, title))
      .setCategory(Notification.CATEGORY_MESSAGE)
      .setGroup(GROUP_ID)
      .setAutoCancel(true)
      .setOnlyAlertOnce(true)
      .setWhen(sentAt)
      .setShowWhen(true)
      .setNumber(unreadCount)
      .setVisibility(Notification.VISIBILITY_PRIVATE)
      .setPublicVersion(publicVersion)
      .build();
    manager.notify(notificationId(profileId), notification);
  }

  void cancel(String profileId) {
    if (profileId == null || manager == null) return;
    manager.cancel(notificationId(profileId));
  }

  static Intent openConversationIntent(
    Context context,
    String profileId,
    String profileLabel
  ) {
    return new Intent(context, HermesChatActivity.class)
      .setAction(context.getPackageName() + ".OPEN_HERMES_CHAT." + profileId)
      .putExtra(HermesChatActivity.EXTRA_PROFILE_ID, profileId)
      .putExtra(HermesChatActivity.EXTRA_PROFILE_LABEL, profileLabel)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
  }

  private PendingIntent openConversationPendingIntent(String profileId, String profileLabel) {
    return PendingIntent.getActivity(
      context,
      notificationId(profileId),
      openConversationIntent(context, profileId, profileLabel),
      PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
    );
  }

  private void createChannel() {
    if (manager == null) return;
    NotificationChannel channel = new NotificationChannel(
      CHANNEL_ID,
      context.getString(R.string.hermes_chat_message_channel),
      NotificationManager.IMPORTANCE_HIGH
    );
    channel.setDescription(context.getString(R.string.hermes_chat_message_channel_description));
    channel.setShowBadge(true);
    channel.enableVibration(true);
    manager.createNotificationChannel(channel);
  }

  private static String normalizedLabel(String profileId, String profileLabel) {
    if (profileLabel != null && !profileLabel.trim().isEmpty()) return profileLabel.trim();
    if (profileId != null && !profileId.trim().isEmpty()) return "Hermes · " + profileId.trim();
    return "Hermes";
  }

  private static int notificationId(String profileId) {
    return NOTIFICATION_PREFIX | (profileId.hashCode() & 0x0000ffff);
  }
}

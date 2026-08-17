package io.qzz.superstar1014.mynotes;

import android.content.Context;
import android.content.SharedPreferences;

final class HermesChatCacheSettings {
  static final int DEFAULT_RETENTION_DAYS = 30;
  private static final String PREFERENCES = "hermes_chat_cache_settings";
  private static final String RETENTION_DAYS = "retention_days";

  private HermesChatCacheSettings() {}

  static int retentionDays(Context context) {
    int value = preferences(context).getInt(RETENTION_DAYS, DEFAULT_RETENTION_DAYS);
    return valid(value) ? value : DEFAULT_RETENTION_DAYS;
  }

  static void setRetentionDays(Context context, int value) {
    if (!valid(value)) throw new IllegalArgumentException("聊天缓存保留时间无效。");
    preferences(context).edit().putInt(RETENTION_DAYS, value).apply();
  }

  private static SharedPreferences preferences(Context context) {
    return context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
  }

  private static boolean valid(int value) {
    return value == 0 || value == 7 || value == 30 || value == 90;
  }
}

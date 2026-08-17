package io.qzz.superstar1014.mynotes;

import android.content.Context;
import android.content.SharedPreferences;

/** Persists per-profile unread counts across Activity and process restarts. */
final class HermesChatUnreadStore {
  private static final String PREFS = "hermes_chat_unread_v1";
  private static final String PREFIX = "unread_";
  private static final int MAX_UNREAD = 9999;

  private final SharedPreferences preferences;

  HermesChatUnreadStore(Context context) {
    preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  int get(String spaceId) {
    return Math.max(0, preferences.getInt(key(spaceId), 0));
  }

  int increment(String spaceId) {
    int updated = Math.min(MAX_UNREAD, get(spaceId) + 1);
    preferences.edit().putInt(key(spaceId), updated).apply();
    return updated;
  }

  void clear(String spaceId) {
    preferences.edit().remove(key(spaceId)).apply();
  }

  void clearAll() {
    preferences.edit().clear().apply();
  }

  private static String key(String value) {
    String spaceId = value == null ? "" : value.trim().toLowerCase(java.util.Locale.ROOT);
    if (!spaceId.matches("[a-z0-9][a-z0-9_-]{0,63}")) {
      throw new IllegalArgumentException("Hermes profile id 无效。");
    }
    return PREFIX + spaceId;
  }
}

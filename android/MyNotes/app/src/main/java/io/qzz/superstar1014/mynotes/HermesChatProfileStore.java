package io.qzz.superstar1014.mynotes;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** Small local cache for the rarely-changing server profile catalog. */
final class HermesChatProfileStore {
  private static final String PREFS = "hermes_chat_profiles_v1";
  private static final String KEY_PROFILES = "profiles";

  private final SharedPreferences preferences;

  HermesChatProfileStore(Context context) {
    preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  List<Models.HermesChatProfile> load() {
    String stored = preferences.getString(KEY_PROFILES, "");
    if (stored == null || stored.isEmpty()) return List.of();
    try {
      JSONArray values = new JSONArray(stored);
      List<Models.HermesChatProfile> result = new ArrayList<>();
      for (int index = 0; index < values.length(); index++) {
        JSONObject value = values.getJSONObject(index);
        String id = value.getString("id").trim().toLowerCase(java.util.Locale.ROOT);
        String label = value.getString("label").trim();
        if (!id.matches("[a-z0-9][a-z0-9_-]{0,63}") || label.isEmpty()
            || label.length() > 40) {
          throw new IllegalArgumentException("invalid profile cache");
        }
        result.add(new Models.HermesChatProfile(id, label));
      }
      return result;
    } catch (Exception error) {
      preferences.edit().remove(KEY_PROFILES).apply();
      return List.of();
    }
  }

  void save(List<Models.HermesChatProfile> profiles) {
    JSONArray values = new JSONArray();
    try {
      for (Models.HermesChatProfile profile : profiles) {
        values.put(new JSONObject().put("id", profile.id).put("label", profile.label));
      }
      preferences.edit().putString(KEY_PROFILES, values.toString()).apply();
    } catch (Exception error) {
      throw new IllegalStateException("无法保存 Hermes 聊天对象缓存。", error);
    }
  }

  Models.HermesChatProfile find(String profileId) {
    for (Models.HermesChatProfile profile : load()) {
      if (profile.id.equals(profileId)) return profile;
    }
    return null;
  }

  void clear() {
    preferences.edit().clear().apply();
  }
}

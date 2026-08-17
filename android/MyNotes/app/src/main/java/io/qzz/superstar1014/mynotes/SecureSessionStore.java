package io.qzz.superstar1014.mynotes;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Base64;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class SecureSessionStore {
  private static final String ANDROID_KEYSTORE = "AndroidKeyStore";
  private static final String KEY_ALIAS = "my-notes-session-cookie-v1";
  private static final String PREFS = "my_notes_secure_session";
  private static final String COOKIE_KEY = "encrypted_cookie";
  private static final String TOKEN_KEY = "encrypted_device_token";
  private static final String HERMES_CHAT_KEY_PREFIX = "encrypted_hermes_chat_key_";

  private final SharedPreferences preferences;
  private final String keyAlias;

  SecureSessionStore(Context context) {
    this(context, PREFS, KEY_ALIAS);
  }

  SecureSessionStore(Context context, String preferencesName, String keyAlias) {
    preferences = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE);
    this.keyAlias = keyAlias;
  }

  String load() {
    return loadEncrypted(COOKIE_KEY, "my-notes:session-cookie:v1");
  }

  String loadDeviceToken() {
    return loadEncrypted(TOKEN_KEY, "my-notes:device-token:v1");
  }

  String loadHermesChatKey(String spaceId) {
    return loadEncrypted(
      chatPreferenceKey(spaceId),
      "my-notes:hermes-chat-key:v1:" + normalizedSpaceId(spaceId)
    );
  }

  private String loadEncrypted(String preferenceKey, String aad) {
    String stored = preferences.getString(preferenceKey, "");
    if (stored.isEmpty()) return "";
    try {
      String[] parts = stored.split("\\.", 2);
      if (parts.length != 2) throw new IllegalArgumentException("Invalid secure session");
      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(
        Cipher.DECRYPT_MODE,
        key(),
        new GCMParameterSpec(128, decode(parts[0]))
      );
      cipher.updateAAD(aad.getBytes(StandardCharsets.UTF_8));
      return new String(cipher.doFinal(decode(parts[1])), StandardCharsets.UTF_8);
    } catch (Exception error) {
      preferences.edit().remove(preferenceKey).apply();
      return "";
    }
  }

  void save(String cookie) {
    saveEncrypted(COOKIE_KEY, "my-notes:session-cookie:v1", cookie);
  }

  void saveDeviceToken(String token) {
    saveEncrypted(TOKEN_KEY, "my-notes:device-token:v1", token);
  }

  void clearDeviceToken() {
    preferences.edit().remove(TOKEN_KEY).apply();
  }

  void saveHermesChatKey(String spaceId, String key) {
    saveEncrypted(
      chatPreferenceKey(spaceId),
      "my-notes:hermes-chat-key:v1:" + normalizedSpaceId(spaceId),
      key
    );
  }

  void clearHermesChatKey(String spaceId) {
    preferences.edit().remove(chatPreferenceKey(spaceId)).apply();
  }

  private void saveEncrypted(String preferenceKey, String aad, String value) {
    if (value == null || value.isEmpty()) {
      preferences.edit().remove(preferenceKey).apply();
      return;
    }
    try {
      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.ENCRYPT_MODE, key());
      cipher.updateAAD(aad.getBytes(StandardCharsets.UTF_8));
      String stored = encode(cipher.getIV()) + "." + encode(
        cipher.doFinal(value.getBytes(StandardCharsets.UTF_8))
      );
      preferences.edit().putString(preferenceKey, stored).apply();
    } catch (Exception error) {
      throw new IllegalStateException("无法安全保存登录状态。", error);
    }
  }

  void clear() {
    preferences.edit().clear().apply();
  }

  private static String chatPreferenceKey(String spaceId) {
    return HERMES_CHAT_KEY_PREFIX + normalizedSpaceId(spaceId);
  }

  private static String normalizedSpaceId(String value) {
    String spaceId = value == null ? "" : value.trim().toLowerCase(java.util.Locale.ROOT);
    if (!spaceId.matches("[a-z0-9][a-z0-9_-]{0,63}")) {
      throw new IllegalArgumentException("Hermes profile id 无效。");
    }
    return spaceId;
  }

  private SecretKey key() throws Exception {
    KeyStore keyStore = KeyStore.getInstance(ANDROID_KEYSTORE);
    keyStore.load(null);
    if (keyStore.containsAlias(keyAlias)) {
      return (SecretKey) keyStore.getKey(keyAlias, null);
    }
    KeyGenerator generator = KeyGenerator.getInstance(
      KeyProperties.KEY_ALGORITHM_AES,
      ANDROID_KEYSTORE
    );
    generator.init(new KeyGenParameterSpec.Builder(
      keyAlias,
      KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
    )
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setKeySize(256)
      .setUserAuthenticationRequired(false)
      .build());
    return generator.generateKey();
  }

  private static String encode(byte[] value) {
    return Base64.getUrlEncoder().withoutPadding().encodeToString(value);
  }

  private static byte[] decode(String value) {
    return Base64.getUrlDecoder().decode(value);
  }
}

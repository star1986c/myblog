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
    String stored = preferences.getString(COOKIE_KEY, "");
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
      cipher.updateAAD("my-notes:session-cookie:v1".getBytes(StandardCharsets.UTF_8));
      return new String(cipher.doFinal(decode(parts[1])), StandardCharsets.UTF_8);
    } catch (Exception error) {
      clear();
      return "";
    }
  }

  void save(String cookie) {
    if (cookie == null || cookie.isEmpty()) {
      clear();
      return;
    }
    try {
      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.ENCRYPT_MODE, key());
      cipher.updateAAD("my-notes:session-cookie:v1".getBytes(StandardCharsets.UTF_8));
      String stored = encode(cipher.getIV()) + "." + encode(
        cipher.doFinal(cookie.getBytes(StandardCharsets.UTF_8))
      );
      preferences.edit().putString(COOKIE_KEY, stored).apply();
    } catch (Exception error) {
      throw new IllegalStateException("无法安全保存登录状态。", error);
    }
  }

  void clear() {
    preferences.edit().remove(COOKIE_KEY).apply();
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

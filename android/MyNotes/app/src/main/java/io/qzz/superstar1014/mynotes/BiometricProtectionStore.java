package io.qzz.superstar1014.mynotes;

import android.app.Activity;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.CancellationSignal;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

final class BiometricProtectionStore {
  private static final String ANDROID_KEYSTORE = "AndroidKeyStore";
  private static final String KEY_ALIAS = "my-notes-protection-biometric-v1";
  private static final String PREFS = "my_notes_biometric_protection";
  private static final String PAYLOAD_KEY = "wrapped_protection_key";
  private static final String BINDING_KEY = "protection_keyring_binding";
  private static final String AAD = "my-notes:biometric-protection-key:v1";

  private final Activity activity;
  private final SharedPreferences preferences;
  private final String keyAlias;

  BiometricProtectionStore(Activity activity) {
    this(activity, PREFS, KEY_ALIAS);
  }

  BiometricProtectionStore(Activity activity, String preferencesName, String keyAlias) {
    this.activity = activity;
    this.preferences = activity.getSharedPreferences(preferencesName, Context.MODE_PRIVATE);
    this.keyAlias = keyAlias;
  }

  boolean isAvailable() {
    BiometricManager manager = activity.getSystemService(BiometricManager.class);
    return manager != null && manager.canAuthenticate(
      BiometricManager.Authenticators.BIOMETRIC_STRONG
    ) == BiometricManager.BIOMETRIC_SUCCESS;
  }

  boolean isConfiguredFor(Models.ProtectionKeyring keyring) {
    if (keyring == null || preferences.getString(PAYLOAD_KEY, "").isEmpty()) return false;
    boolean matches = bindingFor(keyring).equals(preferences.getString(BINDING_KEY, ""));
    if (!matches) clear();
    return matches;
  }

  void enroll(
    Models.ProtectionKeyring keyring,
    SecretKey protectionKey,
    Runnable success,
    Runnable cancelled,
    Consumer<Exception> failure
  ) {
    if (keyring == null || protectionKey == null || protectionKey.getEncoded() == null) {
      failure.accept(new IllegalArgumentException("保护密钥不可用，请重新输入保护密码。"));
      return;
    }
    try {
      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.ENCRYPT_MODE, biometricKey());
      authenticate(
        "启用指纹解锁",
        "验证后可快速查看受保护笔记",
        cipher,
        authenticated -> {
          try {
            authenticated.updateAAD(AAD.getBytes(StandardCharsets.UTF_8));
            String payload = encodePayload(
              authenticated.getIV(),
              authenticated.doFinal(protectionKey.getEncoded())
            );
            preferences.edit()
              .putString(PAYLOAD_KEY, payload)
              .putString(BINDING_KEY, bindingFor(keyring))
              .apply();
            success.run();
          } catch (Exception error) {
            clear();
            failure.accept(new IllegalStateException("无法启用指纹解锁。", error));
          }
        },
        cancelled,
        failure
      );
    } catch (Exception error) {
      clear();
      failure.accept(new IllegalStateException("无法启用指纹解锁。", error));
    }
  }

  void unlock(
    Models.ProtectionKeyring keyring,
    Consumer<SecretKey> success,
    Runnable cancelled,
    Consumer<Exception> failure
  ) {
    if (!isConfiguredFor(keyring)) {
      failure.accept(new IllegalStateException("请先输入保护密码并启用指纹解锁。"));
      return;
    }
    try {
      WrappedPayload payload = decodePayload(preferences.getString(PAYLOAD_KEY, ""));
      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(
        Cipher.DECRYPT_MODE,
        existingBiometricKey(),
        new GCMParameterSpec(128, payload.iv)
      );
      authenticate(
        "解锁受保护笔记",
        "使用手机指纹验证身份",
        cipher,
        authenticated -> {
          try {
            authenticated.updateAAD(AAD.getBytes(StandardCharsets.UTF_8));
            byte[] rawKey = authenticated.doFinal(payload.ciphertext);
            if (rawKey.length != 32) throw new IllegalStateException("保护密钥长度无效。" );
            success.accept(new SecretKeySpec(rawKey, "AES"));
          } catch (Exception error) {
            clear();
            failure.accept(new IllegalStateException("指纹快捷解锁已失效，请输入保护密码重新启用。", error));
          }
        },
        cancelled,
        failure
      );
    } catch (KeyPermanentlyInvalidatedException error) {
      clear();
      failure.accept(new IllegalStateException("手机指纹已变化，请输入保护密码重新启用。", error));
    } catch (Exception error) {
      clear();
      failure.accept(new IllegalStateException("指纹快捷解锁已失效，请输入保护密码重新启用。", error));
    }
  }

  void clear() {
    preferences.edit().clear().apply();
    try {
      KeyStore keyStore = KeyStore.getInstance(ANDROID_KEYSTORE);
      keyStore.load(null);
      if (keyStore.containsAlias(keyAlias)) keyStore.deleteEntry(keyAlias);
    } catch (Exception ignored) {
      // Removing local preferences is sufficient to make the wrapped key inaccessible.
    }
  }

  static String bindingFor(Models.ProtectionKeyring keyring) {
    try {
      String value = keyring.id + ":" + keyring.version + ":" + keyring.revision
        + ":" + keyring.wrappedKey + ":" + keyring.nonce;
      return encode(MessageDigest.getInstance("SHA-256").digest(
        value.getBytes(StandardCharsets.UTF_8)
      ));
    } catch (Exception error) {
      throw new IllegalStateException("无法验证保护密钥版本。", error);
    }
  }

  static String encodePayload(byte[] iv, byte[] ciphertext) {
    if (iv == null || iv.length != 12 || ciphertext == null || ciphertext.length != 48) {
      throw new IllegalArgumentException("指纹保护数据无效。" );
    }
    return "v1." + encode(iv) + "." + encode(ciphertext);
  }

  static WrappedPayload decodePayload(String value) {
    if (value == null) throw new IllegalArgumentException("指纹保护数据无效。" );
    String[] parts = value.split("\\.", 3);
    if (parts.length != 3 || !"v1".equals(parts[0])) {
      throw new IllegalArgumentException("指纹保护数据无效。" );
    }
    byte[] iv = decode(parts[1]);
    byte[] ciphertext = decode(parts[2]);
    if (iv.length != 12 || ciphertext.length != 48) {
      throw new IllegalArgumentException("指纹保护数据无效。" );
    }
    return new WrappedPayload(iv, ciphertext);
  }

  private void authenticate(
    String title,
    String subtitle,
    Cipher cipher,
    Consumer<Cipher> success,
    Runnable cancelled,
    Consumer<Exception> failure
  ) {
    Executor mainExecutor = activity.getMainExecutor();
    CancellationSignal cancellationSignal = new CancellationSignal();
    AtomicBoolean completed = new AtomicBoolean(false);
    BiometricPrompt prompt = new BiometricPrompt.Builder(activity)
      .setTitle(title)
      .setSubtitle(subtitle)
      .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
      .setNegativeButton("取消", mainExecutor, (dialog, which) -> {
        if (completed.compareAndSet(false, true)) cancelled.run();
      })
      .build();
    prompt.authenticate(
      new BiometricPrompt.CryptoObject(cipher),
      cancellationSignal,
      mainExecutor,
      new BiometricPrompt.AuthenticationCallback() {
        @Override
        public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
          if (!completed.compareAndSet(false, true)) return;
          BiometricPrompt.CryptoObject cryptoObject = result.getCryptoObject();
          if (cryptoObject == null || cryptoObject.getCipher() == null) {
            failure.accept(new IllegalStateException("系统未返回已授权的加密操作。"));
            return;
          }
          success.accept(cryptoObject.getCipher());
        }

        @Override
        public void onAuthenticationError(int errorCode, CharSequence errorString) {
          if (!completed.compareAndSet(false, true)) return;
          if (errorCode == BiometricPrompt.BIOMETRIC_ERROR_CANCELED
            || errorCode == BiometricPrompt.BIOMETRIC_ERROR_USER_CANCELED) {
            cancelled.run();
          } else {
            failure.accept(new IllegalStateException(errorString.toString()));
          }
        }
      }
    );
  }

  private SecretKey biometricKey() throws Exception {
    KeyStore keyStore = KeyStore.getInstance(ANDROID_KEYSTORE);
    keyStore.load(null);
    if (keyStore.containsAlias(keyAlias)) return (SecretKey) keyStore.getKey(keyAlias, null);
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
      .setUserAuthenticationRequired(true)
      .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
      .setInvalidatedByBiometricEnrollment(true)
      .build());
    return generator.generateKey();
  }

  private SecretKey existingBiometricKey() throws Exception {
    KeyStore keyStore = KeyStore.getInstance(ANDROID_KEYSTORE);
    keyStore.load(null);
    SecretKey key = (SecretKey) keyStore.getKey(keyAlias, null);
    if (key == null) throw new IllegalStateException("本机指纹密钥不存在。" );
    return key;
  }

  private static String encode(byte[] value) {
    return Base64.getUrlEncoder().withoutPadding().encodeToString(value);
  }

  private static byte[] decode(String value) {
    return Base64.getUrlDecoder().decode(value);
  }

  static final class WrappedPayload {
    final byte[] iv;
    final byte[] ciphertext;

    WrappedPayload(byte[] iv, byte[] ciphertext) {
      this.iv = iv;
      this.ciphertext = ciphertext;
    }
  }
}

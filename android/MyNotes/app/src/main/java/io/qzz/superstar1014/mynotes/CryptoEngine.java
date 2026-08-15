package io.qzz.superstar1014.mynotes;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.Base64;

import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.PBEKeySpec;
import javax.crypto.spec.SecretKeySpec;

final class CryptoEngine {
  private static final int VERSION = 1;
  private static final int NONCE_BYTES = 12;
  private static final int TAG_BITS = 128;
  private static final int KEY_BYTES = 32;
  private static final int PROTECTION_ITERATIONS = 310_000;
  private static final SecureRandom RANDOM = new SecureRandom();

  private CryptoEngine() {}

  static SecretKey importDataKey(String value) {
    byte[] key = decode(value);
    if (key.length != KEY_BYTES) throw new IllegalArgumentException("工作区密钥无效。");
    return new SecretKeySpec(key, "AES");
  }

  static JSONObject encryptNote(SecretKey key, String id, Models.NoteContent content)
    throws Exception {
    byte[] nonce = randomBytes(NONCE_BYTES);
    byte[] plaintext = content.toEncryptedJson().toString().getBytes(StandardCharsets.UTF_8);
    byte[] encrypted = seal(key, nonce, noteAad(id, VERSION), plaintext);
    return new JSONObject()
      .put("id", id)
      .put("version", VERSION)
      .put("ciphertext", encode(encrypted))
      .put("nonce", encode(nonce))
      .put("isLocked", content.protectedContent != null);
  }

  static Models.NoteContent decryptNote(SecretKey key, Models.NoteEnvelope envelope)
    throws Exception {
    requireEnvelope(envelope.version, envelope.nonce, envelope.ciphertext);
    byte[] plaintext = open(
      key,
      decode(envelope.nonce),
      noteAad(envelope.id, envelope.version),
      decode(envelope.ciphertext)
    );
    return Models.NoteContent.fromJson(new JSONObject(new String(plaintext, StandardCharsets.UTF_8)));
  }

  static JSONObject encryptFolder(SecretKey key, String id, String name) throws Exception {
    String normalized = name == null ? "" : name.trim();
    if (normalized.length() > 80) normalized = normalized.substring(0, 80);
    byte[] nonce = randomBytes(NONCE_BYTES);
    byte[] plaintext = new JSONObject().put("name", normalized).toString()
      .getBytes(StandardCharsets.UTF_8);
    return new JSONObject()
      .put("id", id)
      .put("version", VERSION)
      .put("ciphertext", encode(seal(key, nonce, folderAad(id, VERSION), plaintext)))
      .put("nonce", encode(nonce));
  }

  static String decryptFolder(SecretKey key, Models.FolderEnvelope envelope) throws Exception {
    requireEnvelope(envelope.version, envelope.nonce, envelope.ciphertext);
    byte[] plaintext = open(
      key,
      decode(envelope.nonce),
      folderAad(envelope.id, envelope.version),
      decode(envelope.ciphertext)
    );
    String value = new JSONObject(new String(plaintext, StandardCharsets.UTF_8)).optString("name").trim();
    return value.isEmpty() ? "未命名文件夹" : value;
  }

  static ProtectionSetup createProtectionKeyring(String password) throws Exception {
    if (password == null || password.length() < 12) {
      throw new IllegalArgumentException("保护密码至少需要 12 个字符。");
    }
    byte[] rawKey = randomBytes(KEY_BYTES);
    byte[] salt = randomBytes(16);
    byte[] nonce = randomBytes(NONCE_BYTES);
    SecretKey wrappingKey = new SecretKeySpec(
      pbkdf2(password, salt, PROTECTION_ITERATIONS, KEY_BYTES),
      "AES"
    );
    byte[] wrapped = seal(
      wrappingKey,
      nonce,
      "ai-build-lab:note-protection-key:v1".getBytes(StandardCharsets.UTF_8),
      rawKey
    );
    JSONObject payload = new JSONObject()
      .put("id", "notes-protection")
      .put("version", 1)
      .put("kdf", "PBKDF2-SHA256")
      .put("iterations", PROTECTION_ITERATIONS)
      .put("salt", encode(salt))
      .put("wrappedKey", encode(wrapped))
      .put("nonce", encode(nonce));
    return new ProtectionSetup(payload, new SecretKeySpec(rawKey, "AES"));
  }

  static SecretKey unlockProtectionKeyring(Models.ProtectionKeyring keyring, String password)
    throws Exception {
    if (!"notes-protection".equals(keyring.id)
      || keyring.version != 1
      || !"PBKDF2-SHA256".equals(keyring.kdf)
      || keyring.iterations < 100_000
      || keyring.iterations > 2_000_000) {
      throw new IllegalArgumentException("保护密钥元数据无效。");
    }
    byte[] salt = decode(keyring.salt);
    byte[] nonce = decode(keyring.nonce);
    byte[] wrapped = decode(keyring.wrappedKey);
    if (salt.length != 16 || nonce.length != NONCE_BYTES || wrapped.length != 48) {
      throw new IllegalArgumentException("保护密钥元数据无效。");
    }
    SecretKey wrappingKey = new SecretKeySpec(
      pbkdf2(password, salt, keyring.iterations, KEY_BYTES),
      "AES"
    );
    try {
      byte[] rawKey = open(
        wrappingKey,
        nonce,
        "ai-build-lab:note-protection-key:v1".getBytes(StandardCharsets.UTF_8),
        wrapped
      );
      if (rawKey.length != KEY_BYTES) throw new GeneralSecurityException("Bad key length");
      return new SecretKeySpec(rawKey, "AES");
    } catch (GeneralSecurityException exception) {
      throw new IllegalArgumentException("保护密码不正确。");
    }
  }

  static Models.ProtectedBody encryptProtectedBody(SecretKey key, String id, String content)
    throws Exception {
    return encryptProtectedBody(key, id, content, null);
  }

  static Models.ProtectedBody encryptProtectedBody(
    SecretKey key,
    String id,
    String content,
    String attachmentKey
  ) throws Exception {
    String value = content == null ? "" : content;
    if (value.length() > Models.MAX_CONTENT_LENGTH) {
      value = value.substring(0, Models.MAX_CONTENT_LENGTH);
    }
    byte[] plaintext = attachmentKey == null
      ? value.getBytes(StandardCharsets.UTF_8)
      : new JSONObject()
        .put("content", value)
        .put("attachmentKey", attachmentKey)
        .toString()
        .getBytes(StandardCharsets.UTF_8);
    byte[] nonce = randomBytes(NONCE_BYTES);
    byte[] encrypted = seal(
      key,
      nonce,
      protectedBodyAad(id),
      plaintext
    );
    return new Models.ProtectedBody(1, encode(encrypted), encode(nonce));
  }

  static String decryptProtectedBody(
    SecretKey key,
    String id,
    Models.ProtectedBody protectedBody
  ) throws Exception {
    return decryptProtectedPayload(key, id, protectedBody).content;
  }

  static Models.ProtectedPlaintext decryptProtectedPayload(
    SecretKey key,
    String id,
    Models.ProtectedBody protectedBody
  ) throws Exception {
    requireEnvelope(protectedBody.version, protectedBody.nonce, protectedBody.ciphertext);
    String value = new String(
      open(
        key,
        decode(protectedBody.nonce),
        protectedBodyAad(id),
        decode(protectedBody.ciphertext)
      ),
      StandardCharsets.UTF_8
    );
    if (value.startsWith("{")) {
      try {
        JSONObject json = new JSONObject(value);
        if (json.has("content")) {
          return new Models.ProtectedPlaintext(
            json.optString("content"),
            json.isNull("attachmentKey") ? null : json.optString("attachmentKey", null)
          );
        }
      } catch (Exception ignored) {
        // Legacy protected note bodies are plain UTF-8 strings.
      }
    }
    return new Models.ProtectedPlaintext(value, null);
  }

  static String createMediaKey() {
    return encode(randomBytes(KEY_BYTES));
  }

  static EncryptedAttachment encryptAttachment(
    byte[] mediaData,
    String contentType,
    int pixelWidth,
    int pixelHeight,
    int durationMillis,
    String noteId,
    String attachmentId,
    boolean locked,
    String mediaKeyValue
  ) throws Exception {
    if (!isSupportedAttachmentType(contentType)) {
      throw new IllegalArgumentException("不支持这种附件格式。");
    }
    if (mediaData == null || mediaData.length == 0 || mediaData.length > Models.MAX_ATTACHMENT_BYTES) {
      throw new IllegalArgumentException("单个附件不能超过 10 MiB。");
    }
    if ("audio/mp4".equals(contentType) && (durationMillis <= 0 || durationMillis > 300_000)) {
      throw new IllegalArgumentException("单段录音最长 5 分钟。");
    }
    SecretKey mediaKey = importDataKey(mediaKeyValue);
    byte[] attachmentKey = randomBytes(KEY_BYTES);
    byte[] objectNonce = randomBytes(NONCE_BYTES);
    byte[] encryptedBody = seal(
      new SecretKeySpec(attachmentKey, "AES"),
      objectNonce,
      attachmentContentAad(noteId, attachmentId),
      mediaData
    );
    Models.AttachmentMetadata metadata = new Models.AttachmentMetadata(
      contentType,
      Math.max(1, pixelWidth),
      Math.max(1, pixelHeight),
      mediaData.length,
      Math.max(0, durationMillis),
      encode(objectNonce),
      encode(attachmentKey)
    );
    byte[] metadataNonce = randomBytes(NONCE_BYTES);
    byte[] encryptedMetadata = seal(
      mediaKey,
      metadataNonce,
      attachmentMetadataAad(noteId, attachmentId),
      metadata.toJson().toString().getBytes(StandardCharsets.UTF_8)
    );
    JSONObject payload = new JSONObject()
      .put("id", attachmentId)
      .put("noteId", noteId)
      .put("version", VERSION)
      .put("ciphertext", encode(encryptedMetadata))
      .put("nonce", encode(metadataNonce))
      .put("isLocked", locked);
    return new EncryptedAttachment(payload, encryptedBody, metadata);
  }

  static Models.AttachmentMetadata decryptAttachmentMetadata(
    String mediaKeyValue,
    Models.AttachmentEnvelope envelope
  ) throws Exception {
    requireEnvelope(envelope.version, envelope.nonce, envelope.ciphertext);
    byte[] plaintext = open(
      importDataKey(mediaKeyValue),
      decode(envelope.nonce),
      attachmentMetadataAad(envelope.noteId, envelope.id),
      decode(envelope.ciphertext)
    );
    Models.AttachmentMetadata metadata = Models.AttachmentMetadata.fromJson(
      new JSONObject(new String(plaintext, StandardCharsets.UTF_8))
    );
    if (!isSupportedAttachmentType(metadata.contentType)
      || metadata.plaintextBytes <= 0
      || metadata.plaintextBytes > Models.MAX_ATTACHMENT_BYTES
      || ("audio/mp4".equals(metadata.contentType)
        && (metadata.durationMillis <= 0 || metadata.durationMillis > 300_000))
      || decode(metadata.objectNonce).length != NONCE_BYTES
      || decode(metadata.dataKey).length != KEY_BYTES) {
      throw new IllegalArgumentException("加密附件格式无效。");
    }
    return metadata;
  }

  static byte[] decryptAttachmentBody(
    byte[] encryptedBody,
    Models.AttachmentEnvelope envelope,
    Models.AttachmentMetadata metadata
  ) throws Exception {
    if (encryptedBody == null || encryptedBody.length != envelope.ciphertextBytes) {
      throw new IllegalArgumentException("加密附件格式无效。");
    }
    byte[] plaintext = open(
      new SecretKeySpec(decode(metadata.dataKey), "AES"),
      decode(metadata.objectNonce),
      attachmentContentAad(envelope.noteId, envelope.id),
      encryptedBody
    );
    if (plaintext.length != metadata.plaintextBytes) {
      throw new IllegalArgumentException("加密附件格式无效。");
    }
    return plaintext;
  }

  private static byte[] seal(SecretKey key, byte[] nonce, byte[] aad, byte[] plaintext)
    throws GeneralSecurityException {
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, nonce));
    cipher.updateAAD(aad);
    return cipher.doFinal(plaintext);
  }

  private static byte[] open(SecretKey key, byte[] nonce, byte[] aad, byte[] encrypted)
    throws GeneralSecurityException {
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, nonce));
    cipher.updateAAD(aad);
    return cipher.doFinal(encrypted);
  }

  private static byte[] pbkdf2(String password, byte[] salt, int iterations, int length)
    throws GeneralSecurityException {
    PBEKeySpec spec = new PBEKeySpec(password.toCharArray(), salt, iterations, length * 8);
    try {
      return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
        .generateSecret(spec)
        .getEncoded();
    } finally {
      spec.clearPassword();
    }
  }

  private static void requireEnvelope(int version, String nonce, String ciphertext) {
    if (version != VERSION || decode(nonce).length != NONCE_BYTES || decode(ciphertext).length <= 16) {
      throw new IllegalArgumentException("加密数据格式无效。");
    }
  }

  private static byte[] noteAad(String id, int version) {
    return ("ai-build-lab:encrypted-note:" + id + ":v" + version)
      .getBytes(StandardCharsets.UTF_8);
  }

  private static byte[] folderAad(String id, int version) {
    return ("ai-build-lab:encrypted-folder:" + id + ":v" + version)
      .getBytes(StandardCharsets.UTF_8);
  }

  private static byte[] protectedBodyAad(String id) {
    return ("ai-build-lab:protected-note-body:" + id + ":v1")
      .getBytes(StandardCharsets.UTF_8);
  }

  private static byte[] attachmentMetadataAad(String noteId, String attachmentId) {
    return ("my-notes:attachment-metadata:" + noteId + ":" + attachmentId + ":v1")
      .getBytes(StandardCharsets.UTF_8);
  }

  private static byte[] attachmentContentAad(String noteId, String attachmentId) {
    return ("my-notes:attachment-content:" + noteId + ":" + attachmentId + ":v1")
      .getBytes(StandardCharsets.UTF_8);
  }

  private static boolean isSupportedAttachmentType(String value) {
    return "image/jpeg".equals(value) || "image/png".equals(value)
      || "image/webp".equals(value) || "audio/mp4".equals(value);
  }

  private static byte[] randomBytes(int count) {
    byte[] result = new byte[count];
    RANDOM.nextBytes(result);
    return result;
  }

  static String encode(byte[] value) {
    return Base64.getUrlEncoder().withoutPadding().encodeToString(value);
  }

  static byte[] decode(String value) {
    if (value == null || value.isEmpty() || !value.matches("[A-Za-z0-9_-]+")) {
      throw new IllegalArgumentException("Base64URL 数据无效。");
    }
    return Base64.getUrlDecoder().decode(value);
  }

  static final class ProtectionSetup {
    final JSONObject payload;
    final SecretKey key;

    ProtectionSetup(JSONObject payload, SecretKey key) {
      this.payload = payload;
      this.key = key;
    }
  }

  static final class EncryptedAttachment {
    final JSONObject payload;
    final byte[] body;
    final Models.AttachmentMetadata metadata;

    EncryptedAttachment(JSONObject payload, byte[] body, Models.AttachmentMetadata metadata) {
      this.payload = payload;
      this.body = body;
      this.metadata = metadata;
    }
  }
}

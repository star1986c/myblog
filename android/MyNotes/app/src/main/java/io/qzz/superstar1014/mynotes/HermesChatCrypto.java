package io.qzz.superstar1014.mynotes;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.UUID;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

final class HermesChatCrypto {
  static final int MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
  private static final SecureRandom RANDOM = new SecureRandom();

  private final SecretKeySpec key;

  HermesChatCrypto(String encodedKey) {
    byte[] raw;
    try {
      raw = Base64.getUrlDecoder().decode(encodedKey == null ? "" : encodedKey.trim());
    } catch (IllegalArgumentException error) {
      throw new IllegalArgumentException("聊天密钥不是有效的 Base64URL。", error);
    }
    if (raw.length != 32) throw new IllegalArgumentException("聊天密钥必须正好包含 32 字节。");
    key = new SecretKeySpec(raw, "AES");
  }

  static String generateKey() {
    byte[] raw = new byte[32];
    RANDOM.nextBytes(raw);
    return encode(raw);
  }

  JSONObject encryptMessage(
    String sender,
    String text,
    JSONArray attachments,
    String messageId,
    long sentAt
  ) throws Exception {
    return encryptMessage(sender, text, attachments, messageId, sentAt, 0, false);
  }

  JSONObject encryptMessage(
    String sender,
    String text,
    JSONArray attachments,
    String messageId,
    long sentAt,
    long replaceSequence,
    boolean finalUpdate
  ) throws Exception {
    if (!"client".equals(sender) && !"agent".equals(sender)) {
      throw new IllegalArgumentException("消息发送者无效。");
    }
    JSONObject plaintext = new JSONObject()
      .put("text", text == null ? "" : text)
      .put("attachments", attachments == null ? new JSONArray() : attachments);
    if (replaceSequence > 0) {
      plaintext.put("replaceSeq", replaceSequence).put("final", finalUpdate);
    } else if (replaceSequence < 0) {
      throw new IllegalArgumentException("消息替换序号无效。");
    }
    byte[] nonce = new byte[12];
    RANDOM.nextBytes(nonce);
    byte[] ciphertext = crypt(
      Cipher.ENCRYPT_MODE,
      plaintext.toString().getBytes(StandardCharsets.UTF_8),
      nonce,
      messageAad(messageId, sender, sentAt)
    );
    return new JSONObject()
      .put("v", 1)
      .put("type", "message")
      .put("id", messageId)
      .put("sender", sender)
      .put("sentAt", sentAt)
      .put("encrypted", new JSONObject()
        .put("alg", "A256GCM")
        .put("nonce", encode(nonce))
        .put("ciphertext", encode(ciphertext)));
  }

  ChatMessage decryptMessage(JSONObject envelope, long sequence) throws Exception {
    if (envelope.optInt("v") != 1 || !"message".equals(envelope.optString("type"))) {
      throw new IllegalArgumentException("收到不支持的聊天消息。");
    }
    String sender = envelope.optString("sender");
    if (!"client".equals(sender) && !"agent".equals(sender)) {
      throw new IllegalArgumentException("聊天消息发送者无效。");
    }
    String messageId = envelope.getString("id");
    long sentAt = envelope.getLong("sentAt");
    JSONObject encrypted = envelope.getJSONObject("encrypted");
    if (!"A256GCM".equals(encrypted.optString("alg"))) {
      throw new IllegalArgumentException("不支持此聊天加密格式。");
    }
    byte[] plaintext = crypt(
      Cipher.DECRYPT_MODE,
      decode(encrypted.getString("ciphertext")),
      decode(encrypted.getString("nonce")),
      messageAad(messageId, sender, sentAt)
    );
    JSONObject payload = new JSONObject(new String(plaintext, StandardCharsets.UTF_8));
    long replaceSequence = payload.has("replaceSeq") ? payload.getLong("replaceSeq") : 0;
    boolean finalUpdate = payload.has("final") && payload.getBoolean("final");
    if ((payload.has("replaceSeq") || payload.has("final"))
        && (replaceSequence < 1 || !payload.has("replaceSeq") || !payload.has("final"))) {
      throw new IllegalArgumentException("消息替换元数据无效。");
    }
    return new ChatMessage(
      messageId,
      sender,
      sentAt,
      sequence,
      payload.optString("text"),
      payload.optJSONArray("attachments") == null
        ? new JSONArray()
        : payload.getJSONArray("attachments"),
      replaceSequence,
      finalUpdate
    );
  }

  EncryptedAttachment encryptAttachment(
    byte[] plaintext,
    String contentType,
    String filename
  ) throws Exception {
    if (plaintext == null || plaintext.length < 1 || plaintext.length > MAX_ATTACHMENT_BYTES) {
      throw new IllegalArgumentException("图片大小必须在 10 MiB 以内。");
    }
    String attachmentId = UUID.randomUUID().toString();
    String safeType = safeContentType(contentType);
    byte[] nonce = new byte[12];
    RANDOM.nextBytes(nonce);
    byte[] ciphertext = crypt(
      Cipher.ENCRYPT_MODE,
      plaintext,
      nonce,
      attachmentAad(attachmentId, safeType, plaintext.length)
    );
    JSONObject descriptor = new JSONObject()
      .put("id", attachmentId)
      .put("name", safeFilename(filename))
      .put("contentType", safeType)
      .put("plaintextBytes", plaintext.length)
      .put("nonce", encode(nonce));
    return new EncryptedAttachment(descriptor, ciphertext);
  }

  byte[] decryptAttachment(byte[] ciphertext, JSONObject descriptor) throws Exception {
    String attachmentId = descriptor.getString("id");
    String contentType = safeContentType(descriptor.getString("contentType"));
    int plaintextBytes = descriptor.getInt("plaintextBytes");
    if (plaintextBytes < 1 || plaintextBytes > MAX_ATTACHMENT_BYTES) {
      throw new IllegalArgumentException("图片大小无效。");
    }
    byte[] plaintext = crypt(
      Cipher.DECRYPT_MODE,
      ciphertext,
      decode(descriptor.getString("nonce")),
      attachmentAad(attachmentId, contentType, plaintextBytes)
    );
    if (plaintext.length != plaintextBytes) throw new IllegalArgumentException("图片完整性校验失败。");
    return plaintext;
  }

  JSONObject encryptLocalSnapshot(JSONObject payload, String spaceId) throws Exception {
    byte[] nonce = new byte[12];
    RANDOM.nextBytes(nonce);
    byte[] ciphertext = crypt(
      Cipher.ENCRYPT_MODE,
      payload.toString().getBytes(StandardCharsets.UTF_8),
      nonce,
      localSnapshotAad(spaceId)
    );
    return new JSONObject()
      .put("v", 1)
      .put("alg", "A256GCM")
      .put("nonce", encode(nonce))
      .put("ciphertext", encode(ciphertext));
  }

  JSONObject decryptLocalSnapshot(JSONObject envelope, String spaceId) throws Exception {
    if (envelope.optInt("v") != 1 || !"A256GCM".equals(envelope.optString("alg"))) {
      throw new IllegalArgumentException("本地聊天缓存格式无效。");
    }
    byte[] plaintext = crypt(
      Cipher.DECRYPT_MODE,
      decode(envelope.getString("ciphertext")),
      decode(envelope.getString("nonce")),
      localSnapshotAad(spaceId)
    );
    return new JSONObject(new String(plaintext, StandardCharsets.UTF_8));
  }

  private byte[] crypt(int mode, byte[] input, byte[] nonce, byte[] aad) throws Exception {
    if (nonce.length != 12) throw new IllegalArgumentException("AES-GCM nonce 长度无效。");
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(mode, key, new GCMParameterSpec(128, nonce));
    cipher.updateAAD(aad);
    return cipher.doFinal(input);
  }

  private static byte[] messageAad(String id, String sender, long sentAt) {
    return ("hermes-chat-message-v1|" + id + "|" + sender + "|" + sentAt)
      .getBytes(StandardCharsets.UTF_8);
  }

  private static byte[] attachmentAad(String id, String contentType, int bytes) {
    return ("hermes-chat-attachment-v1|" + id + "|" + contentType + "|" + bytes)
      .getBytes(StandardCharsets.UTF_8);
  }

  private static byte[] localSnapshotAad(String spaceId) {
    String normalized = spaceId == null
      ? ""
      : spaceId.trim().toLowerCase(java.util.Locale.ROOT);
    if (!normalized.matches("[a-z0-9][a-z0-9_-]{0,63}")) {
      throw new IllegalArgumentException("Hermes profile id 无效。");
    }
    return ("hermes-chat-local-cache-v1|" + normalized).getBytes(StandardCharsets.UTF_8);
  }

  private static String safeFilename(String value) {
    String filename = value == null ? "image" : value.replaceAll("[^\\p{L}\\p{N}._ -]", "_");
    filename = filename.replaceAll("^[ .]+|[ .]+$", "");
    if (filename.isEmpty()) filename = "image";
    return filename.length() > 120 ? filename.substring(0, 120) : filename;
  }

  private static String safeContentType(String value) {
    String contentType = value == null
      ? "application/octet-stream"
      : value.trim().toLowerCase(java.util.Locale.ROOT);
    if (contentType.length() > 100 || !contentType.matches("[a-z0-9!#$&^_.+\\-/]+")) {
      throw new IllegalArgumentException("图片类型无效。");
    }
    return contentType;
  }

  private static String encode(byte[] value) {
    return Base64.getUrlEncoder().withoutPadding().encodeToString(value);
  }

  private static byte[] decode(String value) {
    return Base64.getUrlDecoder().decode(value);
  }

  static final class ChatMessage {
    final String id;
    final String sender;
    final long sentAt;
    long sequence;
    final String text;
    final JSONArray attachments;
    final long replaceSequence;
    final boolean finalUpdate;

    ChatMessage(
      String id,
      String sender,
      long sentAt,
      long sequence,
      String text,
      JSONArray attachments
    ) {
      this(id, sender, sentAt, sequence, text, attachments, 0, false);
    }

    ChatMessage(
      String id,
      String sender,
      long sentAt,
      long sequence,
      String text,
      JSONArray attachments,
      long replaceSequence,
      boolean finalUpdate
    ) {
      this.id = id;
      this.sender = sender;
      this.sentAt = sentAt;
      this.sequence = sequence;
      this.text = text;
      this.attachments = attachments;
      this.replaceSequence = replaceSequence;
      this.finalUpdate = finalUpdate;
    }
  }

  static final class EncryptedAttachment {
    final JSONObject descriptor;
    final byte[] ciphertext;

    EncryptedAttachment(JSONObject descriptor, byte[] ciphertext) {
      this.descriptor = descriptor;
      this.ciphertext = ciphertext;
    }
  }
}

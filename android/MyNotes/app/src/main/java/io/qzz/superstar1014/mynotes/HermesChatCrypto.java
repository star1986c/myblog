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
  static final int MAX_AGENT_ATTACHMENT_BYTES = 512 * 1024 * 1024;
  static final String PRIVATE_ATTACHMENT_STORAGE = "r2-private-v1";
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
    JSONArray safeAttachments = attachments == null ? new JSONArray() : attachments;
    validateAttachmentList(safeAttachments, sender);
    JSONObject plaintext = new JSONObject()
      .put("text", text == null ? "" : text)
      .put("attachments", safeAttachments);
    if (replaceSequence > 0) {
      plaintext.put("replaceSeq", replaceSequence).put("final", finalUpdate);
    } else if (replaceSequence < 0) {
      throw new IllegalArgumentException("消息替换序号无效。");
    }
    return encryptPayload(sender, messageId, sentAt, plaintext);
  }

  JSONObject encryptInteractionResponse(
    String promptId,
    String optionId,
    String messageId,
    long sentAt
  ) throws Exception {
    requireUuid(promptId, "交互请求 id 无效。");
    if (!isInteractionToken(optionId, 64)) {
      throw new IllegalArgumentException("交互选项 id 无效。");
    }
    JSONObject plaintext = new JSONObject()
      .put("text", "")
      .put("attachments", new JSONArray())
      .put("interactionResponse", new JSONObject()
        .put("promptId", promptId)
        .put("optionId", optionId));
    return encryptPayload("client", messageId, sentAt, plaintext);
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
    JSONObject interaction = payload.optJSONObject("interaction");
    if (interaction != null) {
      if (!"agent".equals(sender)) {
        throw new IllegalArgumentException("仅 Hermes 可以发送交互操作。");
      }
      interaction = validateInteraction(interaction);
    }
    long replaceSequence = payload.has("replaceSeq") ? payload.getLong("replaceSeq") : 0;
    boolean finalUpdate = payload.has("final") && payload.getBoolean("final");
    if ((payload.has("replaceSeq") || payload.has("final"))
        && (replaceSequence < 1 || !payload.has("replaceSeq") || !payload.has("final"))) {
      throw new IllegalArgumentException("消息替换元数据无效。");
    }
    JSONArray attachments = payload.optJSONArray("attachments") == null
      ? new JSONArray()
      : payload.getJSONArray("attachments");
    validateAttachmentList(attachments, sender);
    return new ChatMessage(
      messageId,
      sender,
      sentAt,
      sequence,
      payload.optString("text"),
      attachments,
      interaction == null ? new JSONObject() : interaction,
      replaceSequence,
      finalUpdate
    );
  }

  private JSONObject encryptPayload(
    String sender,
    String messageId,
    long sentAt,
    JSONObject plaintext
  ) throws Exception {
    requireUuid(messageId, "消息 id 无效。");
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

  EncryptedAttachment encryptAttachment(
    byte[] plaintext,
    String contentType,
    String filename
  ) throws Exception {
    if (plaintext == null || plaintext.length < 1 || plaintext.length > MAX_ATTACHMENT_BYTES) {
      throw new IllegalArgumentException("附件大小必须在 10 MiB 以内。");
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
    validateAttachmentDescriptor(descriptor, "client");
    String attachmentId = descriptor.getString("id");
    String contentType = safeContentType(descriptor.getString("contentType"));
    int plaintextBytes = descriptor.getInt("plaintextBytes");
    if (plaintextBytes < 1 || plaintextBytes > MAX_ATTACHMENT_BYTES) {
      throw new IllegalArgumentException("附件大小无效。");
    }
    byte[] plaintext = crypt(
      Cipher.DECRYPT_MODE,
      ciphertext,
      decode(descriptor.getString("nonce")),
      attachmentAad(attachmentId, contentType, plaintextBytes)
    );
    if (plaintext.length != plaintextBytes) {
      throw new IllegalArgumentException("附件完整性校验失败。");
    }
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
    String filename = value == null ? "attachment" : value.replaceAll("[^\\p{L}\\p{N}._ -]", "_");
    filename = filename.replaceAll("^[ .]+|[ .]+$", "");
    if (filename.isEmpty()) filename = "attachment";
    return filename.length() > 120 ? filename.substring(0, 120) : filename;
  }

  private static String safeContentType(String value) {
    String contentType = value == null
      ? "application/octet-stream"
      : value.split(";", 2)[0].trim().toLowerCase(java.util.Locale.ROOT);
    if (contentType.length() > 100 || !contentType.matches("[a-z0-9!#$&^_.+\\-/]+")) {
      throw new IllegalArgumentException("附件类型无效。");
    }
    return contentType;
  }

  static boolean isPrivateAttachment(JSONObject descriptor) {
    return descriptor != null
      && PRIVATE_ATTACHMENT_STORAGE.equals(descriptor.optString("storage"));
  }

  static void validateAttachmentDescriptor(JSONObject descriptor, String sender) throws Exception {
    if (descriptor == null) throw new IllegalArgumentException("附件描述无效。");
    requireUuid(descriptor.getString("id"), "附件 id 无效。");
    String name = descriptor.getString("name");
    String contentType = descriptor.getString("contentType");
    if (name.isEmpty() || name.length() > 120 || !safeContentType(contentType).equals(contentType)) {
      throw new IllegalArgumentException("附件元数据无效。");
    }
    int plaintextBytes = descriptor.getInt("plaintextBytes");
    if (isPrivateAttachment(descriptor)) {
      String sha256 = descriptor.optString("sha256");
      if (!"agent".equals(sender)
          || plaintextBytes <= MAX_ATTACHMENT_BYTES
          || plaintextBytes > MAX_AGENT_ATTACHMENT_BYTES
          || !sha256.matches("[0-9a-f]{64}")
          || (!descriptor.optString("nonce").isEmpty())) {
        throw new IllegalArgumentException("Hermes 大附件描述无效。");
      }
      return;
    }
    String storage = descriptor.optString("storage");
    if ((!storage.isEmpty() && !"encrypted-v1".equals(storage))
        || plaintextBytes < 1
        || plaintextBytes > MAX_ATTACHMENT_BYTES
        || decode(descriptor.getString("nonce")).length != 12
        || !descriptor.optString("sha256").isEmpty()) {
      throw new IllegalArgumentException("加密附件描述无效。");
    }
  }

  private static void validateAttachmentList(JSONArray attachments, String sender) throws Exception {
    if (attachments.length() > 8) throw new IllegalArgumentException("一条消息最多包含 8 个附件。");
    for (int index = 0; index < attachments.length(); index++) {
      validateAttachmentDescriptor(attachments.getJSONObject(index), sender);
    }
  }

  private static JSONObject validateInteraction(JSONObject value) throws Exception {
    requireUuid(value.getString("id"), "交互请求 id 无效。");
    String kind = value.getString("kind");
    if (!kind.matches("approval|slash_confirm|clarify|model|choice")) {
      throw new IllegalArgumentException("交互类型无效。");
    }
    String state = value.getString("state");
    if (!state.matches("pending|resolved|expired|error")) {
      throw new IllegalArgumentException("交互状态无效。");
    }
    Object expires = value.get("expiresAt");
    if (!(expires instanceof Number) || ((Number) expires).longValue() < 0) {
      throw new IllegalArgumentException("交互过期时间无效。");
    }
    JSONArray options = value.getJSONArray("options");
    if (options.length() > 24 || ("pending".equals(state) && options.length() == 0)) {
      throw new IllegalArgumentException("交互选项数量无效。");
    }
    for (int index = 0; index < options.length(); index++) {
      JSONObject option = options.getJSONObject(index);
      if (!isInteractionToken(option.getString("id"), 64)) {
        throw new IllegalArgumentException("交互选项 id 无效。");
      }
      String label = option.getString("label");
      if (label.isEmpty() || label.length() > 120) {
        throw new IllegalArgumentException("交互选项文字无效。");
      }
      if (!option.optString("style", "default").matches("default|primary|danger|warning")) {
        throw new IllegalArgumentException("交互选项样式无效。");
      }
      for (String flag : new String[] {"selected", "disabled", "wide"}) {
        if (option.has(flag) && !(option.get(flag) instanceof Boolean)) {
          throw new IllegalArgumentException("交互选项状态无效。");
        }
      }
    }
    if (value.optString("stage").length() > 32
        || value.optString("status").length() > 500
        || value.optString("pageInfo").length() > 100) {
      throw new IllegalArgumentException("交互说明文字过长。");
    }
    return new JSONObject(value.toString());
  }

  private static void requireUuid(String value, String message) {
    try {
      if (!UUID.fromString(value).toString().equals(value.toLowerCase(java.util.Locale.ROOT))) {
        throw new IllegalArgumentException(message);
      }
    } catch (Exception error) {
      throw new IllegalArgumentException(message, error);
    }
  }

  private static boolean isInteractionToken(String value, int maximum) {
    return value != null
      && value.length() >= 1
      && value.length() <= maximum
      && value.matches("[A-Za-z0-9_-]+");
  }

  private static JSONObject copyObject(JSONObject value) {
    try {
      return new JSONObject(value == null ? "{}" : value.toString());
    } catch (Exception ignored) {
      return new JSONObject();
    }
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
    final JSONObject interaction;
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
      this(id, sender, sentAt, sequence, text, attachments, new JSONObject(), 0, false);
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
      this(id, sender, sentAt, sequence, text, attachments, new JSONObject(), replaceSequence, finalUpdate);
    }

    ChatMessage(
      String id,
      String sender,
      long sentAt,
      long sequence,
      String text,
      JSONArray attachments,
      JSONObject interaction,
      long replaceSequence,
      boolean finalUpdate
    ) {
      this.id = id;
      this.sender = sender;
      this.sentAt = sentAt;
      this.sequence = sequence;
      this.text = text;
      this.attachments = attachments;
      this.interaction = copyObject(interaction);
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

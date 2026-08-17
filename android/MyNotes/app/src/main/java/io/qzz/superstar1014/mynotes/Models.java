package io.qzz.superstar1014.mynotes;

import org.json.JSONException;
import org.json.JSONArray;
import org.json.JSONObject;

import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.Locale;
import java.util.ArrayList;
import java.util.List;

final class Models {
  private Models() {}

  static final int MAX_TITLE_LENGTH = 200;
  static final int MAX_CONTENT_LENGTH = 500_000;
  static final int MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
  static final int UNKNOWN_ATTACHMENT_COUNT = -1;

  static final class User {
    final String username;
    final boolean mustChangePassword;

    User(String username, boolean mustChangePassword) {
      this.username = username;
      this.mustChangePassword = mustChangePassword;
    }

    static User fromJson(JSONObject json) {
      return new User(json.optString("username"), json.optBoolean("mustChangePassword"));
    }
  }

  static final class HermesChatTicket {
    final String ticket;
    final String spaceId;
    final int expiresInSeconds;

    HermesChatTicket(String ticket, String spaceId, int expiresInSeconds) {
      this.ticket = ticket;
      this.spaceId = spaceId;
      this.expiresInSeconds = expiresInSeconds;
    }

    static HermesChatTicket fromJson(JSONObject json) {
      return new HermesChatTicket(
        json.optString("ticket"),
        json.optString("spaceId", "default"),
        json.optInt("expiresInSeconds", 90)
      );
    }
  }

  static final class HermesChatProfile {
    final String id;
    final String label;

    HermesChatProfile(String id, String label) {
      this.id = id;
      this.label = label;
    }

    static List<HermesChatProfile> listFromJson(JSONObject json) throws JSONException {
      JSONArray values = json.getJSONArray("profiles");
      List<HermesChatProfile> profiles = new ArrayList<>();
      for (int index = 0; index < values.length(); index++) {
        JSONObject value = values.getJSONObject(index);
        profiles.add(new HermesChatProfile(value.getString("id"), value.getString("label")));
      }
      return profiles;
    }
  }

  static final class ProtectedBody {
    final int version;
    final String ciphertext;
    final String nonce;

    ProtectedBody(int version, String ciphertext, String nonce) {
      this.version = version;
      this.ciphertext = ciphertext;
      this.nonce = nonce;
    }

    static ProtectedBody fromJson(JSONObject json) {
      return new ProtectedBody(
        json.optInt("version", 1),
        json.optString("ciphertext"),
        json.optString("nonce")
      );
    }

    JSONObject toJson() throws JSONException {
      return new JSONObject()
        .put("version", version)
        .put("ciphertext", ciphertext)
        .put("nonce", nonce);
    }
  }

  static final class NoteContent {
    String title;
    String content;
    ProtectedBody protectedContent;
    String attachmentKey;

    NoteContent(String title, String content, ProtectedBody protectedContent) {
      this(title, content, protectedContent, null);
    }

    NoteContent(
      String title,
      String content,
      ProtectedBody protectedContent,
      String attachmentKey
    ) {
      this.title = title;
      this.content = content;
      this.protectedContent = protectedContent;
      this.attachmentKey = attachmentKey;
    }

    NoteContent normalized() {
      String normalizedTitle = title == null ? "" : title.trim();
      if (normalizedTitle.isEmpty()) normalizedTitle = "无标题笔记";
      if (normalizedTitle.length() > MAX_TITLE_LENGTH) {
        normalizedTitle = normalizedTitle.substring(0, MAX_TITLE_LENGTH);
      }
      String normalizedContent = content == null ? "" : content;
      if (normalizedContent.length() > MAX_CONTENT_LENGTH) {
        normalizedContent = normalizedContent.substring(0, MAX_CONTENT_LENGTH);
      }
      return new NoteContent(normalizedTitle, normalizedContent, protectedContent, attachmentKey);
    }

    static NoteContent fromJson(JSONObject json) {
      JSONObject protectedJson = json.optJSONObject("protectedContent");
      return new NoteContent(
        json.optString("title"),
        json.optString("content"),
        protectedJson == null ? null : ProtectedBody.fromJson(protectedJson),
        nullableString(json, "attachmentKey")
      ).normalized();
    }

    JSONObject toEncryptedJson() throws JSONException {
      NoteContent normalized = normalized();
      JSONObject json = new JSONObject()
        .put("title", normalized.title)
        .put("content", normalized.protectedContent == null ? normalized.content : "");
      if (normalized.protectedContent != null) {
        json.put("protectedContent", normalized.protectedContent.toJson());
      } else if (normalized.attachmentKey != null) {
        json.put("attachmentKey", normalized.attachmentKey);
      }
      return json;
    }
  }

  static final class ProtectedPlaintext {
    final String content;
    final String attachmentKey;

    ProtectedPlaintext(String content, String attachmentKey) {
      this.content = content;
      this.attachmentKey = attachmentKey;
    }
  }

  static final class AttachmentEnvelope {
    final String id;
    final String noteId;
    final int version;
    int revision;
    String ciphertext;
    String nonce;
    boolean locked;
    final int ciphertextBytes;
    final String createdAt;
    String updatedAt;

    AttachmentEnvelope(
      String id,
      String noteId,
      int version,
      int revision,
      String ciphertext,
      String nonce,
      boolean locked,
      int ciphertextBytes,
      String createdAt,
      String updatedAt
    ) {
      this.id = id;
      this.noteId = noteId;
      this.version = version;
      this.revision = revision;
      this.ciphertext = ciphertext;
      this.nonce = nonce;
      this.locked = locked;
      this.ciphertextBytes = ciphertextBytes;
      this.createdAt = createdAt;
      this.updatedAt = updatedAt;
    }

    static AttachmentEnvelope fromJson(JSONObject json) {
      return new AttachmentEnvelope(
        json.optString("id"),
        json.optString("noteId"),
        json.optInt("version"),
        json.optInt("revision", 1),
        json.optString("ciphertext"),
        json.optString("nonce"),
        json.optBoolean("isLocked"),
        json.optInt("ciphertextBytes"),
        nullableString(json, "createdAt"),
        nullableString(json, "updatedAt")
      );
    }
  }

  static final class AttachmentMetadata {
    final String contentType;
    final int pixelWidth;
    final int pixelHeight;
    final int plaintextBytes;
    final int durationMillis;
    final String objectNonce;
    final String dataKey;

    AttachmentMetadata(
      String contentType,
      int pixelWidth,
      int pixelHeight,
      int plaintextBytes,
      int durationMillis,
      String objectNonce,
      String dataKey
    ) {
      this.contentType = contentType;
      this.pixelWidth = pixelWidth;
      this.pixelHeight = pixelHeight;
      this.plaintextBytes = plaintextBytes;
      this.durationMillis = durationMillis;
      this.objectNonce = objectNonce;
      this.dataKey = dataKey;
    }

    JSONObject toJson() throws JSONException {
      return new JSONObject()
        .put("contentType", contentType)
        .put("pixelWidth", pixelWidth)
        .put("pixelHeight", pixelHeight)
        .put("plaintextBytes", plaintextBytes)
        .put("durationMillis", durationMillis)
        .put("objectNonce", objectNonce)
        .put("dataKey", dataKey);
    }

    static AttachmentMetadata fromJson(JSONObject json) {
      return new AttachmentMetadata(
        json.optString("contentType"),
        json.optInt("pixelWidth"),
        json.optInt("pixelHeight"),
        json.optInt("plaintextBytes"),
        json.optInt("durationMillis"),
        json.optString("objectNonce"),
        json.optString("dataKey")
      );
    }
  }

  static final class AttachmentDocument {
    final AttachmentEnvelope envelope;
    final AttachmentMetadata metadata;
    byte[] mediaData;

    AttachmentDocument(AttachmentEnvelope envelope, AttachmentMetadata metadata, byte[] mediaData) {
      this.envelope = envelope;
      this.metadata = metadata;
      this.mediaData = mediaData;
    }

    boolean isAudio() { return "audio/mp4".equals(metadata.contentType); }
  }

  static final class NoteEnvelope {
    final String id;
    String folderId;
    final int version;
    int revision;
    String ciphertext;
    String nonce;
    final String createdAt;
    String updatedAt;
    String deletedAt;
    boolean locked;
    int attachmentCount;

    NoteEnvelope(
      String id,
      String folderId,
      int version,
      int revision,
      String ciphertext,
      String nonce,
      String createdAt,
      String updatedAt,
      String deletedAt,
      boolean locked
    ) {
      this(
        id,
        folderId,
        version,
        revision,
        ciphertext,
        nonce,
        createdAt,
        updatedAt,
        deletedAt,
        locked,
        UNKNOWN_ATTACHMENT_COUNT
      );
    }

    NoteEnvelope(
      String id,
      String folderId,
      int version,
      int revision,
      String ciphertext,
      String nonce,
      String createdAt,
      String updatedAt,
      String deletedAt,
      boolean locked,
      int attachmentCount
    ) {
      this.id = id;
      this.folderId = folderId;
      this.version = version;
      this.revision = revision;
      this.ciphertext = ciphertext;
      this.nonce = nonce;
      this.createdAt = createdAt;
      this.updatedAt = updatedAt;
      this.deletedAt = deletedAt;
      this.locked = locked;
      this.attachmentCount = attachmentCount < 0 ? UNKNOWN_ATTACHMENT_COUNT : attachmentCount;
    }

    static NoteEnvelope fromJson(JSONObject json) {
      return new NoteEnvelope(
        json.optString("id"),
        nullableString(json, "folderId"),
        json.optInt("version"),
        json.optInt("revision", 1),
        json.optString("ciphertext"),
        json.optString("nonce"),
        nullableString(json, "createdAt"),
        nullableString(json, "updatedAt"),
        nullableString(json, "deletedAt"),
        json.optBoolean("isLocked"),
        json.has("attachmentCount") ? Math.max(0, json.optInt("attachmentCount")) : UNKNOWN_ATTACHMENT_COUNT
      );
    }

    boolean shouldRequestAttachments(NoteContent content, boolean demoMode) {
      return !demoMode && attachmentCount != 0 && content.attachmentKey != null;
    }

    String displayDate() {
      String raw = deletedAt != null ? deletedAt : updatedAt != null ? updatedAt : createdAt;
      if (raw == null) return "";
      try {
        return DateTimeFormatter.ofPattern("M月d日", Locale.SIMPLIFIED_CHINESE)
          .withZone(ZoneId.systemDefault())
          .format(Instant.parse(raw));
      } catch (Exception ignored) {
        return "";
      }
    }
  }

  static final class FolderEnvelope {
    final String id;
    final int version;
    int revision;
    String ciphertext;
    String nonce;
    int sortOrder;
    final String createdAt;
    String updatedAt;

    FolderEnvelope(
      String id,
      int version,
      int revision,
      String ciphertext,
      String nonce,
      int sortOrder,
      String createdAt,
      String updatedAt
    ) {
      this.id = id;
      this.version = version;
      this.revision = revision;
      this.ciphertext = ciphertext;
      this.nonce = nonce;
      this.sortOrder = sortOrder;
      this.createdAt = createdAt;
      this.updatedAt = updatedAt;
    }

    static FolderEnvelope fromJson(JSONObject json) {
      return new FolderEnvelope(
        json.optString("id"),
        json.optInt("version"),
        json.optInt("revision", 1),
        json.optString("ciphertext"),
        json.optString("nonce"),
        json.optInt("sortOrder"),
        nullableString(json, "createdAt"),
        nullableString(json, "updatedAt")
      );
    }
  }

  static final class NoteDocument {
    final NoteEnvelope envelope;
    final NoteContent content;
    boolean unlocked;

    NoteDocument(NoteEnvelope envelope, NoteContent content) {
      this.envelope = envelope;
      this.content = content;
    }

    String title() {
      String value = content.title == null ? "" : content.title.trim();
      return value.isEmpty() ? "无标题笔记" : value;
    }

    String excerpt() {
      if (envelope.locked) return "••••••••";
      String value = content.content == null ? "" : content.content.trim().replaceAll("\\s+", " ");
      if (value.isEmpty()) return "暂无正文";
      return value.length() > 90 ? value.substring(0, 90) : value;
    }

    boolean matches(String query) {
      String value = query == null ? "" : query.trim().toLowerCase(Locale.ROOT);
      if (value.isEmpty()) return true;
      if (title().toLowerCase(Locale.ROOT).contains(value)) return true;
      return !envelope.locked
        && content.content != null
        && content.content.toLowerCase(Locale.ROOT).contains(value);
    }
  }

  static final class FolderDocument {
    final FolderEnvelope envelope;
    String name;

    FolderDocument(FolderEnvelope envelope, String name) {
      this.envelope = envelope;
      this.name = name == null || name.trim().isEmpty() ? "未命名文件夹" : name.trim();
    }
  }

  static final class ProtectionKeyring {
    final String id;
    final int version;
    final String kdf;
    final int iterations;
    final String salt;
    final String wrappedKey;
    final String nonce;
    final int revision;

    ProtectionKeyring(
      String id,
      int version,
      String kdf,
      int iterations,
      String salt,
      String wrappedKey,
      String nonce,
      int revision
    ) {
      this.id = id;
      this.version = version;
      this.kdf = kdf;
      this.iterations = iterations;
      this.salt = salt;
      this.wrappedKey = wrappedKey;
      this.nonce = nonce;
      this.revision = revision;
    }

    static ProtectionKeyring fromJson(JSONObject json) {
      return new ProtectionKeyring(
        json.optString("id"),
        json.optInt("version"),
        json.optString("kdf"),
        json.optInt("iterations"),
        json.optString("salt"),
        json.optString("wrappedKey"),
        json.optString("nonce"),
        json.optInt("revision", 1)
      );
    }
  }

  static String nullableString(JSONObject json, String key) {
    return !json.has(key) || json.isNull(key) ? null : json.optString(key, null);
  }
}

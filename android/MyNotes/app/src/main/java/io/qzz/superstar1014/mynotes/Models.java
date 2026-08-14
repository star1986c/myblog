package io.qzz.superstar1014.mynotes;

import org.json.JSONException;
import org.json.JSONObject;

import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.Locale;

final class Models {
  private Models() {}

  static final int MAX_TITLE_LENGTH = 200;
  static final int MAX_CONTENT_LENGTH = 500_000;

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

    NoteContent(String title, String content, ProtectedBody protectedContent) {
      this.title = title;
      this.content = content;
      this.protectedContent = protectedContent;
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
      return new NoteContent(normalizedTitle, normalizedContent, protectedContent);
    }

    static NoteContent fromJson(JSONObject json) {
      JSONObject protectedJson = json.optJSONObject("protectedContent");
      return new NoteContent(
        json.optString("title"),
        json.optString("content"),
        protectedJson == null ? null : ProtectedBody.fromJson(protectedJson)
      ).normalized();
    }

    JSONObject toEncryptedJson() throws JSONException {
      NoteContent normalized = normalized();
      JSONObject json = new JSONObject()
        .put("title", normalized.title)
        .put("content", normalized.protectedContent == null ? normalized.content : "");
      if (normalized.protectedContent != null) {
        json.put("protectedContent", normalized.protectedContent.toJson());
      }
      return json;
    }
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
        json.optBoolean("isLocked")
      );
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

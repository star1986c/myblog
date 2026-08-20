package io.qzz.superstar1014.mynotes;

import android.content.Context;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** App-private plaintext cache used only for Agent large-object output from private R2. */
final class HermesChatPrivateAttachmentCache {
  private static final String DIRECTORY_NAME = "hermes-chat-private-attachment-cache-v1";
  private static final Object FILE_LOCK = new Object();

  private final File directory;
  private final String spaceId;

  HermesChatPrivateAttachmentCache(Context context, String spaceId) {
    this(
      new File(
        new File(context.getNoBackupFilesDir(), DIRECTORY_NAME),
        hash(normalizeSpaceId(spaceId))
      ),
      spaceId
    );
  }

  HermesChatPrivateAttachmentCache(File directory, String spaceId) {
    this.directory = directory;
    this.spaceId = normalizeSpaceId(spaceId);
  }

  File read(JSONObject descriptor) {
    synchronized (FILE_LOCK) {
      try {
        File file = fileFor(descriptor);
        if (!validate(file, descriptor)) {
          Files.deleteIfExists(file.toPath());
          return null;
        }
        file.setLastModified(System.currentTimeMillis());
        return file;
      } catch (Exception ignored) {
        return null;
      }
    }
  }

  File createStagingFile() throws Exception {
    synchronized (FILE_LOCK) {
      if (!directory.exists() && !directory.mkdirs()) {
        throw new IllegalStateException("无法创建 Hermes 大附件缓存目录。");
      }
      return File.createTempFile("download-", ".tmp", directory);
    }
  }

  File commit(File staging, JSONObject descriptor) throws Exception {
    synchronized (FILE_LOCK) {
      if (!validate(staging, descriptor)) {
        Files.deleteIfExists(staging.toPath());
        throw new IllegalArgumentException("Hermes 大附件完整性校验失败。");
      }
      File destination = fileFor(descriptor);
      try {
        Files.move(
          staging.toPath(),
          destination.toPath(),
          StandardCopyOption.ATOMIC_MOVE,
          StandardCopyOption.REPLACE_EXISTING
        );
      } catch (Exception atomicMoveError) {
        Files.move(
          staging.toPath(),
          destination.toPath(),
          StandardCopyOption.REPLACE_EXISTING
        );
      }
      return destination;
    }
  }

  void retain(List<HermesChatCrypto.ChatMessage> messages) {
    synchronized (FILE_LOCK) {
      Set<String> retained = new HashSet<>();
      for (HermesChatCrypto.ChatMessage message : messages) {
        for (int index = 0; index < message.attachments.length(); index++) {
          JSONObject descriptor = message.attachments.optJSONObject(index);
          if (!HermesChatCrypto.isPrivateAttachment(descriptor)) continue;
          try { retained.add(fileFor(descriptor).getName()); } catch (Exception ignored) {}
        }
      }
      File[] files = directory.listFiles();
      if (files == null) return;
      for (File file : files) {
        if (file.isFile() && !retained.contains(file.getName())) file.delete();
      }
    }
  }

  void clear() {
    synchronized (FILE_LOCK) {
      File[] files = directory.listFiles();
      if (files == null) return;
      for (File file : files) if (file.isFile()) file.delete();
    }
  }

  private File fileFor(JSONObject descriptor) throws Exception {
    HermesChatCrypto.validateAttachmentDescriptor(descriptor, "agent");
    if (!HermesChatCrypto.isPrivateAttachment(descriptor)) {
      throw new IllegalArgumentException("不是 Hermes 私有 R2 附件。");
    }
    String fingerprint = spaceId + "|" + descriptor.getString("id") + "|"
      + descriptor.getString("contentType") + "|" + descriptor.getInt("plaintextBytes") + "|"
      + descriptor.getString("sha256");
    return new File(directory, hash(fingerprint) + ".private");
  }

  private static boolean validate(File file, JSONObject descriptor) throws Exception {
    HermesChatCrypto.validateAttachmentDescriptor(descriptor, "agent");
    long expectedBytes = descriptor.getLong("plaintextBytes");
    if (!file.isFile() || file.length() != expectedBytes) return false;
    MessageDigest digest = MessageDigest.getInstance("SHA-256");
    byte[] buffer = new byte[1024 * 1024];
    try (InputStream input = new FileInputStream(file)) {
      int count;
      while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
    }
    return hex(digest.digest()).equals(descriptor.getString("sha256"));
  }

  private static String normalizeSpaceId(String value) {
    String normalized = value == null ? "" : value.trim().toLowerCase(java.util.Locale.ROOT);
    if (!normalized.matches("[a-z0-9][a-z0-9_-]{0,63}")) {
      throw new IllegalArgumentException("Hermes profile id 无效。");
    }
    return normalized;
  }

  private static String hash(String value) {
    try {
      return hex(MessageDigest.getInstance("SHA-256")
        .digest(value.getBytes(StandardCharsets.UTF_8)));
    } catch (Exception error) {
      throw new IllegalStateException("无法创建 Hermes 大附件缓存键。", error);
    }
  }

  private static String hex(byte[] value) {
    StringBuilder output = new StringBuilder(value.length * 2);
    for (byte item : value) output.append(String.format("%02x", item & 0xff));
    return output.toString();
  }
}

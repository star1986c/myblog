package io.qzz.superstar1014.mynotes;

import android.content.Context;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Persists only the already end-to-end encrypted R2 attachment bytes. */
final class HermesChatImageCache {
  private static final String DIRECTORY_NAME = "hermes-chat-image-cache-v1";
  private static final int MAX_CIPHERTEXT_BYTES = HermesChatCrypto.MAX_ATTACHMENT_BYTES + 16;
  private static final Object FILE_LOCK = new Object();

  private final File directory;
  private final String spaceId;

  HermesChatImageCache(Context context, String spaceId) {
    this(
      new File(
        new File(context.getNoBackupFilesDir(), DIRECTORY_NAME),
        hash(normalizeSpaceId(spaceId))
      ),
      spaceId
    );
  }

  HermesChatImageCache(File directory, String spaceId) {
    this.directory = directory;
    this.spaceId = normalizeSpaceId(spaceId);
  }

  byte[] read(JSONObject descriptor) {
    synchronized (FILE_LOCK) {
      try {
        int expected = expectedCiphertextBytes(descriptor);
        File file = fileFor(descriptor);
        byte[] data = Files.readAllBytes(file.toPath());
        if (data.length != expected) {
          Files.deleteIfExists(file.toPath());
          return null;
        }
        file.setLastModified(System.currentTimeMillis());
        return data;
      } catch (Exception ignored) {
        return null;
      }
    }
  }

  void write(JSONObject descriptor, byte[] ciphertext) {
    synchronized (FILE_LOCK) {
      File temporary = null;
      try {
        int expected = expectedCiphertextBytes(descriptor);
        if (ciphertext == null || ciphertext.length != expected) return;
        if (!directory.exists() && !directory.mkdirs()) return;
        temporary = File.createTempFile("image-", ".tmp", directory);
        try (FileOutputStream output = new FileOutputStream(temporary)) {
          output.write(ciphertext);
          output.getFD().sync();
        }
        try {
          Files.move(
            temporary.toPath(),
            fileFor(descriptor).toPath(),
            StandardCopyOption.ATOMIC_MOVE,
            StandardCopyOption.REPLACE_EXISTING
          );
        } catch (Exception atomicMoveError) {
          Files.move(
            temporary.toPath(),
            fileFor(descriptor).toPath(),
            StandardCopyOption.REPLACE_EXISTING
          );
        }
      } catch (Exception ignored) {
        if (temporary != null) temporary.delete();
      }
    }
  }

  void retain(List<HermesChatCrypto.ChatMessage> messages) {
    synchronized (FILE_LOCK) {
      Set<String> retained = new HashSet<>();
      for (HermesChatCrypto.ChatMessage message : messages) {
        for (int index = 0; index < message.attachments.length(); index++) {
          JSONObject descriptor = message.attachments.optJSONObject(index);
          if (descriptor == null) continue;
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
    String fingerprint = spaceId + "|" + descriptor.getString("id") + "|"
      + descriptor.getString("contentType") + "|" + descriptor.getInt("plaintextBytes") + "|"
      + descriptor.getString("nonce");
    return new File(directory, hash(fingerprint) + ".bin");
  }

  private static int expectedCiphertextBytes(JSONObject descriptor) throws Exception {
    int plaintextBytes = descriptor.getInt("plaintextBytes");
    if (plaintextBytes < 1 || plaintextBytes > HermesChatCrypto.MAX_ATTACHMENT_BYTES) {
      throw new IllegalArgumentException("图片大小无效。");
    }
    int ciphertextBytes = plaintextBytes + 16;
    if (ciphertextBytes > MAX_CIPHERTEXT_BYTES) throw new IllegalArgumentException("图片过大。");
    return ciphertextBytes;
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
      byte[] digest = MessageDigest.getInstance("SHA-256")
        .digest(value.getBytes(StandardCharsets.UTF_8));
      StringBuilder output = new StringBuilder(digest.length * 2);
      for (byte item : digest) output.append(String.format("%02x", item & 0xff));
      return output.toString();
    } catch (Exception error) {
      throw new IllegalStateException("无法创建图片缓存键。", error);
    }
  }
}

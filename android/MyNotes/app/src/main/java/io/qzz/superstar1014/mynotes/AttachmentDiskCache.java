package io.qzz.superstar1014.mynotes;

import android.content.Context;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Stores only encrypted R2 object bytes in the app-private cache directory. */
final class AttachmentDiskCache {
  private static final int MAX_CIPHERTEXT_BYTES = Models.MAX_ATTACHMENT_BYTES + 16;
  private final File directory;

  AttachmentDiskCache(Context context) {
    this.directory = new File(context.getNoBackupFilesDir(), "encrypted-attachment-cache-v1");
    migrateLegacyCache(new File(context.getCacheDir(), "encrypted-attachment-cache-v1"));
  }

  AttachmentDiskCache(File directory) {
    this.directory = directory;
  }

  synchronized byte[] read(Models.AttachmentEnvelope envelope) {
    if (!validSize(envelope.ciphertextBytes)) return null;
    File file = fileFor(envelope);
    try {
      byte[] data = Files.readAllBytes(file.toPath());
      if (data.length != envelope.ciphertextBytes) {
        Files.deleteIfExists(file.toPath());
        return null;
      }
      file.setLastModified(System.currentTimeMillis());
      return data;
    } catch (Exception ignored) {
      try { Files.deleteIfExists(file.toPath()); } catch (Exception ignoredDelete) {}
      return null;
    }
  }

  synchronized void write(Models.AttachmentEnvelope envelope, byte[] data) {
    if (data == null || !validSize(envelope.ciphertextBytes)
      || data.length != envelope.ciphertextBytes) {
      remove(envelope);
      return;
    }
    File temporary = null;
    try {
      if (!directory.exists() && !directory.mkdirs()) return;
      temporary = File.createTempFile("attachment-", ".tmp", directory);
      try (FileOutputStream output = new FileOutputStream(temporary)) {
        output.write(data);
        output.getFD().sync();
      }
      Files.move(
        temporary.toPath(),
        fileFor(envelope).toPath(),
        StandardCopyOption.ATOMIC_MOVE,
        StandardCopyOption.REPLACE_EXISTING
      );
    } catch (Exception ignored) {
      if (temporary != null) temporary.delete();
    }
  }

  synchronized void remove(Models.AttachmentEnvelope envelope) {
    try { Files.deleteIfExists(fileFor(envelope).toPath()); } catch (Exception ignored) {}
  }

  synchronized void removeNote(String noteId) {
    File[] files = directory.listFiles();
    if (files == null) return;
    String prefix = notePrefix(noteId);
    for (File file : files) {
      if (file.getName().startsWith(prefix)) file.delete();
    }
  }

  synchronized void retain(String noteId, List<Models.AttachmentEnvelope> envelopes) {
    File[] files = directory.listFiles();
    if (files == null) return;
    String prefix = notePrefix(noteId);
    Set<String> retained = new HashSet<>();
    for (Models.AttachmentEnvelope envelope : envelopes) {
      retained.add(fileFor(envelope).getName());
    }
    for (File file : files) {
      if (file.getName().startsWith(prefix) && !retained.contains(file.getName())) {
        file.delete();
      }
    }
  }

  private synchronized void migrateLegacyCache(File legacyDirectory) {
    if (!legacyDirectory.exists() || legacyDirectory.equals(directory)) return;
    File[] files = legacyDirectory.listFiles();
    if (files == null || (!directory.exists() && !directory.mkdirs())) return;
    for (File file : files) {
      if (!file.isFile() || !file.getName().endsWith(".bin")) continue;
      File destination = new File(directory, file.getName());
      try {
        if (destination.exists()) {
          Files.deleteIfExists(file.toPath());
        } else {
          Files.move(
            file.toPath(),
            destination.toPath(),
            StandardCopyOption.ATOMIC_MOVE
          );
        }
      } catch (Exception ignored) {
        try {
          Files.move(
            file.toPath(),
            destination.toPath(),
            StandardCopyOption.REPLACE_EXISTING
          );
        } catch (Exception ignoredFallback) {}
      }
    }
    File[] remaining = legacyDirectory.listFiles();
    if (remaining != null && remaining.length == 0) legacyDirectory.delete();
  }

  private File fileFor(Models.AttachmentEnvelope envelope) {
    String fingerprint = envelope.version + "|" + envelope.revision + "|"
      + envelope.ciphertext + "|" + envelope.nonce + "|" + envelope.ciphertextBytes + "|"
      + (envelope.updatedAt == null ? "" : envelope.updatedAt);
    return new File(
      directory,
      notePrefix(envelope.noteId) + hash(envelope.id) + "-" + hash(fingerprint) + ".bin"
    );
  }

  private static String notePrefix(String noteId) {
    return hash(noteId) + "-";
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

  private static boolean validSize(int size) {
    return size > 16 && size <= MAX_CIPHERTEXT_BYTES;
  }
}

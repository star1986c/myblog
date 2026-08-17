package io.qzz.superstar1014.mynotes;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Set;

/** Stores a profile's decrypted message model inside one AES-GCM encrypted snapshot. */
final class HermesChatHistoryStore {
  private static final String DIRECTORY_NAME = "hermes-chat-history-v1";
  private static final long MAX_SNAPSHOT_BYTES = 64L * 1024 * 1024;
  private static final int MAX_MESSAGES = 20_000;
  private static final Object FILE_LOCK = new Object();

  private final File directory;
  private final File snapshotFile;
  private final String spaceId;
  private final HermesChatCrypto crypto;

  HermesChatHistoryStore(Context context, String spaceId, HermesChatCrypto crypto) {
    this(new File(context.getNoBackupFilesDir(), DIRECTORY_NAME), spaceId, crypto);
  }

  HermesChatHistoryStore(File directory, String spaceId, HermesChatCrypto crypto) {
    this.directory = directory;
    this.spaceId = normalizeSpaceId(spaceId);
    this.crypto = crypto;
    this.snapshotFile = new File(directory, hash(this.spaceId) + ".json");
  }

  Snapshot loadAndCleanup(int retentionDays, long now) {
    synchronized (FILE_LOCK) {
      Snapshot current = readSnapshot();
      if (retentionDays <= 0) return current;
      long cutoff = now - retentionDays * 24L * 60 * 60 * 1000;
      List<HermesChatCrypto.ChatMessage> retained = new ArrayList<>();
      for (HermesChatCrypto.ChatMessage message : current.messages) {
        if (message.sentAt <= 0 || message.sentAt >= cutoff) retained.add(copy(message));
      }
      if (retained.size() != current.messages.size()) {
        current = new Snapshot(current.lastSequence, retained);
        writeSnapshot(current);
      }
      return current;
    }
  }

  Snapshot record(HermesChatCrypto.ChatMessage incoming) {
    synchronized (FILE_LOCK) {
      Snapshot current = readSnapshot();
      if (incoming.replaceSequence > 0 && !incoming.finalUpdate) return current;
      List<HermesChatCrypto.ChatMessage> messages = mutableCopy(current.messages);
      if (incoming.replaceSequence > 0) {
        int targetIndex = indexOfSequence(messages, incoming.replaceSequence);
        if (targetIndex >= 0) {
          HermesChatCrypto.ChatMessage target = messages.get(targetIndex);
          JSONArray attachments = incoming.attachments.length() > 0
            ? cloneArray(incoming.attachments)
            : cloneArray(target.attachments);
          messages.set(targetIndex, new HermesChatCrypto.ChatMessage(
            target.id,
            target.sender,
            target.sentAt,
            target.sequence,
            incoming.text,
            attachments
          ));
        } else {
          messages.add(asStandalone(incoming));
        }
      } else {
        int existingIndex = indexOfId(messages, incoming.id);
        if (existingIndex >= 0) messages.set(existingIndex, copy(incoming));
        else messages.add(copy(incoming));
      }
      trimOldest(messages);
      Snapshot updated = new Snapshot(
        Math.max(current.lastSequence, Math.max(0, incoming.sequence)),
        messages
      );
      writeSnapshot(updated);
      return updated;
    }
  }

  Snapshot acknowledge(String messageId, long sequence) {
    if (sequence < 1) return loadAndCleanup(0, System.currentTimeMillis());
    synchronized (FILE_LOCK) {
      Snapshot current = readSnapshot();
      List<HermesChatCrypto.ChatMessage> messages = mutableCopy(current.messages);
      int index = indexOfId(messages, messageId);
      if (index >= 0) {
        HermesChatCrypto.ChatMessage message = messages.get(index);
        messages.set(index, new HermesChatCrypto.ChatMessage(
          message.id,
          message.sender,
          message.sentAt,
          sequence,
          message.text,
          cloneArray(message.attachments)
        ));
      }
      Snapshot updated = new Snapshot(Math.max(current.lastSequence, sequence), messages);
      writeSnapshot(updated);
      return updated;
    }
  }

  Snapshot clearMessages() {
    synchronized (FILE_LOCK) {
      Snapshot current = readSnapshot();
      Snapshot cleared = new Snapshot(current.lastSequence, List.of());
      writeSnapshot(cleared);
      return cleared;
    }
  }

  Snapshot deleteMessages(Set<String> messageIds) {
    if (messageIds == null || messageIds.isEmpty()) {
      return loadAndCleanup(0, System.currentTimeMillis());
    }
    synchronized (FILE_LOCK) {
      Snapshot current = readSnapshot();
      List<HermesChatCrypto.ChatMessage> retained = new ArrayList<>();
      for (HermesChatCrypto.ChatMessage message : current.messages) {
        if (!messageIds.contains(message.id)) retained.add(copy(message));
      }
      if (retained.size() == current.messages.size()) return current;
      Snapshot updated = new Snapshot(current.lastSequence, retained);
      writeSnapshot(updated);
      return updated;
    }
  }

  private Snapshot readSnapshot() {
    if (!snapshotFile.isFile()) return Snapshot.empty();
    try {
      long size = Files.size(snapshotFile.toPath());
      if (size < 1 || size > MAX_SNAPSHOT_BYTES) throw new IllegalArgumentException("cache size");
      JSONObject envelope = new JSONObject(
        new String(Files.readAllBytes(snapshotFile.toPath()), StandardCharsets.UTF_8)
      );
      JSONObject payload = crypto.decryptLocalSnapshot(envelope, spaceId);
      if (payload.optInt("v") != 1) throw new IllegalArgumentException("cache version");
      long lastSequence = Math.max(0, payload.optLong("lastSequence"));
      JSONArray values = payload.optJSONArray("messages");
      List<HermesChatCrypto.ChatMessage> messages = new ArrayList<>();
      if (values != null) {
        for (int index = 0; index < values.length() && messages.size() < MAX_MESSAGES; index++) {
          JSONObject value = values.optJSONObject(index);
          if (value != null) messages.add(messageFromJson(value));
        }
      }
      snapshotFile.setLastModified(System.currentTimeMillis());
      return new Snapshot(lastSequence, messages);
    } catch (Exception ignored) {
      try { Files.deleteIfExists(snapshotFile.toPath()); } catch (Exception ignoredDelete) {}
      return Snapshot.empty();
    }
  }

  private void writeSnapshot(Snapshot snapshot) {
    File temporary = null;
    try {
      if (!directory.exists() && !directory.mkdirs()) {
        throw new IllegalStateException("无法创建聊天缓存目录。");
      }
      JSONArray messages = new JSONArray();
      for (HermesChatCrypto.ChatMessage message : snapshot.messages) {
        messages.put(messageToJson(message));
      }
      JSONObject payload = new JSONObject()
        .put("v", 1)
        .put("lastSequence", snapshot.lastSequence)
        .put("messages", messages);
      byte[] encrypted = crypto.encryptLocalSnapshot(payload, spaceId)
        .toString().getBytes(StandardCharsets.UTF_8);
      if (encrypted.length > MAX_SNAPSHOT_BYTES) {
        throw new IllegalStateException("聊天缓存超过本地安全上限。");
      }
      temporary = File.createTempFile("history-", ".tmp", directory);
      try (FileOutputStream output = new FileOutputStream(temporary)) {
        output.write(encrypted);
        output.getFD().sync();
      }
      try {
        Files.move(
          temporary.toPath(),
          snapshotFile.toPath(),
          StandardCopyOption.ATOMIC_MOVE,
          StandardCopyOption.REPLACE_EXISTING
        );
      } catch (Exception atomicMoveError) {
        Files.move(
          temporary.toPath(),
          snapshotFile.toPath(),
          StandardCopyOption.REPLACE_EXISTING
        );
      }
    } catch (Exception error) {
      if (temporary != null) temporary.delete();
      throw new IllegalStateException("无法保存本地聊天缓存。", error);
    }
  }

  private static JSONObject messageToJson(HermesChatCrypto.ChatMessage message) throws Exception {
    return new JSONObject()
      .put("id", message.id)
      .put("sender", message.sender)
      .put("sentAt", message.sentAt)
      .put("sequence", message.sequence)
      .put("text", message.text)
      .put("attachments", cloneArray(message.attachments));
  }

  private static HermesChatCrypto.ChatMessage messageFromJson(JSONObject value) throws Exception {
    String id = value.getString("id");
    String sender = value.getString("sender");
    long sentAt = value.getLong("sentAt");
    long sequence = value.getLong("sequence");
    String text = value.getString("text");
    JSONArray attachments = value.optJSONArray("attachments");
    if (id.isEmpty() || (!"client".equals(sender) && !"agent".equals(sender))
        || sentAt < 0 || sequence < 0 || text.length() > 50_000
        || (attachments != null && attachments.length() > 8)) {
      throw new IllegalArgumentException("invalid cached message");
    }
    return new HermesChatCrypto.ChatMessage(
      id,
      sender,
      sentAt,
      sequence,
      text,
      attachments == null ? new JSONArray() : cloneArray(attachments)
    );
  }

  private static HermesChatCrypto.ChatMessage asStandalone(
    HermesChatCrypto.ChatMessage message
  ) {
    return new HermesChatCrypto.ChatMessage(
      message.id,
      message.sender,
      message.sentAt,
      message.sequence,
      message.text,
      cloneArray(message.attachments)
    );
  }

  private static HermesChatCrypto.ChatMessage copy(HermesChatCrypto.ChatMessage message) {
    return new HermesChatCrypto.ChatMessage(
      message.id,
      message.sender,
      message.sentAt,
      message.sequence,
      message.text,
      cloneArray(message.attachments),
      message.replaceSequence,
      message.finalUpdate
    );
  }

  private static List<HermesChatCrypto.ChatMessage> mutableCopy(
    List<HermesChatCrypto.ChatMessage> messages
  ) {
    List<HermesChatCrypto.ChatMessage> result = new ArrayList<>(messages.size());
    for (HermesChatCrypto.ChatMessage message : messages) result.add(copy(message));
    return result;
  }

  private static JSONArray cloneArray(JSONArray value) {
    try {
      return new JSONArray(value == null ? "[]" : value.toString());
    } catch (Exception error) {
      return new JSONArray();
    }
  }

  private static int indexOfId(List<HermesChatCrypto.ChatMessage> messages, String id) {
    for (int index = 0; index < messages.size(); index++) {
      if (messages.get(index).id.equals(id)) return index;
    }
    return -1;
  }

  private static int indexOfSequence(List<HermesChatCrypto.ChatMessage> messages, long sequence) {
    for (int index = 0; index < messages.size(); index++) {
      if (messages.get(index).sequence == sequence) return index;
    }
    return -1;
  }

  private static void trimOldest(List<HermesChatCrypto.ChatMessage> messages) {
    if (messages.size() > MAX_MESSAGES) {
      messages.subList(0, messages.size() - MAX_MESSAGES).clear();
    }
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
      throw new IllegalStateException("无法创建聊天缓存键。", error);
    }
  }

  static final class Snapshot {
    final long lastSequence;
    final List<HermesChatCrypto.ChatMessage> messages;

    Snapshot(long lastSequence, List<HermesChatCrypto.ChatMessage> messages) {
      this.lastSequence = Math.max(0, lastSequence);
      this.messages = Collections.unmodifiableList(mutableCopy(messages));
    }

    static Snapshot empty() {
      return new Snapshot(0, List.of());
    }
  }
}

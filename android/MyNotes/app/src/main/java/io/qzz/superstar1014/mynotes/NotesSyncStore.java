package io.qzz.superstar1014.mynotes;

import android.content.Context;
import android.util.AtomicFile;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Durable server baseline, independent of the editable UI/reading snapshot. */
final class NotesSyncStore {
  private static final Object LOCK = new Object();
  private static long generation;
  private final File directory;

  NotesSyncStore(Context context) {
    directory = new File(context.getNoBackupFilesDir(), "notes-sync-v1");
  }

  long generation() { synchronized (LOCK) { return generation; } }

  void clear() {
    synchronized (LOCK) {
      generation++;
      File[] files = directory.listFiles();
      if (files != null) for (File file : files) new AtomicFile(file).delete();
    }
  }

  JSONObject load(String scope, SecretKey key) {
    synchronized (LOCK) {
      try {
        byte[] bytes = file(scope).readFully();
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, bytes, 0, 12));
        cipher.updateAAD(scope.getBytes(StandardCharsets.UTF_8));
        JSONObject snapshot = new JSONObject(new String(cipher.doFinal(bytes, 12, bytes.length - 12), StandardCharsets.UTF_8));
        if (snapshot.getInt("version") != 1 || snapshot.getString("cursor").isEmpty()) return null;
        snapshot.getJSONObject("notes");
        snapshot.getJSONObject("folders");
        return snapshot;
      } catch (Exception ignored) { return null; }
    }
  }

  JSONObject fetch(NotesApiClient api, String scope, SecretKey key) throws Exception {
    JSONObject snapshot = load(scope, key);
    if (snapshot == null) snapshot = empty();
    for (int index = 0; index < 10_000; index++) {
      JSONObject page = api.notesSyncPage(snapshot.getString("cursor"));
      apply(snapshot, page);
      if (!page.getBoolean("hasMore")) return snapshot;
    }
    throw new IllegalStateException("笔记同步分页未结束，请重试。");
  }

  static JSONObject empty() throws Exception {
    return new JSONObject().put("version", 1).put("cursor", "")
      .put("notes", new JSONObject()).put("folders", new JSONObject());
  }

  static void apply(JSONObject snapshot, JSONObject page) throws Exception {
    String cursor = page.getString("cursor");
    if (page.getInt("version") != 1 || cursor.isEmpty()
        || (page.getBoolean("hasMore") && cursor.equals(snapshot.getString("cursor")))) {
      throw new IllegalStateException("笔记同步响应无效。");
    }
    if (page.getBoolean("reset")) {
      snapshot.put("notes", new JSONObject()).put("folders", new JSONObject());
    }
    JSONArray changes = page.getJSONArray("changes");
    for (int index = 0; index < changes.length(); index++) {
      JSONObject change = changes.getJSONObject(index);
      String kind = change.getString("kind");
      if (!kind.equals("note") && !kind.equals("folder")) throw new IllegalStateException("未知同步记录。");
      String id = change.getString("id");
      JSONObject entries = snapshot.getJSONObject(kind.equals("note") ? "notes" : "folders");
      if (change.getBoolean("deleted")) entries.remove(id);
      else {
        JSONObject envelope = change.getJSONObject(kind);
        if (!id.equals(envelope.getString("id"))) throw new IllegalStateException("同步记录 ID 不匹配。");
        entries.put(id, envelope);
      }
    }
    snapshot.put("cursor", cursor);
  }

  // Called only after all pages and all encrypted envelopes have been validated.
  // Failed writes leave the old cursor intact; the next attempt replays changes.
  void save(JSONObject snapshot, String scope, SecretKey key, long expectedGeneration) {
    synchronized (LOCK) {
      if (generation != expectedGeneration) return;
      AtomicFile target = null;
      FileOutputStream output = null;
      try {
        if (snapshot.getString("cursor").isEmpty()) return;
        if (!directory.isDirectory() && !directory.mkdirs()) return;
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key);
        cipher.updateAAD(scope.getBytes(StandardCharsets.UTF_8));
        byte[] encrypted = cipher.doFinal(snapshot.toString().getBytes(StandardCharsets.UTF_8));
        target = file(scope);
        output = target.startWrite();
        output.write(cipher.getIV());
        output.write(encrypted);
        target.finishWrite(output);
      } catch (Exception ignored) {
        if (target != null && output != null) target.failWrite(output);
      }
    }
  }

  private AtomicFile file(String scope) throws Exception {
    byte[] hash = MessageDigest.getInstance("SHA-256").digest(scope.getBytes(StandardCharsets.UTF_8));
    StringBuilder name = new StringBuilder();
    for (byte value : hash) name.append(String.format("%02x", value & 255));
    return new AtomicFile(new File(directory, name + ".bin"));
  }
}

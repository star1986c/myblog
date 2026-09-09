package io.qzz.superstar1014.mynotes;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** A device-only encrypted reading snapshot. Never contains a workspace/protection key. */
final class NotesSnapshotStore {
  private static final Object LOCK = new Object();
  private static final String KEY_ALIAS = "my-notes-reading-snapshot-v1";
  private static final byte[] AAD = "my-notes:reading-snapshot:v1".getBytes(StandardCharsets.UTF_8);
  private static final int MAX_BYTES = 64 * 1024 * 1024;
  private static long generation;
  private final AtomicFile file;

  NotesSnapshotStore(Context context) {
    file = new AtomicFile(new File(context.getNoBackupFilesDir(), "notes-reading-v1"));
  }

  long generation() {
    synchronized (LOCK) { return generation; }
  }

  void clear() {
    synchronized (LOCK) {
      generation++;
      file.delete();
    }
  }

  Snapshot load() {
    synchronized (LOCK) {
      if (!file.getBaseFile().exists()) return null;
      try {
        if (file.getBaseFile().length() > MAX_BYTES) throw new IllegalStateException("Snapshot too large");
        byte[] stored = file.readFully();
        if (stored.length < 28) throw new IllegalStateException("Invalid snapshot");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, stored, 0, 12));
        cipher.updateAAD(AAD);
        JSONObject json = new JSONObject(new String(
          cipher.doFinal(stored, 12, stored.length - 12), StandardCharsets.UTF_8
        ));
        if (json.getInt("version") != 1) throw new IllegalStateException("Invalid snapshot version");
        List<Models.FolderDocument> folders = new ArrayList<>();
        JSONArray folderValues = json.getJSONArray("folders");
        for (int i = 0; i < folderValues.length(); i++) {
          JSONObject value = folderValues.getJSONObject(i);
          folders.add(new Models.FolderDocument(
            Models.FolderEnvelope.fromJson(value.getJSONObject("envelope")), value.getString("name")
          ));
        }
        List<Models.NoteDocument> notes = new ArrayList<>();
        JSONArray noteValues = json.getJSONArray("notes");
        for (int i = 0; i < noteValues.length(); i++) {
          JSONObject value = noteValues.getJSONObject(i);
          notes.add(new Models.NoteDocument(
            Models.NoteEnvelope.fromJson(value.getJSONObject("envelope")),
            Models.NoteContent.fromJson(value.getJSONObject("content"))
          ));
        }
        return new Snapshot(Models.User.fromJson(json.getJSONObject("user")),
          json.getString("keyFingerprint"), folders, notes);
      } catch (Exception ignored) {
        clear();
        return null;
      }
    }
  }

  void save(JSONObject snapshot, long expectedGeneration) {
    synchronized (LOCK) {
      if (generation != expectedGeneration) return;
      FileOutputStream output = null;
      try {
        byte[] plaintext = snapshot.toString().getBytes(StandardCharsets.UTF_8);
        if (plaintext.length + 28 > MAX_BYTES) return;
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        cipher.updateAAD(AAD);
        byte[] encrypted = cipher.doFinal(plaintext);
        output = file.startWrite();
        output.write(cipher.getIV());
        output.write(encrypted);
        file.finishWrite(output);
      } catch (Exception ignored) {
        if (output != null) file.failWrite(output);
        // A cache failure must never fail a successful server save or write plaintext.
      }
    }
  }

  static String fingerprint(SecretKey key) throws Exception {
    return Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256").digest(key.getEncoded()));
  }

  static JSONObject capture(Models.User user, String fingerprint,
      List<Models.FolderDocument> folders, List<Models.NoteDocument> notes) throws Exception {
    JSONArray folderValues = new JSONArray();
    for (Models.FolderDocument folder : folders) {
      Models.FolderEnvelope e = folder.envelope;
      folderValues.put(new JSONObject().put("name", folder.name).put("envelope", new JSONObject()
        .put("id", e.id).put("version", e.version).put("revision", e.revision)
        .put("ciphertext", e.ciphertext).put("nonce", e.nonce).put("sortOrder", e.sortOrder)
        .put("createdAt", e.createdAt).put("updatedAt", e.updatedAt)));
    }
    JSONArray noteValues = new JSONArray();
    for (Models.NoteDocument note : notes) {
      Models.NoteEnvelope e = note.envelope;
      JSONObject envelope = new JSONObject().put("id", e.id).put("folderId", e.folderId)
        .put("version", e.version).put("revision", e.revision).put("ciphertext", e.ciphertext)
        .put("nonce", e.nonce).put("createdAt", e.createdAt).put("updatedAt", e.updatedAt)
        .put("deletedAt", e.deletedAt).put("isLocked", e.locked);
      if (e.attachmentCount >= 0) envelope.put("attachmentCount", e.attachmentCount);
      // This strips even an already-unlocked protected body and its attachment key.
      JSONObject content = note.content.toEncryptedJson();
      if (e.locked) content.put("content", "").remove("attachmentKey");
      noteValues.put(new JSONObject().put("envelope", envelope).put("content", content));
    }
    return new JSONObject().put("version", 1).put("keyFingerprint", fingerprint)
      .put("user", new JSONObject().put("username", user.username)
        .put("mustChangePassword", user.mustChangePassword))
      .put("folders", folderValues).put("notes", noteValues);
  }

  private static SecretKey key() throws Exception {
    KeyStore store = KeyStore.getInstance("AndroidKeyStore");
    store.load(null);
    if (store.containsAlias(KEY_ALIAS)) return (SecretKey) store.getKey(KEY_ALIAS, null);
    KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
    generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
      KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build());
    return generator.generateKey();
  }

  static final class Snapshot {
    final Models.User user;
    final String keyFingerprint;
    final List<Models.FolderDocument> folders;
    final List<Models.NoteDocument> notes;

    Snapshot(Models.User user, String keyFingerprint,
        List<Models.FolderDocument> folders, List<Models.NoteDocument> notes) {
      this.user = user;
      this.keyFingerprint = keyFingerprint;
      this.folders = folders;
      this.notes = notes;
    }
  }
}

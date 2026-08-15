package io.qzz.superstar1014.mynotes;

import android.app.Activity;
import android.app.Instrumentation;
import android.os.Bundle;

import java.io.File;
import java.util.Arrays;
import java.util.List;

import javax.crypto.SecretKey;

public final class CryptoTestRunner extends Instrumentation {
  @Override
  public void onCreate(Bundle arguments) {
    super.onCreate(arguments);
    start();
  }

  @Override
  public void onStart() {
    Bundle result = new Bundle();
    try {
      verifyWebCryptoFixture();
      verifyRoundTripsAndBinding();
      verifySharedProtectionPassword();
      verifyEncryptedAttachments();
      verifyAttachmentRequestHints();
      verifyAttachmentDiskCache();
      verifySecureSessionStorage();
      verifyBiometricProtectionEnvelope();
      result.putString(REPORT_KEY_STREAMRESULT, "My Notes crypto and biometric storage: PASS\n");
      finish(Activity.RESULT_OK, result);
    } catch (Throwable error) {
      result.putString(
        REPORT_KEY_STREAMRESULT,
        "My Notes crypto interoperability: FAIL\n" + error + "\n"
      );
      finish(Activity.RESULT_CANCELED, result);
    }
  }

  private static void verifyWebCryptoFixture() throws Exception {
    SecretKey key = CryptoEngine.importDataKey(
      "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"
    );
    Models.NoteEnvelope envelope = new Models.NoteEnvelope(
      "note_12345678",
      null,
      1,
      1,
      "fPS9ID47pN_p7lR_9EBpHYCZ84yE3_kUs_PCwVqTERMbEDxK5X8v_KhCz2hBxXCtdeg0gQ",
      "AgICAgICAgICAgIC",
      null,
      null,
      null,
      false
    );
    Models.NoteContent value = CryptoEngine.decryptNote(key, envelope);
    require("跨端".equals(value.title), "Web fixture title mismatch");
    require("hello".equals(value.content), "Web fixture body mismatch");
  }

  private static void verifyRoundTripsAndBinding() throws Exception {
    SecretKey key = CryptoEngine.importDataKey(
      "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM"
    );
    String id = "note_android_1234";
    Models.NoteContent content = new Models.NoteContent("安卓跨端", "中文正文", null);
    org.json.JSONObject payload = CryptoEngine.encryptNote(key, id, content);
    require(!payload.toString().contains("中文正文"), "Plaintext leaked into note payload");
    Models.NoteEnvelope envelope = new Models.NoteEnvelope(
      id,
      null,
      1,
      1,
      payload.getString("ciphertext"),
      payload.getString("nonce"),
      null,
      null,
      null,
      false
    );
    Models.NoteContent decrypted = CryptoEngine.decryptNote(key, envelope);
    require(content.title.equals(decrypted.title), "Note title round trip failed");
    require(content.content.equals(decrypted.content), "Note body round trip failed");

    Models.NoteEnvelope moved = new Models.NoteEnvelope(
      "note_android_5678",
      null,
      1,
      1,
      envelope.ciphertext,
      envelope.nonce,
      null,
      null,
      null,
      false
    );
    boolean rejected = false;
    try {
      CryptoEngine.decryptNote(key, moved);
    } catch (Exception expected) {
      rejected = true;
    }
    require(rejected, "Ciphertext was not bound to its note id");

    org.json.JSONObject folderPayload = CryptoEngine.encryptFolder(key, "folder_android_1234", "账号信息");
    Models.FolderEnvelope folder = new Models.FolderEnvelope(
      "folder_android_1234",
      1,
      1,
      folderPayload.getString("ciphertext"),
      folderPayload.getString("nonce"),
      0,
      null,
      null
    );
    require("账号信息".equals(CryptoEngine.decryptFolder(key, folder)), "Folder round trip failed");
  }

  private static void verifySharedProtectionPassword() throws Exception {
    String password = "correct horse battery staple";
    Models.ProtectionKeyring webKeyring = new Models.ProtectionKeyring(
      "notes-protection",
      1,
      "PBKDF2-SHA256",
      310_000,
      "AQIDBAUGBwgJCgsMDQ4PEA",
      "8P3iNh7Fkh5msdojAz3ZQKSBOM_shFYkMWn55gniy7GHIRpd8ehidupnx__xbGPT",
      "FRYXGBkaGxwdHh8g",
      1
    );
    CryptoEngine.unlockProtectionKeyring(webKeyring, password);

    CryptoEngine.ProtectionSetup setup = CryptoEngine.createProtectionKeyring(password);
    Models.ProtectionKeyring keyring = Models.ProtectionKeyring.fromJson(
      new org.json.JSONObject(setup.payload.toString()).put("revision", 1)
    );
    SecretKey recovered = CryptoEngine.unlockProtectionKeyring(keyring, password);
    Models.ProtectedBody body = CryptoEngine.encryptProtectedBody(
      recovered,
      "note_protected_1234",
      "server-password-123",
      "BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ"
    );
    require(!body.ciphertext.contains("server-password-123"), "Protected plaintext leaked");
    require(
      "server-password-123".equals(CryptoEngine.decryptProtectedBody(
        recovered,
        "note_protected_1234",
        body
      )),
      "Protected body round trip failed"
    );
    Models.ProtectedPlaintext protectedPlaintext = CryptoEngine.decryptProtectedPayload(
      recovered,
      "note_protected_1234",
      body
    );
    require(
      "BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ".equals(
        protectedPlaintext.attachmentKey
      ),
      "Protected attachment key round trip failed"
    );
    boolean rejected = false;
    try {
      CryptoEngine.unlockProtectionKeyring(keyring, "wrong-password-value");
    } catch (Exception expected) {
      rejected = true;
    }
    require(rejected, "Wrong protection password was accepted");
  }

  private static void verifyEncryptedAttachments() throws Exception {
    byte[] image = new byte[] { 1, 3, 3, 7, 9, 11 };
    String noteId = "note_attachment_1234";
    String attachmentId = "attachment_android_1234";
    String mediaKey = CryptoEngine.createMediaKey();
    CryptoEngine.EncryptedAttachment encrypted = CryptoEngine.encryptAttachment(
      image,
      "image/png",
      64,
      32,
      0,
      noteId,
      attachmentId,
      true,
      mediaKey
    );
    require(!encrypted.payload.toString().contains("image/png"), "Attachment metadata leaked");
    Models.AttachmentEnvelope envelope = new Models.AttachmentEnvelope(
      attachmentId,
      noteId,
      1,
      1,
      encrypted.payload.getString("ciphertext"),
      encrypted.payload.getString("nonce"),
      true,
      encrypted.body.length,
      null,
      null
    );
    Models.AttachmentMetadata metadata = CryptoEngine.decryptAttachmentMetadata(mediaKey, envelope);
    require("image/png".equals(metadata.contentType), "Attachment metadata round trip failed");
    byte[] decrypted = CryptoEngine.decryptAttachmentBody(encrypted.body, envelope, metadata);
    require(java.util.Arrays.equals(image, decrypted), "Attachment body round trip failed");

    Models.AttachmentEnvelope moved = new Models.AttachmentEnvelope(
      attachmentId,
      "note_attachment_other",
      1,
      1,
      envelope.ciphertext,
      envelope.nonce,
      true,
      envelope.ciphertextBytes,
      null,
      null
    );
    boolean rejected = false;
    try {
      CryptoEngine.decryptAttachmentMetadata(mediaKey, moved);
    } catch (Exception expected) {
      rejected = true;
    }
    require(rejected, "Attachment metadata was not bound to its note id");

    byte[] audio = new byte[] { 0, 0, 0, 24, 102, 116, 121, 112, 77, 52, 65, 32 };
    String audioId = "attachment_audio_1234";
    CryptoEngine.EncryptedAttachment encryptedAudio = CryptoEngine.encryptAttachment(
      audio,
      "audio/mp4",
      1,
      1,
      12_345,
      noteId,
      audioId,
      true,
      mediaKey
    );
    Models.AttachmentEnvelope audioEnvelope = new Models.AttachmentEnvelope(
      audioId,
      noteId,
      1,
      1,
      encryptedAudio.payload.getString("ciphertext"),
      encryptedAudio.payload.getString("nonce"),
      true,
      encryptedAudio.body.length,
      null,
      null
    );
    Models.AttachmentMetadata audioMetadata = CryptoEngine.decryptAttachmentMetadata(
      mediaKey,
      audioEnvelope
    );
    require("audio/mp4".equals(audioMetadata.contentType), "Audio content type was not preserved");
    require(audioMetadata.durationMillis == 12_345, "Audio duration was not preserved");
    require(
      java.util.Arrays.equals(
        audio,
        CryptoEngine.decryptAttachmentBody(encryptedAudio.body, audioEnvelope, audioMetadata)
      ),
      "Encrypted audio attachment round trip failed"
    );
  }

  private void verifySecureSessionStorage() {
    SecureSessionStore store = new SecureSessionStore(
      getTargetContext(),
      "my_notes_secure_session_test",
      "my-notes-session-cookie-test-v1"
    );
    store.clear();
    store.save("site_admin_session=test-token");
    store.saveDeviceToken("device-id.device-secret");
    require(
      "site_admin_session=test-token".equals(store.load()),
      "Android Keystore session round trip failed"
    );
    require(
      "device-id.device-secret".equals(store.loadDeviceToken()),
      "Android Keystore device token round trip failed"
    );
    store.clearDeviceToken();
    require(store.loadDeviceToken().isEmpty(), "Revoked device token was not cleared");
    require(
      "site_admin_session=test-token".equals(store.load()),
      "Clearing a revoked device token also cleared the active session"
    );
    store.clear();
    require(store.load().isEmpty(), "Secure session clear failed");
    require(store.loadDeviceToken().isEmpty(), "Secure device token clear failed");
  }

  private static void verifyBiometricProtectionEnvelope() {
    byte[] iv = new byte[12];
    byte[] encryptedKey = new byte[48];
    Arrays.fill(iv, (byte) 0x21);
    Arrays.fill(encryptedKey, (byte) 0x4B);
    String stored = BiometricProtectionStore.encodePayload(iv, encryptedKey);
    require(stored.startsWith("v1."), "Biometric payload version is missing");
    BiometricProtectionStore.WrappedPayload decoded = BiometricProtectionStore.decodePayload(stored);
    require(Arrays.equals(iv, decoded.iv), "Biometric IV round trip failed");
    require(Arrays.equals(encryptedKey, decoded.ciphertext), "Biometric ciphertext round trip failed");

    Models.ProtectionKeyring keyring = new Models.ProtectionKeyring(
      "notes-protection",
      1,
      "PBKDF2-SHA256",
      310_000,
      "salt",
      "wrapped-key-v1",
      "nonce",
      4
    );
    Models.ProtectionKeyring changed = new Models.ProtectionKeyring(
      "notes-protection",
      1,
      "PBKDF2-SHA256",
      310_000,
      "salt",
      "wrapped-key-v2",
      "nonce",
      5
    );
    require(
      !BiometricProtectionStore.bindingFor(keyring).equals(
        BiometricProtectionStore.bindingFor(changed)
      ),
      "Biometric binding ignored protection keyring changes"
    );
    boolean rejected = false;
    try {
      BiometricProtectionStore.decodePayload("v1.invalid");
    } catch (IllegalArgumentException expected) {
      rejected = true;
    }
    require(rejected, "Malformed biometric payload was accepted");
  }

  private void verifyAttachmentDiskCache() {
    File directory = new File(
      getTargetContext().getCacheDir(),
      "encrypted-attachment-cache-test-" + System.nanoTime()
    );
    AttachmentDiskCache cache = new AttachmentDiskCache(directory);
    byte[] encrypted = new byte[48];
    Arrays.fill(encrypted, (byte) 0x5A);
    Models.AttachmentEnvelope envelope = new Models.AttachmentEnvelope(
      "attachment_cache_android",
      "note_cache_android",
      1,
      1,
      "encrypted-metadata",
      "metadata-nonce",
      true,
      encrypted.length,
      null,
      "2026-08-14T12:00:00.000Z"
    );

    cache.write(envelope, encrypted);
    AttachmentDiskCache reopenedCache = new AttachmentDiskCache(directory);
    require(
      Arrays.equals(encrypted, reopenedCache.read(envelope)),
      "Encrypted image cache did not persist across cache instances"
    );

    Models.AttachmentEnvelope changed = new Models.AttachmentEnvelope(
      envelope.id,
      envelope.noteId,
      envelope.version,
      2,
      envelope.ciphertext,
      envelope.nonce,
      envelope.locked,
      envelope.ciphertextBytes,
      null,
      "2026-08-14T13:00:00.000Z"
    );
    require(cache.read(changed) == null, "Changed attachment reused stale cached bytes");
    cache.retain(envelope.noteId, List.of(changed));
    require(cache.read(envelope) == null, "Stale attachment cache entry was retained");

    cache.write(changed, encrypted);
    cache.removeNote(envelope.noteId);
    require(cache.read(changed) == null, "Deleted note retained encrypted image cache");
    directory.delete();
  }

  private static void verifyAttachmentRequestHints() throws Exception {
    Models.NoteContent content = new Models.NoteContent("附件提示", "", null, "media-key");
    Models.NoteEnvelope empty = Models.NoteEnvelope.fromJson(new org.json.JSONObject()
      .put("id", "note_empty_attachments")
      .put("version", 1)
      .put("revision", 1)
      .put("ciphertext", "ciphertext")
      .put("nonce", "nonce")
      .put("isLocked", false)
      .put("attachmentCount", 0));
    require(
      !empty.shouldRequestAttachments(content, false),
      "Known-empty note requested its attachment list"
    );

    Models.NoteEnvelope populated = Models.NoteEnvelope.fromJson(new org.json.JSONObject()
      .put("id", "note_with_attachments")
      .put("version", 1)
      .put("revision", 1)
      .put("ciphertext", "ciphertext")
      .put("nonce", "nonce")
      .put("isLocked", false)
      .put("attachmentCount", 2));
    require(
      populated.shouldRequestAttachments(content, false),
      "Note with attachments skipped its attachment list"
    );

    Models.NoteEnvelope legacy = Models.NoteEnvelope.fromJson(new org.json.JSONObject()
      .put("id", "note_legacy_attachments")
      .put("version", 1)
      .put("revision", 1)
      .put("ciphertext", "ciphertext")
      .put("nonce", "nonce")
      .put("isLocked", false));
    require(
      legacy.shouldRequestAttachments(content, false),
      "Legacy server response lost attachment compatibility"
    );
  }

  private static void require(boolean condition, String message) {
    if (!condition) throw new AssertionError(message);
  }
}

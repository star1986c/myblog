package io.qzz.superstar1014.mynotes;

import android.app.Activity;
import android.app.Instrumentation;
import android.os.Bundle;

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
      verifySecureSessionStorage();
      result.putString(REPORT_KEY_STREAMRESULT, "My Notes crypto interoperability: PASS\n");
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
      "server-password-123"
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
    boolean rejected = false;
    try {
      CryptoEngine.unlockProtectionKeyring(keyring, "wrong-password-value");
    } catch (Exception expected) {
      rejected = true;
    }
    require(rejected, "Wrong protection password was accepted");
  }

  private void verifySecureSessionStorage() {
    SecureSessionStore store = new SecureSessionStore(
      getTargetContext(),
      "my_notes_secure_session_test",
      "my-notes-session-cookie-test-v1"
    );
    store.clear();
    store.save("site_admin_session=test-token");
    require(
      "site_admin_session=test-token".equals(store.load()),
      "Android Keystore session round trip failed"
    );
    store.clear();
    require(store.load().isEmpty(), "Secure session clear failed");
  }

  private static void require(boolean condition, String message) {
    if (!condition) throw new AssertionError(message);
  }
}

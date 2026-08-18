package io.qzz.superstar1014.mynotes;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.net.Uri;
import android.os.Bundle;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.Arrays;
import java.util.List;
import java.util.Set;

import javax.crypto.SecretKey;

public final class CryptoTestRunner extends Instrumentation {
  private Bundle arguments = Bundle.EMPTY;

  @Override
  public void onCreate(Bundle arguments) {
    this.arguments = arguments == null ? Bundle.EMPTY : new Bundle(arguments);
    super.onCreate(arguments);
    start();
  }

  @Override
  public void onStart() {
    Bundle result = new Bundle();
    try {
      if ("chat-behavior".equals(arguments.getString("uiQa"))) {
        verifyHermesChatBehaviorForQa();
        result.putString(
          REPORT_KEY_STREAMRESULT,
          "Hermes chat focus and latest-message scrolling QA: PASS\n"
        );
        finish(Activity.RESULT_OK, result);
        return;
      }
      if ("image-preview".equals(arguments.getString("layoutPreview"))) {
        showHermesImagePreviewForQa();
        result.putString(REPORT_KEY_STREAMRESULT, "Hermes image preview QA: PASS\n");
        Thread.sleep(15_000L);
        finish(Activity.RESULT_OK, result);
        return;
      }
      verifyWebCryptoFixture();
      verifyRoundTripsAndBinding();
      verifySharedProtectionPassword();
      verifyEncryptedAttachments();
      verifyHermesChatCrypto();
      verifyHermesChatRichMessages();
      verifyHermesImageShareProvider();
      verifyHermesChatHistoryCache();
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

  private void showHermesImagePreviewForQa() throws Exception {
    Intent intent = new Intent(getTargetContext(), HermesChatActivity.class)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      .putExtra("demo", true)
      .putExtra("profileLabel", "Hermes Magic8 图片预览");
    HermesChatActivity activity = (HermesChatActivity) startActivitySync(intent);

    Bitmap bitmap = Bitmap.createBitmap(1080, 720, Bitmap.Config.ARGB_8888);
    Canvas canvas = new Canvas(bitmap);
    canvas.drawColor(Color.rgb(29, 93, 87));
    Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    paint.setColor(Color.rgb(216, 241, 237));
    paint.setTextAlign(Paint.Align.CENTER);
    paint.setTextSize(64f);
    canvas.drawText("Hermes encrypted image", 540f, 335f, paint);
    paint.setTextSize(42f);
    canvas.drawText("1256 x 2808 layout QA", 540f, 410f, paint);

    ByteArrayOutputStream output = new ByteArrayOutputStream();
    bitmap.compress(Bitmap.CompressFormat.PNG, 100, output);
    byte[] plaintext = output.toByteArray();
    org.json.JSONObject descriptor = new org.json.JSONObject()
      .put("name", "hermes-layout-preview.png")
      .put("contentType", "image/png");
    Method preview = HermesChatActivity.class.getDeclaredMethod(
      "showImagePreview",
      Bitmap.class,
      byte[].class,
      org.json.JSONObject.class
    );
    preview.setAccessible(true);
    runOnMainSync(() -> {
      try {
        preview.invoke(activity, bitmap, plaintext, descriptor);
      } catch (ReflectiveOperationException error) {
        throw new RuntimeException(error);
      }
    });
    waitForIdleSync();
  }

  private void verifyHermesChatBehaviorForQa() throws Exception {
    Intent intent = new Intent(getTargetContext(), HermesChatActivity.class)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      .putExtra("demo", true)
      .putExtra(HermesChatActivity.EXTRA_DEMO_LONG_HISTORY, true)
      .putExtra(HermesChatActivity.EXTRA_PROFILE_LABEL, "Hermes 焦点与滚动验证");
    HermesChatActivity activity = (HermesChatActivity) startActivitySync(intent);

    Field composerField = HermesChatActivity.class.getDeclaredField("composer");
    Field messageScrollField = HermesChatActivity.class.getDeclaredField("messageScroll");
    Field messagesField = HermesChatActivity.class.getDeclaredField("messages");
    composerField.setAccessible(true);
    messageScrollField.setAccessible(true);
    messagesField.setAccessible(true);
    EditText composer = (EditText) composerField.get(activity);
    ScrollView messageScroll = (ScrollView) messageScrollField.get(activity);
    LinearLayout messages = (LinearLayout) messagesField.get(activity);

    try {
      waitForIdleSync();
      Thread.sleep(350L);
      waitForIdleSync();
      requireChatAtBottom(activity, messageScroll, messages, false, true);

      HermesChatCrypto.ChatMessage hiddenImeMessage = new HermesChatCrypto.ChatMessage(
        "qa-hidden-ime-message",
        "agent",
        System.currentTimeMillis(),
        1001,
        "键盘隐藏时收到的新消息不应主动弹出输入法。",
        new org.json.JSONArray()
      );
      runOnMainSync(() -> activity.onMessage(hiddenImeMessage));
      waitForIdleSync();
      Thread.sleep(650L);
      waitForIdleSync();
      requireChatAtBottom(activity, messageScroll, messages, false, true);

      runOnMainSync(() -> {
        composer.requestFocus();
        composer.setSelection(composer.length());
        WindowInsetsController controller = activity.getWindow().getInsetsController();
        require(controller != null, "Hermes chat has no WindowInsetsController");
        controller.show(WindowInsets.Type.ime());
      });
      require(
        waitForImeVisibility(activity, true, 2_500L),
        "Hermes chat keyboard did not become visible after explicit composer focus"
      );

      HermesChatCrypto.ChatMessage visibleImeMessage = new HermesChatCrypto.ChatMessage(
        "qa-visible-ime-message",
        "agent",
        System.currentTimeMillis() + 1,
        1002,
        "键盘已显示时收到的新消息应保持输入框焦点并滚动到最新消息。",
        new org.json.JSONArray()
      );
      runOnMainSync(() -> activity.onMessage(visibleImeMessage));
      waitForIdleSync();
      Thread.sleep(650L);
      waitForIdleSync();
      requireChatAtBottom(activity, messageScroll, messages, true, true);
      runOnMainSync(() -> require(
        composer.hasFocus(),
        "Incoming Hermes message moved focus away from the visible composer"
      ));
    } finally {
      runOnMainSync(activity::finish);
      waitForIdleSync();
    }
  }

  private void requireChatAtBottom(
    HermesChatActivity activity,
    ScrollView messageScroll,
    LinearLayout messages,
    boolean expectedImeVisible,
    boolean requireOverflow
  ) {
    runOnMainSync(() -> {
      int bottom = Math.max(0, messages.getHeight() - messageScroll.getHeight());
      if (requireOverflow) require(bottom > 0, "Hermes QA history did not overflow the viewport");
      require(
        Math.abs(messageScroll.getScrollY() - bottom) <= 2,
        "Hermes chat is not positioned at the latest message"
      );
      WindowInsets insets = activity.getWindow().getDecorView().getRootWindowInsets();
      boolean imeVisible = insets != null && insets.isVisible(WindowInsets.Type.ime());
      require(
        imeVisible == expectedImeVisible,
        expectedImeVisible
          ? "Hermes chat unexpectedly hid the visible keyboard"
          : "Hermes chat unexpectedly opened the keyboard"
      );
    });
  }

  private boolean waitForImeVisibility(
    HermesChatActivity activity,
    boolean expectedVisible,
    long timeoutMs
  ) throws InterruptedException {
    long deadline = System.currentTimeMillis() + timeoutMs;
    while (System.currentTimeMillis() < deadline) {
      boolean[] visible = new boolean[1];
      runOnMainSync(() -> {
        WindowInsets insets = activity.getWindow().getDecorView().getRootWindowInsets();
        visible[0] = insets != null && insets.isVisible(WindowInsets.Type.ime());
      });
      if (visible[0] == expectedVisible) return true;
      Thread.sleep(50L);
      waitForIdleSync();
    }
    return false;
  }

  private static void verifyHermesChatCrypto() throws Exception {
    String key = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
    HermesChatCrypto crypto = new HermesChatCrypto(key);
    String messageId = "550e8400-e29b-41d4-a716-446655440000";
    org.json.JSONArray attachments = new org.json.JSONArray();
    org.json.JSONObject envelope = crypto.encryptMessage(
      "client",
      "profile 隔离消息",
      attachments,
      messageId,
      1_800_000_000_000L
    );
    require(!envelope.toString().contains("profile 隔离消息"), "Hermes plaintext leaked");
    HermesChatCrypto.ChatMessage message = crypto.decryptMessage(envelope, 7);
    require("profile 隔离消息".equals(message.text), "Hermes message round trip failed");
    require(message.sequence == 7, "Hermes sequence was not preserved");

    org.json.JSONObject editEnvelope = crypto.encryptMessage(
      "agent",
      "流式最终文本",
      new org.json.JSONArray(),
      "550e8400-e29b-41d4-a716-446655440010",
      1_800_000_000_100L,
      7,
      true
    );
    HermesChatCrypto.ChatMessage edit = crypto.decryptMessage(editEnvelope, 8);
    require(edit.replaceSequence == 7, "Hermes edit target was not authenticated");
    require(edit.finalUpdate, "Hermes final edit flag was not authenticated");

    org.json.JSONObject fixture = new org.json.JSONObject()
      .put("v", 1)
      .put("type", "message")
      .put("id", messageId)
      .put("sender", "agent")
      .put("sentAt", 1_800_000_000_000L)
      .put("encrypted", new org.json.JSONObject()
        .put("alg", "A256GCM")
        .put("nonce", "AAECAwQFBgcICQoL")
        .put(
          "ciphertext",
          "PCCifr2R4CGvqSAjVkLXTeuz61ifWXNeWROR5H4BbddvZN3elZpP5W00"
            + "JWv4qPMrDG21sPX9lI0"
        ));
    require(
      "跨端 hello".equals(crypto.decryptMessage(fixture, 8).text),
      "Hermes Android/Python wire fixture failed"
    );

    byte[] image = new byte[] {1, 2, 3, 4, 5, 6};
    HermesChatCrypto.EncryptedAttachment encrypted = crypto.encryptAttachment(
      image,
      "image/png",
      "fixture.png"
    );
    require(
      Arrays.equals(image, crypto.decryptAttachment(encrypted.ciphertext, encrypted.descriptor)),
      "Hermes attachment round trip failed"
    );
  }

  private static void verifyHermesChatRichMessages() {
    HermesChatAttachmentPolicy.ResolvedType document = HermesChatAttachmentPolicy.resolve(
      "application/pdf",
      "report.pdf"
    );
    require(
      document.category == HermesChatAttachmentPolicy.Category.DOCUMENT,
      "Hermes PDF category mismatch"
    );
    require(
      HermesChatAttachmentPolicy.resolve("audio/mpeg", "reply.mp3").category
        == HermesChatAttachmentPolicy.Category.AUDIO,
      "Hermes audio category mismatch"
    );
    require(
      HermesChatAttachmentPolicy.resolve("video/mp4", "demo.mp4").category
        == HermesChatAttachmentPolicy.Category.VIDEO,
      "Hermes video category mismatch"
    );
    boolean rejected = false;
    try {
      HermesChatAttachmentPolicy.resolve("application/octet-stream", "unsafe.exe");
    } catch (IllegalArgumentException expected) {
      rejected = true;
    }
    require(rejected, "Hermes unsupported executable was accepted");

    CharSequence rendered = HermesChatMarkdown.render(
      "## 状态\n```bash\nhermes status\n```\n`ready`",
      0xff202020,
      0xffffffff,
      0xff00aa88,
      8
    );
    require(rendered instanceof android.text.Spanned, "Hermes Markdown was not styled");
    require(!rendered.toString().contains("```"), "Hermes code fences remained visible");
    require(rendered.toString().contains("hermes status"), "Hermes code block content was lost");
    android.text.Spanned styled = (android.text.Spanned) rendered;
    require(
      styled.getSpans(0, styled.length(), android.text.style.TypefaceSpan.class).length >= 2,
      "Hermes code styles were not applied"
    );
    List<HermesChatMarkdown.Block> blocks = HermesChatMarkdown.parseBlocks(
      "说明\n```bash\nhermes status\n```\n完成"
    );
    require(blocks.size() == 3, "Hermes Markdown blocks were not split deterministically");
    require(!blocks.get(0).code && blocks.get(0).text.contains("说明"), "Text block was lost");
    require(
      blocks.get(1).code
        && "bash".equals(blocks.get(1).language)
        && "hermes status".equals(blocks.get(1).text),
      "Fenced code metadata was not preserved for copy actions"
    );
    require(!blocks.get(2).code && blocks.get(2).text.contains("完成"), "Tail text was lost");
  }

  private void verifyHermesImageShareProvider() throws Exception {
    Context context = getTargetContext();
    byte[] image = new byte[] {(byte) 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a};
    File file = HermesShareFileProvider.createImageFile(context, "PNG");
    try {
      try (FileOutputStream output = new FileOutputStream(file)) {
        output.write(image);
      }
      Uri uri = HermesShareFileProvider.uriFor(context, file, "Hermes 测试图片.png");
      require("content".equals(uri.getScheme()), "Hermes share URI was not a content URI");
      require(
        "image/png".equals(context.getContentResolver().getType(uri)),
        "Hermes share provider returned the wrong MIME type"
      );
      byte[] opened = new byte[image.length];
      try (InputStream input = context.getContentResolver().openInputStream(uri)) {
        require(input != null, "Hermes share provider did not open the image");
        require(input.read(opened) == image.length, "Hermes shared image was truncated");
      }
      require(Arrays.equals(image, opened), "Hermes shared image bytes changed");

      boolean writeRejected = false;
      try {
        context.getContentResolver().openOutputStream(uri);
      } catch (Exception expected) {
        writeRejected = true;
      }
      require(writeRejected, "Hermes share URI allowed write access");
    } finally {
      file.delete();
    }

    byte[] document = "Hermes PDF fixture".getBytes(java.nio.charset.StandardCharsets.UTF_8);
    File documentFile = HermesShareFileProvider.createAttachmentFile(context, "pdf");
    try {
      try (FileOutputStream output = new FileOutputStream(documentFile)) {
        output.write(document);
      }
      Uri uri = HermesShareFileProvider.uriFor(context, documentFile, "Hermes 测试文档.pdf");
      require(
        "application/pdf".equals(context.getContentResolver().getType(uri)),
        "Hermes attachment share provider returned the wrong MIME type"
      );
      byte[] opened = new byte[document.length];
      try (InputStream input = context.getContentResolver().openInputStream(uri)) {
        require(input != null, "Hermes shared attachment did not open");
        require(input.read(opened) == document.length, "Hermes shared attachment was truncated");
      }
      require(Arrays.equals(document, opened), "Hermes shared attachment bytes changed");
    } finally {
      documentFile.delete();
    }
  }

  private void verifyHermesChatHistoryCache() throws Exception {
    String key = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
    HermesChatCrypto crypto = new HermesChatCrypto(key);
    File directory = new File(
      getTargetContext().getCacheDir(),
      "hermes-chat-history-test-" + System.nanoTime()
    );
    HermesChatHistoryStore history = new HermesChatHistoryStore(directory, "primary", crypto);
    long now = 1_800_000_000_000L;
    org.json.JSONObject descriptor = new org.json.JSONObject()
      .put("id", "550e8400-e29b-41d4-a716-446655440099")
      .put("name", "cached.png")
      .put("contentType", "image/png")
      .put("plaintextBytes", 6)
      .put("nonce", "AAECAwQFBgcICQoL");
    HermesChatCrypto.ChatMessage old = new HermesChatCrypto.ChatMessage(
      "550e8400-e29b-41d4-a716-446655440020",
      "agent",
      now - 40L * 24 * 60 * 60 * 1000,
      7,
      "应被定时清理",
      new org.json.JSONArray()
    );
    HermesChatCrypto.ChatMessage recent = new HermesChatCrypto.ChatMessage(
      "550e8400-e29b-41d4-a716-446655440021",
      "agent",
      now - 1_000,
      8,
      "本地加密正文",
      new org.json.JSONArray().put(descriptor)
    );
    history.record(old);
    history.record(recent);

    File[] encryptedFiles = directory.listFiles();
    require(encryptedFiles != null && encryptedFiles.length == 1, "Hermes history was not stored");
    String stored = new String(java.nio.file.Files.readAllBytes(encryptedFiles[0].toPath()));
    require(!stored.contains("本地加密正文"), "Hermes history cache leaked plaintext");

    HermesChatCrypto.ChatMessage finalEdit = new HermesChatCrypto.ChatMessage(
      "550e8400-e29b-41d4-a716-446655440022",
      "agent",
      now,
      9,
      "流式完整正文",
      new org.json.JSONArray(),
      8,
      true
    );
    history.record(finalEdit);
    HermesChatHistoryStore.Snapshot snapshot = history.loadAndCleanup(30, now);
    require(snapshot.lastSequence == 9, "Hermes durable checkpoint was not cached");
    require(snapshot.messages.size() == 1, "Expired Hermes history was not cleaned");
    require(
      "流式完整正文".equals(snapshot.messages.get(0).text),
      "Final stream update did not replace cached text"
    );
    require(
      snapshot.messages.get(0).attachments.length() == 1,
      "Final stream update discarded cached image descriptors"
    );

    HermesChatImageCache images = new HermesChatImageCache(
      new File(directory, "images"),
      "primary"
    );
    byte[] encryptedImage = new byte[22];
    Arrays.fill(encryptedImage, (byte) 0x4A);
    images.write(descriptor, encryptedImage);
    require(
      Arrays.equals(encryptedImage, images.read(descriptor)),
      "Hermes encrypted image cache did not persist"
    );
    images.retain(snapshot.messages);
    require(images.read(descriptor) != null, "Referenced Hermes image was cleaned");

    HermesChatHistoryStore.Snapshot selectedDelete = history.deleteMessages(Set.of(recent.id));
    images.retain(selectedDelete.messages);
    require(selectedDelete.messages.isEmpty(), "Selected Hermes message was retained");
    require(selectedDelete.lastSequence == 9, "Selected delete reset the relay checkpoint");
    require(images.read(descriptor) == null, "Selected message attachment cache was retained");

    HermesChatHistoryStore.Snapshot cleared = history.clearMessages();
    images.retain(cleared.messages);
    require(cleared.messages.isEmpty(), "Manual Hermes history clear kept messages");
    require(cleared.lastSequence == 9, "History clear reset the relay checkpoint");
    require(images.read(descriptor) == null, "Orphaned Hermes image cache was retained");
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
    store.saveHermesChatKey("primary", "primary-chat-key");
    store.saveHermesChatKey("secondary", "secondary-chat-key");
    require(
      "site_admin_session=test-token".equals(store.load()),
      "Android Keystore session round trip failed"
    );
    require(
      "device-id.device-secret".equals(store.loadDeviceToken()),
      "Android Keystore device token round trip failed"
    );
    require(
      "primary-chat-key".equals(store.loadHermesChatKey("primary")),
      "Primary Hermes profile key round trip failed"
    );
    require(
      "secondary-chat-key".equals(store.loadHermesChatKey("secondary")),
      "Secondary Hermes profile key round trip failed"
    );
    store.clearHermesChatKey("primary");
    require(store.loadHermesChatKey("primary").isEmpty(), "Hermes profile key clear failed");
    require(
      "secondary-chat-key".equals(store.loadHermesChatKey("secondary")),
      "Clearing one Hermes profile key cleared another profile"
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

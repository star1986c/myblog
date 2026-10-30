package io.qzz.superstar1014.mynotes;

import android.app.Instrumentation;
import android.content.Intent;
import android.graphics.Bitmap;
import java.io.File;
import java.io.FileOutputStream;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.util.Arrays;

final class HermesVoiceTest {
  static void run(Instrumentation test) throws Exception {
    HermesChatActivity activity = (HermesChatActivity) test.startActivitySync(
      new Intent(test.getTargetContext(), HermesChatActivity.class)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra("demo", true)
        .putExtra(HermesChatActivity.EXTRA_PROFILE_LABEL, "Hermes 语音助手"));
    try {
      Field sending = HermesChatActivity.class.getDeclaredField("attachmentSending");
      sending.setAccessible(true);
      test.runOnMainSync(() -> {
        try { sending.setBoolean(activity, true); } catch (Exception e) { throw new RuntimeException(e); }
        activity.onReady();
      });
      require(!((android.widget.Button) get(activity, "sendButton")).isEnabled(), "Reconnect enabled duplicate sending");
      test.runOnMainSync(() -> {
        try { sending.setBoolean(activity, false); } catch (Exception e) { throw new RuntimeException(e); }
      });
      capture(test, "01-chat");
      invoke(test, activity, "startVoiceRecording");
      require(get(activity, "recorder") != null, "Recorder did not start");
      Thread.sleep(1600);
      capture(test, "02-recording");
      finish(test, activity, true);
      File draft = (File) get(activity, "pendingVoiceFile");
      require(draft != null && draft.length() > 0, "Recording draft missing");
      require("audio/mp4".equals(get(activity, "pendingAttachmentContentType")), "Wrong voice MIME");
      HermesChatCrypto crypto = new HermesChatCrypto(HermesChatCrypto.generateKey());
      byte[] data = Files.readAllBytes(draft.toPath());
      HermesChatCrypto.EncryptedAttachment encrypted = crypto.encryptAttachment(data, "audio/mp4", "语音消息.m4a");
      require(Arrays.equals(data, crypto.decryptAttachment(encrypted.ciphertext, encrypted.descriptor)), "Voice encryption roundtrip failed");
      capture(test, "03-draft");
      invoke(test, activity, "previewVoice");
      require(get(activity, "voicePreview") != null, "Preview did not start");
      capture(test, "04-preview");
      invoke(test, activity, "clearPendingAttachment");
      require(!draft.exists() && get(activity, "voicePreview") == null, "Removal did not clean voice");
      invoke(test, activity, "startVoiceRecording");
      File cancelled = (File) get(activity, "recordingFile");
      Thread.sleep(800);
      finish(test, activity, false);
      require(!cancelled.exists() && get(activity, "pendingVoiceFile") == null, "Cancel retained audio");
      invoke(test, activity, "startVoiceRecording");
      File interrupted = (File) get(activity, "recordingFile");
      Thread.sleep(800);
      test.runOnMainSync(() -> test.callActivityOnPause(activity));
      require(!interrupted.exists() && get(activity, "recorder") == null, "Background retained recorder");
      test.runOnMainSync(() -> test.callActivityOnResume(activity));
    } finally {
      test.runOnMainSync(activity::finish);
    }
  }
  private static Object get(Object object, String name) throws Exception {
    Field field = object.getClass().getDeclaredField(name); field.setAccessible(true); return field.get(object);
  }
  private static void invoke(Instrumentation test, Object object, String name) throws Exception {
    Method method = object.getClass().getDeclaredMethod(name); method.setAccessible(true);
    test.runOnMainSync(() -> { try { method.invoke(object); } catch (Exception e) { throw new RuntimeException(e); } });
  }
  private static void finish(Instrumentation test, Object object, boolean keep) throws Exception {
    Method method = object.getClass().getDeclaredMethod("finishVoiceRecording", boolean.class, boolean.class);
    method.setAccessible(true);
    test.runOnMainSync(() -> { try { method.invoke(object, keep, false); } catch (Exception e) { throw new RuntimeException(e); } });
  }
  private static void capture(Instrumentation test, String name) throws Exception {
    test.waitForIdleSync(); Thread.sleep(250);
    Bitmap image = test.getUiAutomation().takeScreenshot();
    File directory = new File(test.getTargetContext().getExternalFilesDir(null), "voice-qa"); directory.mkdirs();
    try (FileOutputStream out = new FileOutputStream(new File(directory, name + ".png"))) {
      image.compress(Bitmap.CompressFormat.PNG, 100, out);
    }
    image.recycle();
  }
  private static void require(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
}

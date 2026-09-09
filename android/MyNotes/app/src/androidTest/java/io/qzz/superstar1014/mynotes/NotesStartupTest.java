package io.qzz.superstar1014.mynotes;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import javax.crypto.SecretKey;

final class NotesStartupTest {
  private static final String RAW_KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";

  static void run(Instrumentation test) throws Exception {
    Context context = test.getTargetContext();
    NotesSnapshotStore store = new NotesSnapshotStore(context);
    SecureSessionStore secure = new SecureSessionStore(context);
    SecretKey key = CryptoEngine.importDataKey(RAW_KEY);
    Models.NoteContent content = new Models.NoteContent("启动缓存测试", "本机缓存正文", null);
    JSONObject envelope = CryptoEngine.encryptNote(key, "startup-note", content)
      .put("revision", 1).put("updatedAt", "2026-09-09T00:00:00Z");
    Models.NoteDocument note = new Models.NoteDocument(Models.NoteEnvelope.fromJson(envelope), content);
    Models.User user = new Models.User("startup-test", false);
    JSONObject captured = NotesSnapshotStore.capture(user, NotesSnapshotStore.fingerprint(key), List.of(), List.of(note));
    store.clear();
    store.save(captured, store.generation());
    check(new NotesSnapshotStore(context).load().notes.get(0).content.content.equals("本机缓存正文"), "Cold disk round trip");
    File file = new File(context.getNoBackupFilesDir(), "notes-reading-v1");
    byte[] bytes = Files.readAllBytes(file.toPath());
    check(!new String(bytes, StandardCharsets.UTF_8).contains("本机缓存正文"), "No plaintext on disk");
    bytes[bytes.length - 1] ^= 1;
    Files.write(file.toPath(), bytes);
    check(store.load() == null && !file.exists(), "Tampered cache must be discarded");
    long oldGeneration = store.generation();
    store.clear();
    store.save(captured, oldGeneration);
    check(store.load() == null, "Late writes must not restore a cleared snapshot");

    Models.NoteContent protectedContent = new Models.NoteContent("protected", "UNLOCKED-SECRET",
      new Models.ProtectedBody(1, "wrapped", "nonce"), "UNLOCKED-ATTACHMENT-KEY");
    JSONObject protectedEnvelope = new JSONObject(envelope.toString()).put("id", "protected").put("isLocked", true);
    Models.NoteDocument protectedNote = new Models.NoteDocument(Models.NoteEnvelope.fromJson(protectedEnvelope), protectedContent);
    protectedNote.unlocked = true;
    JSONObject protectedSnapshot = NotesSnapshotStore.capture(user, NotesSnapshotStore.fingerprint(key), List.of(), List.of(protectedNote));
    check(!protectedSnapshot.toString().contains("UNLOCKED-"), "Unlocked secrets excluded before cache encryption");
    store.save(protectedSnapshot, store.generation());
    check(!store.load().notes.get(0).unlocked && store.load().notes.get(0).content.content.isEmpty(), "Protected cache remains locked");
    secure.clearAuthentication();
    check(store.load() == null, "Authentication revocation clears reading cache");

    try (LocalServer server = new LocalServer(envelope)) {
      secure.save("site_admin_session=startup-test");
      secure.saveDeviceToken("startup-test-token");
      server.refreshToken = true;
      check(new NotesApiClient(context, server.url()).restoreSession().authenticated, "Device token restores session");
      check(server.count("/api/auth/me") == 1 && server.count("/api/auth/token") == 1,
        "Expired cookie recovery should use one session probe and one token exchange");
      server.refreshToken = false;
      store.save(captured, store.generation());
      MainActivity activity = (MainActivity) test.startActivitySync(new Intent(context, MainActivity.class)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra("demo", true).putExtra(MainActivity.EXTRA_OPEN_NOTES, true));
      try {
        test.runOnMainSync(() -> {
          try {
            set(activity, "demoMode", false);
            set(activity, "api", new NotesApiClient(context, server.url()));
            set(activity, "dataKey", null);
            set(activity, "user", null);
            ((List<?>) get(activity, "notes")).clear();
            ((List<?>) get(activity, "folders")).clear();
            ((List<?>) get(activity, "trash")).clear();
            invoke(activity, "restoreCachedNotes");
          } catch (Exception error) { throw new RuntimeException(error); }
        });
        check(server.parallelReads.await(5, TimeUnit.SECONDS), "Key and protection reads must start in parallel before sync");
        test.runOnMainSync(() -> {
          try {
            check(!((Boolean) get(activity, "notesReady")), "Cache stays read-only before sync finishes");
            check(((List<?>) get(activity, "notes")).size() == 1, "Cache visible while requests are pending");
            int oldSize = ((List<?>) get(activity, "notes")).size();
            invoke(activity, "createNote");
            check(((List<?>) get(activity, "notes")).size() == oldSize, "Read-only cache blocks note creation");
            check(hasText(activity.getWindow().getDecorView(), "本机笔记只读"), "Read-only status visible");
          } catch (Exception error) { throw new RuntimeException(error); }
        });
        check(server.count("/api/admin/encrypted-notes-trash") == 0, "Trash does not delay the first screen");
        server.releaseReads.countDown();
        waitFor(test, activity, "notesReady", true);
        test.runOnMainSync(() -> {
          try {
            List<?> loaded = (List<?>) get(activity, "notes");
            check(((Models.NoteDocument) loaded.get(0)).content.content.equals("本机缓存正文"), "Synced note readable");
            invoke(activity, "loadTrash");
          } catch (Exception error) { throw new RuntimeException(error); }
        });
        waitFor(test, activity, "trashLoaded", true);
        check(server.count("/api/admin/encrypted-notes-trash") == 1, "Trash loads on demand");

        // Upgrade the same server: MainActivity must switch to cursor sync and
        // retain its current note on an empty delta without full-list requests.
        server.incremental = true;
        test.runOnMainSync(() -> {
          try { invoke(activity, "loadAllData"); }
          catch (Exception error) { throw new RuntimeException(error); }
        });
        waitFor(test, activity, "notesReady", true);
        int fullReads = server.count("/api/admin/encrypted-notes");
        test.runOnMainSync(() -> {
          try { invoke(activity, "loadAllData"); }
          catch (Exception error) { throw new RuntimeException(error); }
        });
        waitFor(test, activity, "notesReady", true);
        check(server.count("/api/admin/encrypted-notes") == fullReads, "Incremental refresh never downloads full lists");
        check(server.count("/api/admin/notes-sync?cursor=test%3A1") == 1, "MainActivity reuses durable cursor");

        JSONObject changed = CryptoEngine.encryptNote(key, "startup-note",
          new Models.NoteContent("更新后的笔记", "服务器更新正文", null));
        server.note.put("revision", 2).put("ciphertext", changed.getString("ciphertext"))
          .put("nonce", changed.getString("nonce"));
        server.syncRevision = 2;
        test.runOnMainSync(() -> {
          try { invoke(activity, "loadAllData"); }
          catch (Exception error) { throw new RuntimeException(error); }
        });
        waitFor(test, activity, "notesReady", true);
        test.runOnMainSync(() -> {
          try {
            Models.NoteDocument updated = (Models.NoteDocument) ((List<?>) get(activity, "notes")).get(0);
            check(updated.content.content.equals("服务器更新正文"), "Changed revisions must be decrypted again");
            set(activity, "dirty", true);
            invoke(activity, "loadAllData");
            check((Boolean) get(activity, "notesReady"), "Unsaved edits must prevent replacement sync");
            set(activity, "dirty", false);
          } catch (Exception error) { throw new RuntimeException(error); }
        });

        server.disconnect = true;
        test.runOnMainSync(() -> {
          try { invoke(activity, "restoreSession"); }
          catch (Exception error) { throw new RuntimeException(error); }
        });
        waitFor(test, activity, "syncInProgress", false);
        test.runOnMainSync(() -> {
          try {
            check(!((Boolean) get(activity, "notesReady")), "Disconnected requests leave cache read-only");
            check(((List<?>) get(activity, "notes")).size() == 1, "Disconnected requests retain reading data");
          } catch (Exception error) { throw new RuntimeException(error); }
        });
        server.disconnect = false;

        // A transient server failure retains the cache and does not permit edits.
        server.failureStatus = 503;
        test.runOnMainSync(() -> {
          try { invoke(activity, "restoreSession"); }
          catch (Exception error) { throw new RuntimeException(error); }
        });
        waitFor(test, activity, "syncInProgress", false);
        test.runOnMainSync(() -> {
          try {
            check(!((Boolean) get(activity, "notesReady")), "Transient failure keeps notes read-only");
            check(((List<?>) get(activity, "notes")).size() == 1, "Transient failure preserves reading data");
          } catch (Exception error) { throw new RuntimeException(error); }
        });
        check(!secure.loadDeviceToken().isEmpty(), "503 preserves device token");
        server.failureStatus = 401;
        test.runOnMainSync(() -> {
          try { invoke(activity, "restoreSession"); }
          catch (Exception error) { throw new RuntimeException(error); }
        });
        waitFor(test, activity, "syncInProgress", false);
        test.runOnMainSync(() -> {
          try {
            check(get(activity, "user") == null && ((List<?>) get(activity, "notes")).isEmpty(), "401 clears visible data");
          } catch (Exception error) { throw new RuntimeException(error); }
        });
        check(store.load() == null && secure.loadDeviceToken().isEmpty(), "401 clears disk cache and credentials");
      } finally {
        server.releaseReads.countDown();
        test.runOnMainSync(activity::finish);
      }
    } finally {
      secure.clearAuthentication();
      store.clear();
    }

    Instrumentation.ActivityMonitor monitor = test.addMonitor(HermesConversationsActivity.class.getName(),
      new Instrumentation.ActivityResult(Activity.RESULT_CANCELED, new Intent()), true);
    try {
      Activity launcher = test.startActivitySync(new Intent(context, MainActivity.class)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
      test.waitForIdleSync();
      check(monitor.getHits() == 1, "Normal launcher opens Hermes by default");
      check(get(launcher, "api") == null, "Default launcher does not initialize or synchronize notes");
    } finally {
      test.removeMonitor(monitor);
    }
  }

  private static void waitFor(Instrumentation test, Activity activity, String field, boolean expected) throws Exception {
    long end = System.currentTimeMillis() + 8_000;
    boolean[] done = { false };
    while (System.currentTimeMillis() < end) {
      test.runOnMainSync(() -> {
        try { done[0] = ((Boolean) get(activity, field)) == expected; }
        catch (Exception error) { throw new RuntimeException(error); }
      });
      if (done[0]) return;
      Thread.sleep(30);
    }
    throw new AssertionError("Timed out waiting for " + field + "=" + expected);
  }

  private static Object get(Object target, String name) throws Exception {
    Field field = target.getClass().getDeclaredField(name);
    field.setAccessible(true);
    return field.get(target);
  }

  private static void set(Object target, String name, Object value) throws Exception {
    Field field = target.getClass().getDeclaredField(name);
    field.setAccessible(true);
    field.set(target, value);
  }

  private static void invoke(Object target, String name) throws Exception {
    Method method = target.getClass().getDeclaredMethod(name);
    method.setAccessible(true);
    method.invoke(target);
  }

  private static boolean hasText(View view, String value) {
    if (view instanceof TextView && ((TextView) view).getText().toString().contains(value)) return true;
    if (view instanceof ViewGroup) {
      ViewGroup group = (ViewGroup) view;
      for (int i = 0; i < group.getChildCount(); i++) if (hasText(group.getChildAt(i), value)) return true;
    }
    return false;
  }

  private static void check(boolean condition, String message) {
    if (!condition) throw new AssertionError(message);
  }

  private static final class LocalServer implements AutoCloseable {
    final ServerSocket server = new ServerSocket(0, 10, java.net.InetAddress.getByName("127.0.0.1"));
    final ExecutorService pool = Executors.newCachedThreadPool();
    final CountDownLatch parallelReads = new CountDownLatch(2);
    final CountDownLatch releaseReads = new CountDownLatch(1);
    final Map<String, AtomicInteger> counts = new ConcurrentHashMap<>();
    final JSONObject note;
    volatile boolean refreshToken;
    volatile boolean disconnect;
    volatile int failureStatus;
    volatile boolean incremental;
    volatile int syncRevision = 1;

    LocalServer(JSONObject note) throws Exception {
      this.note = note;
      pool.submit(() -> {
        while (!server.isClosed()) {
          try {
            Socket socket = server.accept();
            pool.submit(() -> respond(socket));
          } catch (Exception ignored) { return; }
        }
      });
    }

    String url() { return "http://127.0.0.1:" + server.getLocalPort() + "/"; }
    int count(String path) { return counts.getOrDefault(path, new AtomicInteger()).get(); }

    void respond(Socket socket) {
      try (socket) {
        BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
        String first = reader.readLine();
        if (first == null) return;
        String path = first.split(" ")[1];
        String line;
        while ((line = reader.readLine()) != null && !line.isEmpty()) { }
        counts.computeIfAbsent(path, ignored -> new AtomicInteger()).incrementAndGet();
        if (disconnect) return;
        JSONObject result = new JSONObject();
        if (path.equals("/api/auth/me") || path.equals("/api/auth/token")) {
          result.put("authenticated", !refreshToken || path.endsWith("token"))
            .put("csrfToken", "test-csrf").put("deviceToken", "test-rotated-token")
            .put("user", new JSONObject().put("username", "startup-test"));
        } else if (path.equals("/api/admin/workspace-key")) {
          result.put("workspaceKey", new JSONObject().put("key", RAW_KEY));
        } else if (path.equals("/api/admin/note-protection-keyring")) {
          result.put("keyring", JSONObject.NULL);
        } else if (path.equals("/api/admin/encrypted-note-folders")) {
          result.put("folders", new JSONArray());
        } else if (path.equals("/api/admin/encrypted-notes")) {
          result.put("notes", new JSONArray().put(note));
        } else if (path.equals("/api/admin/encrypted-notes-trash")) {
          result.put("notes", new JSONArray());
        } else if (path.startsWith("/api/admin/notes-sync") && incremental) {
          String cursor = "test:" + syncRevision;
          String previous = path.contains("?cursor=")
            ? java.net.URLDecoder.decode(path.substring(path.indexOf("?cursor=") + 8), StandardCharsets.UTF_8) : "";
          JSONArray changes = new JSONArray();
          if (!previous.equals(cursor)) changes.put(new JSONObject().put("kind", "note")
            .put("id", note.getString("id")).put("deleted", false).put("note", note));
          result.put("version", 1).put("reset", previous.isEmpty()).put("hasMore", false)
            .put("cursor", cursor).put("changes", changes);
        }
        if (path.startsWith("/api/admin/") && !path.endsWith("trash")) {
          parallelReads.countDown();
          releaseReads.await(8, TimeUnit.SECONDS);
        }
        int status = failureStatus == 0 ? (path.startsWith("/api/admin/notes-sync") && !incremental ? 404 : 200) : failureStatus;
        byte[] body = result.toString().getBytes(StandardCharsets.UTF_8);
        socket.getOutputStream().write(("HTTP/1.1 " + status + " Test\r\nContent-Type: application/json\r\nContent-Length: "
          + body.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        socket.getOutputStream().write(body);
      } catch (Exception ignored) { }
    }

    public void close() throws Exception {
      releaseReads.countDown();
      server.close();
      pool.shutdownNow();
    }
  }
}

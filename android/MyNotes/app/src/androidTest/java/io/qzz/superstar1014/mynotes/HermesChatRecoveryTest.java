package io.qzz.superstar1014.mynotes;

import android.app.Instrumentation;
import android.content.Context;
import org.json.JSONArray;
import org.json.JSONObject;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.AbstractExecutorService;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;
import okhttp3.Request;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/** Runs real client/manager methods with offline transports on a clean emulator. */
final class HermesChatRecoveryTest {
  static void run(Instrumentation test) throws Exception {
    Throwable[] failure = {null};
    test.runOnMainSync(() -> {
      try {
        verifyProbeAndReplay();
        verifyNetworkRecovery(test.getTargetContext().getApplicationContext());
      } catch (Throwable error) { failure[0] = error; }
    });
    if (failure[0] != null) throw new AssertionError("Connection recovery failed", failure[0]);
  }

  private static void verifyProbeAndReplay() throws Exception {
    RecordingListener listener = new RecordingListener();
    HermesChatClient client = new HermesChatClient(listener);
    try {
      FakeSocket first = new FakeSocket();
      set(client, "socket", first);
      client.checkConnection();
      client.checkConnection();
      check(first.sent.equals(List.of("ping")), "coalesce foreground probes");
      WebSocketListener callbacks = callbacks(client, List.of(), Map.of());
      callbacks.onMessage(first, "pong");
      check(get(client, "probeTimeoutTask") == null && client.isConnected(), "pong keeps healthy socket");
      check(listener.disconnects == 0 && listener.errors == 0, "raw pong is not JSON error");
      client.checkConnection();
      check(first.sent.size() == 1, "activity navigation does not repeatedly ping");
      set(client, "lastProbeAt", -10_000L);
      client.checkConnection();
      Runnable oldTimeout = (Runnable) get(client, "probeTimeoutTask");
      oldTimeout.run();
      check(first.cancelled && !client.isConnected() && listener.disconnects == 1, "dead socket retired once");
      callbacks.onFailure(first, new Exception("old failure"), null);
      check(listener.disconnects == 1, "late failure ignored");

      FakeSocket second = new FakeSocket();
      set(client, "socket", second);
      set(client, "lastProbeAt", -10_000L);
      client.checkConnection();
      Runnable currentTimeout = (Runnable) get(client, "probeTimeoutTask");
      callbacks.onMessage(first, "pong");
      oldTimeout.run();
      check(get(client, "probeTimeoutTask") == currentTimeout && client.isConnected(), "old timeout/pong cannot affect replacement");
      client.close();
      currentTimeout.run();
      check(get(client, "probeTimeoutTask") == null && listener.disconnects == 1, "close cancels probe");

      FakeSocket ready = new FakeSocket();
      set(client, "socket", ready);
      set(client, "closing", false);
      set(client, "handshakePending", true);
      client.checkConnection();
      check(ready.sent.isEmpty(), "do not probe incomplete handshake");
      String key = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(new byte[32]);
      client.configureProfile("primary", new HermesChatCrypto(key), "key", 7);
      callbacks = callbacks(client, List.of("primary"), Map.of("primary", "key"));
      callbacks.onMessage(ready, "{\"type\":\"ready\",\"multiplex\":true}");
      JSONObject replay = new JSONObject(ready.sent.get(0));
      check("resume".equals(replay.getString("type")) && replay.getLong("afterSeq") == 7,
        "replacement ready retains incremental replay checkpoint");
      check(listener.ready == 1, "ready after handshake");
      ready.accepts = false;
      client.checkConnection();
      check(!client.isConnected() && listener.disconnects == 2, "rejected ping fails immediately");
    } finally { client.shutdown(); }
  }

  private static void verifyNetworkRecovery(Context context) throws Exception {
    check(new HermesChatProfileStore(context).load().isEmpty(), "use a clean emulator profile");
    HermesChatConnectionManager manager = HermesChatConnectionManager.get(context);
    ExecutorService original = (ExecutorService) get(manager, "executor");
    QueuedExecutor queued = new QueuedExecutor();
    set(manager, "executor", queued); // No authentication, HTTP or real chat data in this test.
    HermesChatRecoveryMonitor monitor = (HermesChatRecoveryMonitor) get(manager, "recoveryMonitor");
    HermesChatRecoveryMonitor.Listener recovery = (HermesChatRecoveryMonitor.Listener) get(monitor, "listener");
    try {
      set(monitor, "available", false);
      String key = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(new byte[32]);
      manager.attach("recovery-qa", "Recovery QA", key, 7, new HermesChatConnectionManager.Listener() {
        public void onConnecting() {}
        public void onReady() {}
        public void onMessage(HermesChatCrypto.ChatMessage message) {}
        public void onAcknowledged(String id, long sequence) {}
        public void onActionAcknowledged(String id, boolean delivered) {}
        public void onTyping(boolean active) {}
        public void onDisconnected(String reason) {}
      });
      recovery.onForeground();
      check(queued.tasks.isEmpty() && get(manager, "reconnectTask") == null, "offline has no retry polling");
      set(monitor, "available", true);
      recovery.onNetworkChanged(true);
      check(queued.tasks.size() == 1, "network recovery immediately requests one ticket");
      recovery.onForeground();
      manager.reconnect();
      check(queued.tasks.size() == 1, "foreground/manual recovery coalesces while connecting");
      long firstAttempt = (long) get(manager, "connectionAttempt");
      recovery.onNetworkChanged(true);
      check(queued.tasks.size() == 2 && (long) get(manager, "connectionAttempt") > firstAttempt,
        "network switch invalidates pending connection");
      set(monitor, "available", false);
      recovery.onNetworkChanged(false);
      recovery.onForeground();
      check(queued.tasks.size() == 2 && get(manager, "reconnectTask") == null, "network loss stops retry");
      set(monitor, "available", true);
      recovery.onForeground();
      check(queued.tasks.size() == 3, "foreground recovers a disconnected session");
      manager.shutdown();
      recovery.onNetworkChanged(true);
      recovery.onForeground();
      check(queued.tasks.size() == 3, "logout never reconnects");
    } finally {
      manager.shutdown();
      set(manager, "executor", original);
    }
  }

  private static WebSocketListener callbacks(HermesChatClient client, List<String> profiles, Map<String, String> tokens) throws Exception {
    Class<?> type = Class.forName(HermesChatClient.class.getName() + "$SocketListener");
    Constructor<?> constructor = type.getDeclaredConstructor(HermesChatClient.class, List.class, Map.class);
    constructor.setAccessible(true);
    return (WebSocketListener) constructor.newInstance(client, profiles, tokens);
  }
  private static Object get(Object object, String name) throws Exception {
    Field field = object.getClass().getDeclaredField(name);
    field.setAccessible(true);
    return field.get(object);
  }
  private static void set(Object object, String name, Object value) throws Exception {
    Field field = object.getClass().getDeclaredField(name);
    field.setAccessible(true);
    field.set(object, value);
  }
  private static void check(boolean condition, String message) {
    if (!condition) throw new AssertionError(message);
  }
  private static final class FakeSocket implements WebSocket {
    final List<String> sent = new ArrayList<>();
    boolean cancelled, accepts = true;
    public Request request() { return new Request.Builder().url("https://example.invalid").build(); }
    public long queueSize() { return 0; }
    public boolean send(String text) { sent.add(text); return accepts; }
    public boolean send(ByteString bytes) { throw new AssertionError("unexpected binary frame"); }
    public boolean close(int code, String reason) { return true; }
    public void cancel() { cancelled = true; }
  }
  private static final class QueuedExecutor extends AbstractExecutorService {
    final List<Runnable> tasks = new ArrayList<>();
    public void execute(Runnable task) { tasks.add(task); }
    public void shutdown() {}
    public List<Runnable> shutdownNow() { return List.of(); }
    public boolean isShutdown() { return false; }
    public boolean isTerminated() { return false; }
    public boolean awaitTermination(long timeout, TimeUnit unit) { return true; }
  }
  private static final class RecordingListener implements HermesChatClient.Listener {
    int disconnects, errors, ready;
    public void onReady() { ready++; }
    public void onDisconnected(String reason) { disconnects++; }
    public void onMessage(String space, HermesChatCrypto.ChatMessage message, String token) {}
    public void onAcknowledged(String space, String id, long sequence, String token) {}
    public void onActionAcknowledged(String space, String id, boolean delivered, String token) {}
    public void onTyping(String space, boolean active, boolean terminal, String token) {}
    public void onProfileError(String space, String reason, String token) { errors++; }
  }
}

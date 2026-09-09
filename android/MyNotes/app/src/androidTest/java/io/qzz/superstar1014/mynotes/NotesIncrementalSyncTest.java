package io.qzz.superstar1014.mynotes;

import android.app.Instrumentation;
import android.content.Context;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.io.File;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Queue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.crypto.SecretKey;

final class NotesIncrementalSyncTest {
  static void run(Instrumentation test) throws Exception {
    Context context = test.getTargetContext();
    SecretKey key = CryptoEngine.importDataKey("AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE");
    NotesSyncStore store = new NotesSyncStore(context);
    store.clear();
    JSONObject note = CryptoEngine.encryptNote(key, "sync-note", new Models.NoteContent("增量测试", "private-body", null))
      .put("revision", 1);
    try (Server server = new Server()) {
      NotesApiClient api = new NotesApiClient(context, server.url());
      String scope = api.notesSyncScope("sync-test");
      server.enqueue(200, page("e:1", true, true, change(note)));
      JSONObject folder = new JSONObject().put("id", "folder-a").put("version", 1).put("revision", 1)
        .put("ciphertext", "encrypted-name").put("nonce", "nonce").put("sortOrder", 3);
      server.enqueue(200, page("e:2", false, false, new JSONObject().put("kind", "folder")
        .put("id", "folder-a").put("deleted", false).put("folder", folder)));
      JSONObject initial = store.fetch(api, scope, key);
      check(initial.getJSONObject("notes").length() == 1, "Bootstrap note");
      check(initial.getJSONObject("folders").length() == 1, "Bootstrap folder");
      store.save(initial, scope, key, store.generation());
      check(new NotesSyncStore(context).load(scope, key).getString("cursor").equals("e:2"), "Restart retains cursor and data");
      check(store.load(api.notesSyncScope("another-account"), key) == null, "Account isolation");
      SecretKey otherKey = CryptoEngine.importDataKey("AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI");
      check(store.load(scope, otherKey) == null, "Changed workspace key discards cache");

      server.enqueue(200, page("e:2", false, false));
      JSONObject idle = store.fetch(api, scope, key);
      check(idle.getJSONObject("notes").length() == 1, "Empty delta retains notes");
      check(server.queries.equals(List.of("", "e:1", "e:2")), "Only cursor requests after bootstrap");

      JSONObject trashed = new JSONObject(note.toString()).put("deletedAt", "now").put("revision", 2);
      server.enqueue(200, page("e:3", false, true, change(trashed)));
      server.enqueue(503, new JSONObject().put("error", "offline"));
      boolean failed = false;
      try { store.fetch(api, scope, key); } catch (NotesApiClient.ApiException error) { failed = error.status == 503; }
      check(failed, "Interrupted page fails the entire sync");
      check(store.load(scope, key).getString("cursor").equals("e:2"), "Partial page cannot advance durable cursor");
      check(!store.load(scope, key).getJSONObject("notes").getJSONObject("sync-note").has("deletedAt"), "Partial state not persisted");

      server.enqueue(200, page("e:4", false, false, change(trashed)));
      JSONObject trash = store.fetch(api, scope, key);
      check(trash.getJSONObject("notes").getJSONObject("sync-note").getString("deletedAt").equals("now"), "Trash transition");
      store.save(trash, scope, key, store.generation());
      server.enqueue(200, page("e:5", false, false,
        new JSONObject().put("kind", "note").put("id", "sync-note").put("deleted", true),
        new JSONObject().put("kind", "folder").put("id", "folder-a").put("deleted", true)));
      JSONObject deleted = store.fetch(api, scope, key);
      check(deleted.getJSONObject("notes").length() == 0 && deleted.getJSONObject("folders").length() == 0, "Permanent tombstones remove entries");
      store.save(deleted, scope, key, store.generation());
      server.enqueue(200, page("new:1", true, false, change(note)));
      JSONObject reset = store.fetch(api, scope, key);
      check(reset.getJSONObject("notes").length() == 1 && reset.getJSONObject("folders").length() == 0, "Epoch reset replaces cache");
      store.save(reset, scope, key, store.generation());

      File file = new File(context.getNoBackupFilesDir(), "notes-sync-v1").listFiles()[0];
      byte[] bytes = Files.readAllBytes(file.toPath());
      check(!new String(bytes, StandardCharsets.UTF_8).contains("private-body"), "Cache is encrypted");
      bytes[bytes.length - 1] ^= 1;
      Files.write(file.toPath(), bytes);
      check(store.load(scope, key) == null, "Corrupt cache is rejected");
      server.enqueue(200, page("new:1", true, false, change(note)));
      JSONObject rebuilt = store.fetch(api, scope, key);
      check(server.queries.get(server.queries.size() - 1).equals(""), "Corrupt cache requests bootstrap");
      long generation = store.generation();
      new SecureSessionStore(context).clearAuthentication();
      store.save(rebuilt, scope, key, generation);
      check(store.load(scope, key) == null, "Logout rejects late cache writes");
    } finally { store.clear(); }
  }

  private static JSONObject change(JSONObject note) throws Exception {
    return new JSONObject().put("kind", "note").put("id", note.getString("id")).put("deleted", false).put("note", note);
  }
  private static JSONObject page(String cursor, boolean reset, boolean more, JSONObject... changes) throws Exception {
    JSONArray array = new JSONArray();
    for (JSONObject change : changes) array.put(change);
    return new JSONObject().put("version", 1).put("cursor", cursor).put("reset", reset)
      .put("hasMore", more).put("changes", array);
  }
  private static void check(boolean condition, String label) { if (!condition) throw new AssertionError(label); }

  private static final class Server implements AutoCloseable {
    private final ServerSocket server = new ServerSocket(0, 10, java.net.InetAddress.getByName("127.0.0.1"));
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Queue<Response> responses = new ArrayDeque<>();
    final List<String> queries = java.util.Collections.synchronizedList(new ArrayList<>());
    Server() throws Exception {
      executor.submit(() -> {
        while (!server.isClosed()) {
          try (Socket socket = server.accept()) {
            BufferedReader input = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
            String request = input.readLine();
            String line;
            while ((line = input.readLine()) != null && !line.isEmpty()) { }
            URI uri = URI.create(request.split(" ")[1]);
            check(uri.getPath().equals("/api/admin/notes-sync"), "No full-list API calls");
            queries.add(uri.getRawQuery() == null ? "" : URLDecoder.decode(uri.getRawQuery().substring(7), StandardCharsets.UTF_8));
            Response response;
            synchronized (responses) { response = responses.remove(); }
            byte[] body = response.body.toString().getBytes(StandardCharsets.UTF_8);
            socket.getOutputStream().write(("HTTP/1.1 " + response.status + " Test\r\nContent-Type: application/json\r\nContent-Length: "
              + body.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
            socket.getOutputStream().write(body);
          } catch (Exception error) { if (!server.isClosed()) throw new RuntimeException(error); }
        }
      });
    }
    String url() { return "http://127.0.0.1:" + server.getLocalPort() + "/"; }
    void enqueue(int status, JSONObject body) { synchronized (responses) { responses.add(new Response(status, body)); } }
    public void close() throws Exception { server.close(); executor.shutdownNow(); }
  }
  private static final class Response {
    final int status;
    final JSONObject body;
    Response(int status, JSONObject body) { this.status = status; this.body = body; }
  }
}

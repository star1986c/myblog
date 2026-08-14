package io.qzz.superstar1014.mynotes;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

final class NotesApiClient {
  static final String PRODUCTION_BASE_URL = "https://superstar1014.qzz.io/";

  private final SecureSessionStore sessionStore;
  private final String baseUrl;
  private String csrfToken = "";

  NotesApiClient(Context context) {
    this(context, PRODUCTION_BASE_URL);
  }

  NotesApiClient(Context context, String baseUrl) {
    sessionStore = new SecureSessionStore(context);
    this.baseUrl = baseUrl;
  }

  SessionResult restoreSession() throws Exception {
    JSONObject json = request("GET", "api/auth/me", null, null);
    csrfToken = json.optString("csrfToken");
    JSONObject user = json.optJSONObject("user");
    return new SessionResult(
      json.optBoolean("authenticated") && user != null,
      user == null ? null : Models.User.fromJson(user)
    );
  }

  Models.User login(String username, String password) throws Exception {
    JSONObject json = request(
      "POST",
      "api/auth/login",
      new JSONObject().put("username", username).put("password", password),
      null
    );
    csrfToken = json.optString("csrfToken");
    return Models.User.fromJson(json.getJSONObject("user"));
  }

  void logout() throws Exception {
    request("POST", "api/auth/logout", new JSONObject(), null);
    csrfToken = "";
    sessionStore.clear();
  }

  String workspaceKey() throws Exception {
    return request("GET", "api/admin/workspace-key", null, null)
      .getJSONObject("workspaceKey")
      .getString("key");
  }

  Models.ProtectionKeyring protectionKeyring() throws Exception {
    JSONObject value = request("GET", "api/admin/note-protection-keyring", null, null)
      .optJSONObject("keyring");
    return value == null ? null : Models.ProtectionKeyring.fromJson(value);
  }

  Models.ProtectionKeyring createProtectionKeyring(JSONObject payload) throws Exception {
    return Models.ProtectionKeyring.fromJson(
      request("POST", "api/admin/note-protection-keyring", payload, null)
        .getJSONObject("keyring")
    );
  }

  List<Models.NoteEnvelope> listNotes(boolean trash) throws Exception {
    String path = trash ? "api/admin/encrypted-notes-trash" : "api/admin/encrypted-notes";
    JSONArray values = request("GET", path, null, null).getJSONArray("notes");
    List<Models.NoteEnvelope> result = new ArrayList<>();
    for (int index = 0; index < values.length(); index++) {
      result.add(Models.NoteEnvelope.fromJson(values.getJSONObject(index)));
    }
    return result;
  }

  List<Models.FolderEnvelope> listFolders() throws Exception {
    JSONArray values = request("GET", "api/admin/encrypted-note-folders", null, null)
      .getJSONArray("folders");
    List<Models.FolderEnvelope> result = new ArrayList<>();
    for (int index = 0; index < values.length(); index++) {
      result.add(Models.FolderEnvelope.fromJson(values.getJSONObject(index)));
    }
    return result;
  }

  Models.NoteEnvelope createNote(JSONObject payload) throws Exception {
    return Models.NoteEnvelope.fromJson(
      request("POST", "api/admin/encrypted-notes", payload, null).getJSONObject("note")
    );
  }

  Models.NoteEnvelope updateNote(JSONObject payload, int revision) throws Exception {
    String id = payload.getString("id");
    return Models.NoteEnvelope.fromJson(
      request("PUT", "api/admin/encrypted-notes/" + id, payload, revision)
        .getJSONObject("note")
    );
  }

  JSONObject moveToTrash(String id, int revision) throws Exception {
    return request("DELETE", "api/admin/encrypted-notes/" + id, null, revision)
      .getJSONObject("note");
  }

  JSONObject moveNote(String id, String folderId, int revision) throws Exception {
    JSONObject body = new JSONObject();
    if (folderId == null) body.put("folderId", JSONObject.NULL);
    else body.put("folderId", folderId);
    return request("PUT", "api/admin/encrypted-notes/" + id + "/folder", body, revision)
      .getJSONObject("note");
  }

  JSONObject restoreNote(String id, int revision) throws Exception {
    return request("POST", "api/admin/encrypted-notes/" + id + "/restore", null, revision)
      .getJSONObject("note");
  }

  void purgeNote(String id, int revision) throws Exception {
    request("DELETE", "api/admin/encrypted-notes/" + id + "/purge", null, revision);
  }

  Models.FolderEnvelope createFolder(JSONObject payload) throws Exception {
    return Models.FolderEnvelope.fromJson(
      request("POST", "api/admin/encrypted-note-folders", payload, null)
        .getJSONObject("folder")
    );
  }

  Models.FolderEnvelope updateFolder(JSONObject payload, int revision) throws Exception {
    String id = payload.getString("id");
    return Models.FolderEnvelope.fromJson(
      request("PUT", "api/admin/encrypted-note-folders/" + id, payload, revision)
        .getJSONObject("folder")
    );
  }

  void deleteFolder(String id, int revision) throws Exception {
    request("DELETE", "api/admin/encrypted-note-folders/" + id, null, revision);
  }

  void reorderFolders(List<String> folderIds) throws Exception {
    request(
      "PUT",
      "api/admin/encrypted-note-folders/order",
      new JSONObject().put("folderIds", new JSONArray(folderIds)),
      null
    );
  }

  private JSONObject request(String method, String path, JSONObject body, Integer revision)
    throws Exception {
    HttpURLConnection connection = (HttpURLConnection) new URL(baseUrl + path)
      .openConnection();
    connection.setRequestMethod(method);
    connection.setConnectTimeout(15_000);
    connection.setReadTimeout(25_000);
    connection.setUseCaches(false);
    connection.setRequestProperty("Accept", "application/json");
    String cookie = sessionStore.load();
    if (!cookie.isEmpty()) connection.setRequestProperty("Cookie", cookie);
    if (!"GET".equals(method) && !"HEAD".equals(method) && !csrfToken.isEmpty()) {
      connection.setRequestProperty("X-CSRF-Token", csrfToken);
    }
    if (revision != null) connection.setRequestProperty("If-Match", "\"" + revision + "\"");
    if (body != null) {
      byte[] data = body.toString().getBytes(StandardCharsets.UTF_8);
      connection.setDoOutput(true);
      connection.setFixedLengthStreamingMode(data.length);
      connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
      try (OutputStream output = connection.getOutputStream()) {
        output.write(data);
      }
    }

    int status = connection.getResponseCode();
    storeSessionCookie(connection.getHeaderFields());
    InputStream stream = status >= 200 && status < 300
      ? connection.getInputStream()
      : connection.getErrorStream();
    String responseBody = readBody(stream);
    connection.disconnect();

    JSONObject response = responseBody.isEmpty() ? new JSONObject() : new JSONObject(responseBody);
    if (status < 200 || status >= 300) {
      if (status == 401) csrfToken = "";
      throw new ApiException(status, response.optString("error", "请求失败，请稍后重试。"));
    }
    return response;
  }

  private void storeSessionCookie(Map<String, List<String>> headers) {
    for (Map.Entry<String, List<String>> entry : headers.entrySet()) {
      if (entry.getKey() == null || !"Set-Cookie".equalsIgnoreCase(entry.getKey())) continue;
      for (String header : entry.getValue()) {
        String firstPart = header.split(";", 2)[0];
        if (!firstPart.startsWith("site_admin_session=")) continue;
        if (firstPart.equals("site_admin_session=")) {
          sessionStore.clear();
        } else {
          sessionStore.save(firstPart);
        }
      }
    }
  }

  private static String readBody(InputStream stream) throws Exception {
    if (stream == null) return "";
    StringBuilder result = new StringBuilder();
    try (BufferedReader reader = new BufferedReader(
      new InputStreamReader(stream, StandardCharsets.UTF_8)
    )) {
      String line;
      while ((line = reader.readLine()) != null) result.append(line);
    }
    return result.toString();
  }

  static final class SessionResult {
    final boolean authenticated;
    final Models.User user;

    SessionResult(boolean authenticated, Models.User user) {
      this.authenticated = authenticated;
      this.user = user;
    }
  }

  static final class ApiException extends Exception {
    final int status;

    ApiException(int status, String message) {
      super(message);
      this.status = status;
    }
  }
}

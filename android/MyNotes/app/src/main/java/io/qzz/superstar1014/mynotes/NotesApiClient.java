package io.qzz.superstar1014.mynotes;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;

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
    if (!json.optBoolean("authenticated") && !sessionStore.loadDeviceToken().isEmpty()) {
      json = refreshDeviceToken();
    }
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
      new JSONObject()
        .put("username", username)
        .put("password", password)
        .put("rememberDevice", true),
      null
    );
    csrfToken = json.optString("csrfToken");
    sessionStore.saveDeviceToken(json.optString("deviceToken"));
    return Models.User.fromJson(json.getJSONObject("user"));
  }

  void logout() throws Exception {
    try {
      request("POST", "api/auth/logout", new JSONObject(), null);
    } finally {
      csrfToken = "";
      sessionStore.clear();
    }
  }

  Models.User changePassword(
    String username,
    String currentPassword,
    String newPassword
  ) throws Exception {
    JSONObject json = request(
      "PUT",
      "api/admin/account",
      new JSONObject()
        .put("username", username)
        .put("currentPassword", currentPassword)
        .put("newPassword", newPassword),
      null
    );
    csrfToken = json.optString("csrfToken");
    // The Worker revoked every remembered-device token after this change.
    sessionStore.clearDeviceToken();
    return Models.User.fromJson(json.getJSONObject("account"));
  }

  List<Models.HermesChatProfile> hermesChatProfiles() throws Exception {
    return Models.HermesChatProfile.listFromJson(
      request("GET", "api/admin/hermes-chat/profiles", null, null)
    );
  }

  Models.HermesChatTicket hermesChatTicket(String spaceId) throws Exception {
    return Models.HermesChatTicket.fromJson(
      request(
        "POST",
        "api/admin/hermes-chat/ticket",
        new JSONObject().put("spaceId", spaceId),
        null
      )
    );
  }

  Models.HermesChatMultiplexTicket hermesChatMultiplexTicket(
    List<String> spaceIds
  ) throws Exception {
    JSONArray values = new JSONArray();
    for (String spaceId : spaceIds) values.put(spaceId);
    return Models.HermesChatMultiplexTicket.fromJson(
      request(
        "POST",
        "api/admin/hermes-chat/multiplex-ticket",
        new JSONObject().put("spaceIds", values),
        null
      )
    );
  }

  boolean hasCsrfToken() {
    return !csrfToken.isEmpty();
  }

  JSONObject purgeHermesChatCloudData(String spaceId) throws Exception {
    requireFreshAuthenticatedSession();
    return request(
      "POST",
      "api/admin/hermes-chat/cleanup",
      new JSONObject().put("spaceId", spaceId),
      null
    );
  }

  JSONObject deleteHermesChatMessages(
    String spaceId,
    Set<String> messageIds,
    Set<String> attachmentIds
  ) throws Exception {
    requireFreshAuthenticatedSession();
    JSONArray messages = new JSONArray();
    for (String messageId : messageIds) messages.put(messageId);
    JSONArray attachments = new JSONArray();
    for (String attachmentId : attachmentIds) attachments.put(attachmentId);
    return request(
      "POST",
      "api/admin/hermes-chat/messages/delete",
      new JSONObject()
        .put("spaceId", spaceId)
        .put("messageIds", messages)
        .put("attachmentIds", attachments),
      null
    );
  }

  void uploadHermesChatAttachment(
    String spaceId,
    String attachmentId,
    byte[] encryptedBody
  ) throws Exception {
    requireFreshAuthenticatedSession();
    HttpURLConnection connection = open(
      "POST",
      "api/hermes-chat/attachments/" + attachmentId
    );
    connection.setDoOutput(true);
    connection.setFixedLengthStreamingMode(encryptedBody.length);
    connection.setRequestProperty("Accept", "application/json");
    connection.setRequestProperty("Content-Type", "application/octet-stream");
    connection.setRequestProperty("X-Hermes-Space", spaceId);
    if (!csrfToken.isEmpty()) connection.setRequestProperty("X-CSRF-Token", csrfToken);
    try (OutputStream output = connection.getOutputStream()) {
      output.write(encryptedBody);
    }
    readJsonResponse(connection);
  }

  byte[] downloadHermesChatAttachment(String spaceId, String attachmentId) throws Exception {
    HttpURLConnection connection = open(
      "GET",
      "api/hermes-chat/attachments/" + attachmentId
    );
    connection.setRequestProperty("Accept", "application/octet-stream");
    connection.setRequestProperty("X-Hermes-Space", spaceId);
    int status = connection.getResponseCode();
    storeSessionCookie(connection.getHeaderFields());
    if (status < 200 || status >= 300) {
      String responseBody = readBody(connection.getErrorStream());
      connection.disconnect();
      JSONObject response = responseBody.isEmpty() ? new JSONObject() : new JSONObject(responseBody);
      throw new ApiException(status, response.optString("error", "图片下载失败。"));
    }
    byte[] data = readBytes(connection.getInputStream(), Models.MAX_ATTACHMENT_BYTES + 16);
    connection.disconnect();
    return data;
  }

  private void requireFreshAuthenticatedSession() throws Exception {
    SessionResult session = restoreSession();
    if (!session.authenticated || csrfToken.isEmpty()) {
      throw new ApiException(401, "登录状态已失效，请重新登录。");
    }
  }

  private JSONObject refreshDeviceToken() throws Exception {
    String token = sessionStore.loadDeviceToken();
    HttpURLConnection connection = open("POST", "api/auth/token");
    connection.setRequestProperty("Accept", "application/json");
    connection.setRequestProperty("Authorization", "Bearer " + token);
    connection.setFixedLengthStreamingMode(0);
    connection.setDoOutput(true);
    try (OutputStream ignored = connection.getOutputStream()) {
      // An empty body makes this an explicit POST without exposing the token in JSON.
    }
    try {
      JSONObject json = readJsonResponse(connection);
      sessionStore.saveDeviceToken(json.getString("deviceToken"));
      return new JSONObject(json.toString()).put("authenticated", true);
    } catch (Exception error) {
      if (error instanceof ApiException && ((ApiException) error).status == 401) {
        sessionStore.clear();
      }
      throw error;
    }
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

  List<Models.AttachmentEnvelope> listAttachments(String noteId) throws Exception {
    JSONArray values = request(
      "GET",
      "api/admin/encrypted-notes/" + noteId + "/attachments",
      null,
      null
    ).getJSONArray("attachments");
    List<Models.AttachmentEnvelope> result = new ArrayList<>();
    for (int index = 0; index < values.length(); index++) {
      result.add(Models.AttachmentEnvelope.fromJson(values.getJSONObject(index)));
    }
    return result;
  }

  Models.AttachmentEnvelope uploadAttachment(JSONObject payload, byte[] encryptedBody)
    throws Exception {
    String noteId = payload.getString("noteId");
    String attachmentId = payload.getString("id");
    HttpURLConnection connection = open(
      "POST",
      "api/admin/encrypted-notes/" + noteId + "/attachments/" + attachmentId
    );
    connection.setDoOutput(true);
    connection.setFixedLengthStreamingMode(encryptedBody.length);
    connection.setRequestProperty("Accept", "application/json");
    connection.setRequestProperty("Content-Type", "application/octet-stream");
    connection.setRequestProperty("X-Attachment-Version", String.valueOf(payload.getInt("version")));
    connection.setRequestProperty("X-Attachment-Ciphertext", payload.getString("ciphertext"));
    connection.setRequestProperty("X-Attachment-Nonce", payload.getString("nonce"));
    connection.setRequestProperty("X-Attachment-Locked", String.valueOf(payload.getBoolean("isLocked")));
    connection.setRequestProperty("X-Attachment-Support", "1");
    if (!csrfToken.isEmpty()) connection.setRequestProperty("X-CSRF-Token", csrfToken);
    try (OutputStream output = connection.getOutputStream()) {
      output.write(encryptedBody);
    }
    JSONObject response = readJsonResponse(connection);
    return Models.AttachmentEnvelope.fromJson(response.getJSONObject("attachment"));
  }

  byte[] downloadAttachment(String noteId, String attachmentId) throws Exception {
    HttpURLConnection connection = open(
      "GET",
      "api/admin/encrypted-notes/" + noteId + "/attachments/" + attachmentId + "/content"
    );
    connection.setRequestProperty("Accept", "application/octet-stream");
    connection.setRequestProperty("X-Attachment-Support", "1");
    int status = connection.getResponseCode();
    storeSessionCookie(connection.getHeaderFields());
    if (status < 200 || status >= 300) {
      String responseBody = readBody(connection.getErrorStream());
      connection.disconnect();
      JSONObject response = responseBody.isEmpty() ? new JSONObject() : new JSONObject(responseBody);
      if (status == 401) csrfToken = "";
      throw new ApiException(status, response.optString("error", "请求失败，请稍后重试。"));
    }
    byte[] data = readBytes(connection.getInputStream(), Models.MAX_ATTACHMENT_BYTES + 16);
    connection.disconnect();
    return data;
  }

  void deleteAttachment(String noteId, String attachmentId, int revision) throws Exception {
    request(
      "DELETE",
      "api/admin/encrypted-notes/" + noteId + "/attachments/" + attachmentId,
      null,
      revision
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
    connection.setRequestProperty("X-Attachment-Support", "1");
    String cookie = sessionStore.load();
    if (!cookie.isEmpty()) connection.setRequestProperty("Cookie", cookie);
    if (!"GET".equals(method) && !"HEAD".equals(method) && !csrfToken.isEmpty()) {
      connection.setRequestProperty("X-CSRF-Token", csrfToken);
    }
    if ("api/auth/logout".equals(path)) {
      String token = sessionStore.loadDeviceToken();
      if (!token.isEmpty()) connection.setRequestProperty("Authorization", "Bearer " + token);
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

  private HttpURLConnection open(String method, String path) throws Exception {
    HttpURLConnection connection = (HttpURLConnection) new URL(baseUrl + path).openConnection();
    connection.setRequestMethod(method);
    connection.setConnectTimeout(15_000);
    connection.setReadTimeout(60_000);
    connection.setUseCaches(false);
    String cookie = sessionStore.load();
    if (!cookie.isEmpty()) connection.setRequestProperty("Cookie", cookie);
    return connection;
  }

  private JSONObject readJsonResponse(HttpURLConnection connection) throws Exception {
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

  private static byte[] readBytes(InputStream stream, int maximum) throws Exception {
    if (stream == null) return new byte[0];
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    byte[] buffer = new byte[16 * 1024];
    int count;
    try (InputStream input = stream) {
      while ((count = input.read(buffer)) != -1) {
        if (output.size() + count > maximum) {
          throw new IllegalArgumentException("加密图片超过 10 MiB 限制。");
        }
        output.write(buffer, 0, count);
      }
    }
    return output.toByteArray();
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

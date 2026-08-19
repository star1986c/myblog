import Foundation

public struct NoteMutationState: Codable, Equatable, Sendable {
  public let id: String
  public let folderId: String?
  public let revision: Int
  public let updatedAt: String?
  public let deletedAt: String?
  public let isLocked: Bool?
}

public enum NotesAPIError: LocalizedError, Equatable {
  case invalidResponse
  case server(status: Int, message: String)
  case decoding

  public var errorDescription: String? {
    switch self {
    case .invalidResponse:
      "服务器响应无效。"
    case .server(_, let message):
      message
    case .decoding:
      "无法读取服务器返回的数据。"
    }
  }

  public var status: Int? {
    if case .server(let status, _) = self { status } else { nil }
  }
}

public actor NotesAPIClient {
  public static let productionBaseURL = URL(string: "https://superstar1014.qzz.io/")!

  private let baseURL: URL
  private let session: URLSession
  private var csrfToken = ""

  public init(baseURL: URL = productionBaseURL, session: URLSession? = nil) {
    self.baseURL = baseURL
    if let session {
      self.session = session
    } else {
      let configuration = URLSessionConfiguration.default
      configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
      configuration.urlCache = nil
      configuration.httpShouldSetCookies = true
      configuration.httpCookieStorage = .shared
      self.session = URLSession(configuration: configuration)
    }
  }

  public func restoreSession() async throws -> AdminUser? {
    let response: SessionResponse = try await request(path: "api/auth/me")
    csrfToken = response.csrfToken ?? ""
    return response.authenticated ? response.user : nil
  }

  public func login(username: String, password: String) async throws -> AdminUser {
    let body = try JSONEncoder().encode(LoginRequest(username: username, password: password))
    let response: LoginResponse = try await request(
      method: "POST",
      path: "api/auth/login",
      body: body
    )
    csrfToken = response.csrfToken
    return response.user
  }

  public func logout() async {
    let _: OKResponse? = try? await request(method: "POST", path: "api/auth/logout")
    csrfToken = ""
  }

  public func changePassword(
    username: String,
    currentPassword: String,
    newPassword: String
  ) async throws -> AdminUser {
    let response: AccountResponse = try await request(
      method: "PUT",
      path: "api/admin/account",
      body: try JSONEncoder().encode(
        AccountUpdateRequest(
          username: username,
          currentPassword: currentPassword,
          newPassword: newPassword
        )
      )
    )
    csrfToken = response.csrfToken
    return response.account
  }

  public func workspaceKey() async throws -> String {
    let response: WorkspaceKeyResponse = try await request(path: "api/admin/workspace-key")
    return response.workspaceKey.key
  }

  public func protectionKeyring() async throws -> NoteProtectionKeyring? {
    let response: ProtectionKeyringResponse = try await request(
      path: "api/admin/note-protection-keyring"
    )
    return response.keyring
  }

  public func createProtectionKeyring(_ payload: NoteProtectionKeyringPayload) async throws
    -> NoteProtectionKeyring
  {
    let response: ProtectionKeyringResponse = try await request(
      method: "POST",
      path: "api/admin/note-protection-keyring",
      body: try JSONEncoder().encode(payload)
    )
    guard let keyring = response.keyring else { throw NotesAPIError.decoding }
    return keyring
  }

  public func listNotes(inTrash: Bool) async throws -> [EncryptedNoteEnvelope] {
    let path =
      inTrash
      ? "api/admin/encrypted-notes-trash"
      : "api/admin/encrypted-notes"
    let response: NotesResponse = try await request(path: path)
    return response.notes
  }

  public func listFolders() async throws -> [EncryptedFolderEnvelope] {
    let response: FoldersResponse = try await request(path: "api/admin/encrypted-note-folders")
    return response.folders
  }

  public func createFolder(_ payload: EncryptedFolderPayload) async throws
    -> EncryptedFolderEnvelope
  {
    let response: FolderResponse = try await request(
      method: "POST",
      path: "api/admin/encrypted-note-folders",
      body: try JSONEncoder().encode(payload)
    )
    return response.folder
  }

  public func updateFolder(_ payload: EncryptedFolderPayload, revision: Int) async throws
    -> EncryptedFolderEnvelope
  {
    let response: FolderResponse = try await request(
      method: "PUT",
      path: "api/admin/encrypted-note-folders/\(payload.id)",
      body: try JSONEncoder().encode(payload),
      revision: revision
    )
    return response.folder
  }

  public func deleteFolder(id: String, revision: Int) async throws {
    let _: OKResponse = try await request(
      method: "DELETE",
      path: "api/admin/encrypted-note-folders/\(id)",
      revision: revision
    )
  }

  public func reorderFolders(ids: [String]) async throws -> [EncryptedFolderEnvelope] {
    let response: FoldersResponse = try await request(
      method: "PUT",
      path: "api/admin/encrypted-note-folders/order",
      body: try JSONEncoder().encode(FolderOrder(folderIds: ids))
    )
    return response.folders
  }

  public func create(_ payload: EncryptedNotePayload) async throws -> EncryptedNoteEnvelope {
    let body = try JSONEncoder().encode(payload)
    let response: NoteResponse = try await request(
      method: "POST",
      path: "api/admin/encrypted-notes",
      body: body
    )
    return response.note
  }

  public func update(
    _ payload: EncryptedNotePayload,
    revision: Int
  ) async throws -> EncryptedNoteEnvelope {
    let body = try JSONEncoder().encode(payload)
    let response: NoteResponse = try await request(
      method: "PUT",
      path: "api/admin/encrypted-notes/\(payload.id)",
      body: body,
      revision: revision
    )
    return response.note
  }

  public func moveToTrash(id: String, revision: Int) async throws -> NoteMutationState {
    let response: MutationResponse = try await request(
      method: "DELETE",
      path: "api/admin/encrypted-notes/\(id)",
      revision: revision
    )
    return response.note
  }

  public func moveNote(id: String, folderId: String?, revision: Int) async throws
    -> NoteMutationState
  {
    let response: MutationResponse = try await request(
      method: "PUT",
      path: "api/admin/encrypted-notes/\(id)/folder",
      body: try JSONEncoder().encode(FolderAssignment(folderId: folderId)),
      revision: revision
    )
    return response.note
  }

  public func restore(id: String, revision: Int) async throws -> NoteMutationState {
    let response: MutationResponse = try await request(
      method: "POST",
      path: "api/admin/encrypted-notes/\(id)/restore",
      revision: revision
    )
    return response.note
  }

  public func purge(id: String, revision: Int) async throws {
    let _: OKResponse = try await request(
      method: "DELETE",
      path: "api/admin/encrypted-notes/\(id)/purge",
      revision: revision
    )
  }

  public func listAttachments(noteID: String) async throws -> [EncryptedAttachmentEnvelope] {
    let response: AttachmentsResponse = try await request(
      path: "api/admin/encrypted-notes/\(noteID)/attachments"
    )
    return response.attachments
  }

  public func uploadAttachment(
    _ payload: EncryptedAttachmentPayload,
    encryptedBody: Data
  ) async throws -> EncryptedAttachmentEnvelope {
    guard let url = URL(
      string: "api/admin/encrypted-notes/\(payload.noteId)/attachments/\(payload.id)",
      relativeTo: baseURL
    )?.absoluteURL else { throw NotesAPIError.invalidResponse }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.httpBody = encryptedBody
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.timeoutInterval = 60
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
    request.setValue(String(encryptedBody.count), forHTTPHeaderField: "Content-Length")
    request.setValue(String(payload.version), forHTTPHeaderField: "X-Attachment-Version")
    request.setValue(payload.ciphertext, forHTTPHeaderField: "X-Attachment-Ciphertext")
    request.setValue(payload.nonce, forHTTPHeaderField: "X-Attachment-Nonce")
    request.setValue(payload.isLocked ? "true" : "false", forHTTPHeaderField: "X-Attachment-Locked")
    request.setValue("1", forHTTPHeaderField: "X-Attachment-Support")
    if !csrfToken.isEmpty {
      request.setValue(csrfToken, forHTTPHeaderField: "X-CSRF-Token")
    }
    let (data, response) = try await session.data(for: request)
    let http = try validate(response: response, data: data, path: request.url?.path ?? "")
    guard (200..<300).contains(http.statusCode) else { throw NotesAPIError.invalidResponse }
    guard let value = try? JSONDecoder().decode(AttachmentResponse.self, from: data) else {
      throw NotesAPIError.decoding
    }
    return value.attachment
  }

  public func downloadAttachment(noteID: String, id: String) async throws -> Data {
    guard let url = URL(
      string: "api/admin/encrypted-notes/\(noteID)/attachments/\(id)/content",
      relativeTo: baseURL
    )?.absoluteURL else { throw NotesAPIError.invalidResponse }
    var request = URLRequest(url: url)
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.timeoutInterval = 60
    request.setValue("application/octet-stream", forHTTPHeaderField: "Accept")
    request.setValue("1", forHTTPHeaderField: "X-Attachment-Support")
    let (data, response) = try await session.data(for: request)
    _ = try validate(response: response, data: data, path: request.url?.path ?? "")
    return data
  }

  public func deleteAttachment(noteID: String, id: String, revision: Int) async throws {
    let _: OKResponse = try await request(
      method: "DELETE",
      path: "api/admin/encrypted-notes/\(noteID)/attachments/\(id)",
      revision: revision
    )
  }

  public func attachmentUsage() async throws -> AttachmentUsage {
    let response: AttachmentUsageResponse = try await request(
      path: "api/admin/encrypted-note-attachments/usage"
    )
    return response.usage
  }

  public func hermesChatProfiles() async throws -> [HermesChatProfile] {
    let response: HermesChatProfilesResponse = try await request(
      path: "api/admin/hermes-chat/profiles"
    )
    return response.profiles
  }

  public func hermesChatMultiplexTicket(
    spaceIDs: [String]
  ) async throws -> HermesChatMultiplexTicket {
    try await request(
      method: "POST",
      path: "api/admin/hermes-chat/multiplex-ticket",
      body: try JSONEncoder().encode(HermesChatMultiplexTicketRequest(spaceIds: spaceIDs))
    )
  }

  public func uploadHermesChatAttachment(
    spaceID: String,
    attachmentID: String,
    ciphertext: Data
  ) async throws {
    guard let url = URL(
      string: "api/hermes-chat/attachments/\(attachmentID)",
      relativeTo: baseURL
    )?.absoluteURL else { throw NotesAPIError.invalidResponse }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.httpBody = ciphertext
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.timeoutInterval = 60
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
    request.setValue(String(ciphertext.count), forHTTPHeaderField: "Content-Length")
    request.setValue(spaceID, forHTTPHeaderField: "X-Hermes-Space")
    request.setValue("1", forHTTPHeaderField: "X-Attachment-Support")
    if !csrfToken.isEmpty {
      request.setValue(csrfToken, forHTTPHeaderField: "X-CSRF-Token")
    }
    let (data, response) = try await session.data(for: request)
    _ = try validate(response: response, data: data, path: request.url?.path ?? "")
  }

  public func downloadHermesChatAttachment(
    spaceID: String,
    attachmentID: String
  ) async throws -> Data {
    guard let url = URL(
      string: "api/hermes-chat/attachments/\(attachmentID)",
      relativeTo: baseURL
    )?.absoluteURL else { throw NotesAPIError.invalidResponse }
    var request = URLRequest(url: url)
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.timeoutInterval = 60
    request.setValue("application/octet-stream", forHTTPHeaderField: "Accept")
    request.setValue(spaceID, forHTTPHeaderField: "X-Hermes-Space")
    request.setValue("1", forHTTPHeaderField: "X-Attachment-Support")
    let (data, response) = try await session.data(for: request)
    _ = try validate(response: response, data: data, path: request.url?.path ?? "")
    return data
  }

  public func deleteHermesChatMessages(
    spaceID: String,
    messageIDs: [String],
    attachmentIDs: [String]
  ) async throws -> HermesChatDeleteResult {
    try await request(
      method: "POST",
      path: "api/admin/hermes-chat/messages/delete",
      body: try JSONEncoder().encode(
        HermesChatDeleteRequest(
          spaceId: spaceID,
          messageIds: messageIDs,
          attachmentIds: attachmentIDs
        )
      )
    )
  }

  public func purgeHermesChat(spaceID: String) async throws -> HermesChatCleanupResult {
    try await request(
      method: "POST",
      path: "api/admin/hermes-chat/cleanup",
      body: try JSONEncoder().encode(HermesChatCleanupRequest(spaceId: spaceID))
    )
  }

  private func request<Response: Decodable>(
    method: String = "GET",
    path: String,
    body: Data? = nil,
    revision: Int? = nil
  ) async throws -> Response {
    guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
      throw NotesAPIError.invalidResponse
    }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.httpBody = body
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.timeoutInterval = 25
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue("1", forHTTPHeaderField: "X-Attachment-Support")
    if body != nil {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    if !["GET", "HEAD"].contains(method), !csrfToken.isEmpty {
      request.setValue(csrfToken, forHTTPHeaderField: "X-CSRF-Token")
    }
    if let revision {
      request.setValue("\"\(revision)\"", forHTTPHeaderField: "If-Match")
    }

    let (data, urlResponse) = try await session.data(for: request)
    _ = try validate(response: urlResponse, data: data, path: path)
    do {
      return try JSONDecoder().decode(Response.self, from: data)
    } catch {
      throw NotesAPIError.decoding
    }
  }

  private func validate(response: URLResponse, data: Data, path: String) throws -> HTTPURLResponse {
    guard let response = response as? HTTPURLResponse else {
      throw NotesAPIError.invalidResponse
    }
    guard (200..<300).contains(response.statusCode) else {
      if response.statusCode == 401 && path != "api/auth/login" { csrfToken = "" }
      let message =
        (try? JSONDecoder().decode(ErrorResponse.self, from: data).error)
        ?? "请求失败，请稍后重试。"
      throw NotesAPIError.server(status: response.statusCode, message: message)
    }
    return response
  }
}

private struct SessionResponse: Codable {
  let authenticated: Bool
  let user: AdminUser?
  let csrfToken: String?
}

private struct LoginRequest: Codable {
  let username: String
  let password: String
}

private struct LoginResponse: Codable {
  let user: AdminUser
  let csrfToken: String
}

private struct AccountUpdateRequest: Codable {
  let username: String
  let currentPassword: String
  let newPassword: String
}

private struct AccountResponse: Codable {
  let account: AdminUser
  let csrfToken: String
}

private struct WorkspaceKeyResponse: Codable {
  struct WorkspaceKey: Codable { let key: String }
  let workspaceKey: WorkspaceKey
}
private struct ProtectionKeyringResponse: Codable { let keyring: NoteProtectionKeyring? }

private struct NotesResponse: Codable { let notes: [EncryptedNoteEnvelope] }
private struct NoteResponse: Codable { let note: EncryptedNoteEnvelope }
private struct FoldersResponse: Codable { let folders: [EncryptedFolderEnvelope] }
private struct FolderResponse: Codable { let folder: EncryptedFolderEnvelope }
private struct FolderAssignment: Codable { let folderId: String? }
private struct FolderOrder: Codable { let folderIds: [String] }
private struct MutationResponse: Codable { let note: NoteMutationState }
private struct AttachmentsResponse: Codable { let attachments: [EncryptedAttachmentEnvelope] }
private struct AttachmentResponse: Codable { let attachment: EncryptedAttachmentEnvelope }
private struct AttachmentUsageResponse: Codable { let usage: AttachmentUsage }
private struct HermesChatProfilesResponse: Codable { let profiles: [HermesChatProfile] }
private struct HermesChatMultiplexTicketRequest: Codable { let spaceIds: [String] }
private struct HermesChatDeleteRequest: Codable {
  let spaceId: String
  let messageIds: [String]
  let attachmentIds: [String]
}
private struct HermesChatCleanupRequest: Codable { let spaceId: String }
private struct OKResponse: Codable { let ok: Bool }
private struct ErrorResponse: Codable { let error: String }

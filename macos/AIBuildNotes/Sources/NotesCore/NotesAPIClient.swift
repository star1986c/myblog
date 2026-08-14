import Foundation

public struct NoteMutationState: Codable, Equatable, Sendable {
  public let id: String
  public let revision: Int
  public let updatedAt: String?
  public let deletedAt: String?
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

  public func workspaceKey() async throws -> String {
    let response: WorkspaceKeyResponse = try await request(path: "api/admin/workspace-key")
    return response.workspaceKey.key
  }

  public func listNotes(inTrash: Bool) async throws -> [EncryptedNoteEnvelope] {
    let path =
      inTrash
      ? "api/admin/encrypted-notes-trash"
      : "api/admin/encrypted-notes"
    let response: NotesResponse = try await request(path: path)
    return response.notes
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
    guard let response = urlResponse as? HTTPURLResponse else {
      throw NotesAPIError.invalidResponse
    }
    guard (200..<300).contains(response.statusCode) else {
      if response.statusCode == 401 { csrfToken = "" }
      let message =
        (try? JSONDecoder().decode(ErrorResponse.self, from: data).error)
        ?? "请求失败，请稍后重试。"
      throw NotesAPIError.server(status: response.statusCode, message: message)
    }
    do {
      return try JSONDecoder().decode(Response.self, from: data)
    } catch {
      throw NotesAPIError.decoding
    }
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

private struct WorkspaceKeyResponse: Codable {
  struct WorkspaceKey: Codable { let key: String }
  let workspaceKey: WorkspaceKey
}

private struct NotesResponse: Codable { let notes: [EncryptedNoteEnvelope] }
private struct NoteResponse: Codable { let note: EncryptedNoteEnvelope }
private struct MutationResponse: Codable { let note: NoteMutationState }
private struct OKResponse: Codable { let ok: Bool }
private struct ErrorResponse: Codable { let error: String }

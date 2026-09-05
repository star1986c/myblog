import Foundation
import Testing
@testable import NotesCore

final class MemoryDeviceTokens: NotesDeviceTokenStoring, @unchecked Sendable {
  private let lock = NSLock()
  private var token: String?
  init(_ token: String? = nil) { self.token = token }
  func load() -> String? { lock.withLock { token } }
  func save(_ token: String?) throws { lock.withLock { self.token = token } }
}

@Suite("Remembered Mac session", .serialized)
struct NotesSessionTests {
  private func makeAPI(_ tokens: MemoryDeviceTokens) -> NotesAPIClient {
    SessionProtocol.refreshes = 0
    SessionProtocol.status = 200
    SessionProtocol.authenticated = false
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [SessionProtocol.self]
    return NotesAPIClient(baseURL: URL(string: "https://session.test/")!,
      session: URLSession(configuration: configuration), deviceTokens: tokens)
  }

  @Test func restoresAfterRestart() async throws {
    let tokens = MemoryDeviceTokens("saved")
    let api = makeAPI(tokens)
    #expect(try await api.restoreSession()?.username == "admin")
    #expect(tokens.load() == "rotated")
    #expect(SessionProtocol.refreshes == 1)
  }

  @Test func concurrentExpiredRequestsRefreshOnce() async throws {
    let api = makeAPI(MemoryDeviceTokens("saved"))
    try await withThrowingTaskGroup(of: Void.self) { group in
      for _ in 0..<8 {
        group.addTask { _ = try await api.hermesChatMultiplexTicket(spaceIDs: ["main"]) }
      }
      try await group.waitForAll()
    }
    #expect(SessionProtocol.refreshes == 1)
  }

  @Test func invalidTokenClearedButTransientFailureRetained() async throws {
    for status in [401, 503] {
      let tokens = MemoryDeviceTokens("saved")
      let api = makeAPI(tokens)
      SessionProtocol.status = status
      do { _ = try await api.restoreSession(); Issue.record("Expected failure") } catch {}
      #expect(tokens.load() == (status == 401 ? nil : "saved"))
      #expect(SessionProtocol.refreshes == 1)
    }
  }

  @Test func recoversStaleCSRFWithoutRotatingDeviceToken() async throws {
    let api = makeAPI(MemoryDeviceTokens("saved"))
    SessionProtocol.authenticated = true
    _ = try await api.hermesChatMultiplexTicket(spaceIDs: ["main"])
    #expect(SessionProtocol.refreshes == 0)
  }

  @Test func loginRemembersAndLogoutForgets() async throws {
    let tokens = MemoryDeviceTokens()
    let api = makeAPI(tokens)
    _ = try await api.login(username: "admin", password: "test-password")
    #expect(tokens.load() == "rotated")
    await api.logout()
    #expect(tokens.load() == nil)
    #expect(try await api.restoreSession() == nil)
    #expect(SessionProtocol.refreshes == 0)
  }
}

private final class SessionProtocol: URLProtocol, @unchecked Sendable {
  nonisolated(unsafe) static var refreshes = 0
  nonisolated(unsafe) static var status = 200
  nonisolated(unsafe) static var authenticated = false
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func stopLoading() {}
  override func startLoading() {
    let path = request.url!.path
    var code = 200
    var body: [String: Any] = [:]
    switch path {
    case "/api/auth/me":
      body = ["authenticated": Self.authenticated]
      if Self.authenticated {
        body["user"] = ["username": "admin", "mustChangePassword": false]
        body["csrfToken"] = "fresh"
      }
    case "/api/auth/token", "/api/auth/login":
      if path.hasSuffix("token") {
        Self.refreshes += 1
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer saved")
        code = Self.status
      }
      if code == 200 { Self.authenticated = true }
      body = ["user": ["username": "admin", "mustChangePassword": false],
        "csrfToken": "fresh", "deviceToken": "rotated", "error": "failure"]
    case "/api/auth/logout":
      #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer rotated")
      Self.authenticated = false
      body = ["ok": true]
    default:
      if !Self.authenticated { code = 401; body = ["error": "expired"] }
      else if request.value(forHTTPHeaderField: "X-CSRF-Token") != "fresh" {
        code = 403; body = ["error": "Invalid CSRF token."]
      } else {
        body = ["ticket": "ticket", "spaceIds": ["main"], "expiresInSeconds": 90]
      }
    }
    client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: code,
      httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!,
      cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: body))
    client?.urlProtocolDidFinishLoading(self)
  }
}

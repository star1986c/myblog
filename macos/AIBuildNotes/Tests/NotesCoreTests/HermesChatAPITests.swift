import Foundation
import Testing

@testable import NotesCore

@Suite("Hermes macOS API", .serialized)
struct HermesChatAPITests {
  @Test("Multiplex, attachment, and delete requests keep session and CSRF protection")
  func sendsAuthenticatedHermesRequests() async throws {
    HermesChatURLProtocol.requests = []
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [HermesChatURLProtocol.self]
    let api = NotesAPIClient(
      baseURL: URL(string: "https://notes.test/")!,
      session: URLSession(configuration: configuration)
    )

    _ = try await api.login(username: "owner", password: "local-password")
    let profiles = try await api.hermesChatProfiles()
    let ticket = try await api.hermesChatMultiplexTicket(spaceIDs: profiles.map(\.id))
    try await api.uploadHermesChatAttachment(
      spaceID: "primary",
      attachmentID: "550e8400-e29b-41d4-a716-446655440000",
      ciphertext: Data(repeating: 7, count: 32)
    )
    _ = try await api.deleteHermesChatMessages(
      spaceID: "primary",
      messageIDs: ["550e8400-e29b-41d4-a716-446655440001"],
      attachmentIDs: ["550e8400-e29b-41d4-a716-446655440000"]
    )

    #expect(profiles.map(\.id) == ["primary", "personal"])
    #expect(ticket.spaceIds == ["primary", "personal"])
    let upload = try #require(
      HermesChatURLProtocol.requests.first { $0.url?.path.contains("/attachments/") == true }
    )
    #expect(upload.value(forHTTPHeaderField: "X-Hermes-Space") == "primary")
    #expect(upload.value(forHTTPHeaderField: "X-CSRF-Token") == "hermes-csrf-token")
    let deletion = try #require(
      HermesChatURLProtocol.requests.first { $0.url?.path.hasSuffix("/messages/delete") == true }
    )
    #expect(deletion.value(forHTTPHeaderField: "X-CSRF-Token") == "hermes-csrf-token")
  }
}

private final class HermesChatURLProtocol: URLProtocol, @unchecked Sendable {
  nonisolated(unsafe) static var requests: [URLRequest] = []

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    guard let url = request.url else {
      client?.urlProtocol(self, didFailWithError: URLError(.badURL))
      return
    }
    Self.requests.append(request)
    do {
      let object: Any
      switch (request.httpMethod ?? "GET", url.path) {
      case ("POST", "/api/auth/login"):
        object = [
          "user": ["username": "owner", "mustChangePassword": false],
          "csrfToken": "hermes-csrf-token",
        ]
      case ("GET", "/api/admin/hermes-chat/profiles"):
        object = [
          "profiles": [
            ["id": "primary", "label": "Hermes 主助手"],
            ["id": "personal", "label": "Hermes 个人助手"],
          ]
        ]
      case ("POST", "/api/admin/hermes-chat/multiplex-ticket"):
        #expect(request.value(forHTTPHeaderField: "X-CSRF-Token") == "hermes-csrf-token")
        object = [
          "ticket": "short-lived-ticket",
          "spaceIds": ["primary", "personal"],
          "expiresInSeconds": 90,
        ]
      case ("POST", let path) where path.contains("/api/hermes-chat/attachments/"):
        #expect(request.value(forHTTPHeaderField: "X-CSRF-Token") == "hermes-csrf-token")
        object = ["ok": true]
      case ("POST", "/api/admin/hermes-chat/messages/delete"):
        #expect(request.value(forHTTPHeaderField: "X-CSRF-Token") == "hermes-csrf-token")
        object = [
          "ok": true,
          "spaceId": "primary",
          "messagesDeleted": 1,
          "attachmentsDeleted": 1,
        ]
      default:
        throw URLError(.unsupportedURL)
      }
      let data = try JSONSerialization.data(withJSONObject: object)
      let response = HTTPURLResponse(
        url: url,
        statusCode: 200,
        httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"]
      )!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: data)
      client?.urlProtocolDidFinishLoading(self)
    } catch {
      client?.urlProtocol(self, didFailWithError: error)
    }
  }

  override func stopLoading() {}
}

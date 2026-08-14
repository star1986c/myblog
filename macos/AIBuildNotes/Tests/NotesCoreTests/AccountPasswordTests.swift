import Foundation
import Testing

@testable import NotesCore

@Suite("Account password change", .serialized)
struct AccountPasswordTests {
  @Test("Password change sends current credentials with CSRF protection")
  func changesPassword() async throws {
    AccountPasswordURLProtocol.receivedBody = [:]
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [AccountPasswordURLProtocol.self]
    let api = NotesAPIClient(
      baseURL: URL(string: "https://notes.test/")!,
      session: URLSession(configuration: configuration)
    )

    _ = try await api.login(username: "admin", password: "old-password-value")
    let account = try await api.changePassword(
      username: "admin",
      currentPassword: "old-password-value",
      newPassword: "new-password-value"
    )

    #expect(account == AdminUser(username: "admin", mustChangePassword: false))
    #expect(AccountPasswordURLProtocol.receivedBody["username"] as? String == "admin")
    #expect(
      AccountPasswordURLProtocol.receivedBody["currentPassword"] as? String
        == "old-password-value")
    #expect(
      AccountPasswordURLProtocol.receivedBody["newPassword"] as? String
        == "new-password-value")
  }
}

private final class AccountPasswordURLProtocol: URLProtocol, @unchecked Sendable {
  nonisolated(unsafe) static var receivedBody: [String: Any] = [:]

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    guard let url = request.url else {
      client?.urlProtocol(self, didFailWithError: URLError(.badURL))
      return
    }
    do {
      let data: Data
      switch (request.httpMethod ?? "GET", url.path) {
      case ("POST", "/api/auth/login"):
        data = try json([
          "user": ["username": "admin", "mustChangePassword": false],
          "csrfToken": "account-csrf-token",
        ])
      case ("PUT", "/api/admin/account"):
        #expect(request.value(forHTTPHeaderField: "X-CSRF-Token") == "account-csrf-token")
        let body = try requestBody(request)
        Self.receivedBody = try #require(
          JSONSerialization.jsonObject(with: body) as? [String: Any]
        )
        data = try json([
          "account": ["username": "admin", "mustChangePassword": false],
          "csrfToken": "rotated-account-csrf-token",
        ])
      default:
        throw URLError(.unsupportedURL)
      }
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

  private func json(_ object: Any) throws -> Data {
    try JSONSerialization.data(withJSONObject: object)
  }

  private func requestBody(_ request: URLRequest) throws -> Data {
    if let body = request.httpBody { return body }
    guard let stream = request.httpBodyStream else { throw URLError(.cannotDecodeContentData) }
    stream.open()
    defer { stream.close() }
    var body = Data()
    var buffer = [UInt8](repeating: 0, count: 1024)
    while stream.hasBytesAvailable {
      let count = stream.read(&buffer, maxLength: buffer.count)
      if count < 0 { throw stream.streamError ?? URLError(.cannotDecodeContentData) }
      if count == 0 { break }
      body.append(contentsOf: buffer.prefix(count))
    }
    return body
  }
}

import Foundation
import Testing

@testable import NotesCore

@Suite("Folder ordering", .serialized)
struct FolderOrderingTests {
  @Test("Reorder request sends the complete folder ID list")
  func sendsCompleteOrder() async throws {
    FolderOrderURLProtocol.receivedFolderIDs = []
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [FolderOrderURLProtocol.self]
    let api = NotesAPIClient(
      baseURL: URL(string: "https://notes.test/")!,
      session: URLSession(configuration: configuration)
    )

    _ = try await api.login(username: "admin", password: "test-password")
    let ids = ["folder_charlie", "folder_alpha", "folder_bravo"]
    let folders = try await api.reorderFolders(ids: ids)

    #expect(FolderOrderURLProtocol.receivedFolderIDs == ids)
    #expect(folders.map(\.id) == ids)
    #expect(folders.map(\.sortOrder) == [0, 1, 2])
  }
}

private final class FolderOrderURLProtocol: URLProtocol, @unchecked Sendable {
  nonisolated(unsafe) static var receivedFolderIDs: [String] = []

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
        data = try JSONSerialization.data(withJSONObject: [
          "user": ["username": "admin", "mustChangePassword": false],
          "csrfToken": "folder-order-token",
        ])
      case ("PUT", "/api/admin/encrypted-note-folders/order"):
        #expect(request.value(forHTTPHeaderField: "X-CSRF-Token") == "folder-order-token")
        let body = try requestBody(request)
        let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
        let ids = try #require(json["folderIds"] as? [String])
        Self.receivedFolderIDs = ids
        let folders = ids.enumerated().map { index, id in
          EncryptedFolderEnvelope(
            id: id,
            version: 1,
            ciphertext: "ciphertext",
            nonce: "nonce",
            sortOrder: index
          )
        }
        data = try JSONEncoder().encode(FoldersFixture(folders: folders))
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

private struct FoldersFixture: Encodable {
  let folders: [EncryptedFolderEnvelope]
}

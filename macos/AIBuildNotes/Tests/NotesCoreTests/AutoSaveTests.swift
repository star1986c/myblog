import CryptoKit
import Foundation
import Testing

@testable import NotesCore

@Suite("Automatic note saving", .serialized)
struct AutoSaveTests {
  @Test("Debounced save reaches the API without cancelling itself")
  @MainActor
  func debouncedSaveCompletes() async throws {
    let keyText = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"
    let key = try NoteCrypto.importDataKey(keyText)
    let noteID = "note_autosave_1234"
    let originalPayload = try NoteCrypto.encrypt(
      NoteContent(title: "测试笔记", content: ""),
      id: noteID,
      using: key
    )
    AutoSaveURLProtocol.configure(
      keyText: keyText,
      note: EncryptedNoteEnvelope(
        id: noteID,
        version: originalPayload.version,
        ciphertext: originalPayload.ciphertext,
        nonce: originalPayload.nonce
      )
    )

    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [AutoSaveURLProtocol.self]
    let api = NotesAPIClient(
      baseURL: URL(string: "https://notes.test/")!,
      session: URLSession(configuration: configuration)
    )
    let store = NotesStore(api: api)

    await store.login(username: "admin", password: "test-password")
    #expect(store.selectedID == noteID)

    store.updateSelectedContent("11111")
    try await Task.sleep(for: .milliseconds(1_100))

    #expect(AutoSaveURLProtocol.updateRequestCount == 1)
    #expect(store.saveState == .saved)
    #expect(store.selectedDocument?.content.content == "11111")
    #expect(store.selectedDocument?.envelope.revision == 2)
  }
}

private final class AutoSaveURLProtocol: URLProtocol, @unchecked Sendable {
  nonisolated(unsafe) private static var keyText = ""
  nonisolated(unsafe) private static var note: EncryptedNoteEnvelope?
  nonisolated(unsafe) private(set) static var updateRequestCount = 0

  static func configure(keyText: String, note: EncryptedNoteEnvelope) {
    self.keyText = keyText
    self.note = note
    updateRequestCount = 0
  }

  override class func canInit(with request: URLRequest) -> Bool { true }

  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    guard let url = request.url else {
      client?.urlProtocol(self, didFailWithError: URLError(.badURL))
      return
    }

    do {
      let responseBody: Data
      switch (request.httpMethod ?? "GET", url.path) {
      case ("POST", "/api/auth/login"):
        responseBody = try json([
          "user": ["username": "admin", "mustChangePassword": false],
          "csrfToken": "test-csrf-token",
        ])
      case ("GET", "/api/admin/workspace-key"):
        responseBody = try json(["workspaceKey": ["key": Self.keyText]])
      case ("GET", "/api/admin/encrypted-notes"):
        responseBody = try JSONEncoder().encode(NotesFixture(notes: [Self.note].compactMap { $0 }))
      case ("GET", "/api/admin/encrypted-notes-trash"):
        responseBody = try json(["notes": []])
      case ("GET", "/api/admin/encrypted-note-folders"):
        responseBody = try json(["folders": []])
      case ("PUT", let path) where path == "/api/admin/encrypted-notes/\(Self.note?.id ?? "")":
        Self.updateRequestCount += 1
        guard var updated = Self.note else { throw URLError(.cannotDecodeContentData) }
        updated.revision = 2
        updated.updatedAt = "2026-08-14T03:00:00.000Z"
        responseBody = try JSONEncoder().encode(NoteFixture(note: updated))
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
      client?.urlProtocol(self, didLoad: responseBody)
      client?.urlProtocolDidFinishLoading(self)
    } catch {
      client?.urlProtocol(self, didFailWithError: error)
    }
  }

  override func stopLoading() {}

  private func json(_ object: Any) throws -> Data {
    try JSONSerialization.data(withJSONObject: object)
  }
}

private struct NotesFixture: Encodable {
  let notes: [EncryptedNoteEnvelope]
}

private struct NoteFixture: Encodable {
  let note: EncryptedNoteEnvelope
}

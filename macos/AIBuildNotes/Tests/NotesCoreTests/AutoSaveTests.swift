import CryptoKit
import Foundation
import Testing

@testable import NotesCore

@Suite("Automatic note saving", .serialized)
struct AutoSaveTests {
  @Test("A failed background save keeps unlocked protected edits for retry")
  @MainActor
  func failedRelockPreservesEdits() async throws {
    let password = "protected-test-password"
    let keyText = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"
    let key = try NoteCrypto.importDataKey(keyText)
    let protection = try NoteProtectionCrypto.createKeyring(password: password)
    let noteID = "protected-background-note"
    let protected = try NoteProtectionCrypto.encryptBody("original", noteID: noteID, using: protection.key)
    let payload = try NoteCrypto.encrypt(NoteContent(title: "Protected", content: "", protectedContent: protected), id: noteID, using: key)
    AutoSaveURLProtocol.configure(keyText: keyText, note: EncryptedNoteEnvelope(id: noteID, version: 1, ciphertext: payload.ciphertext, nonce: payload.nonce, isLocked: true))
    AutoSaveURLProtocol.protectionKeyring = NoteProtectionKeyring(iterations: protection.payload.iterations, salt: protection.payload.salt, wrappedKey: protection.payload.wrappedKey, nonce: protection.payload.nonce)
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [AutoSaveURLProtocol.self]
    let store = NotesStore(api: NotesAPIClient(baseURL: URL(string: "https://notes.test/")!, session: URLSession(configuration: config)), autoSaveDelay: .seconds(3600))
    await store.login(username: "admin", password: "test-password")
    try store.unlockSelected(password: password)
    store.updateSelectedContent("unsaved private edit")
    AutoSaveURLProtocol.rejectUpdates = true
    await store.relock()
    #expect(store.selectedDocument?.content.content == "unsaved private edit")
    #expect(store.unlockedProtectedNoteID == noteID)
    #expect(store.saveState == .failed)
    AutoSaveURLProtocol.rejectUpdates = false
    await store.relock()
    #expect(store.unlockedProtectedNoteID == nil)
    #expect(store.selectedDocument?.content.content == "")
    try store.unlockSelected(password: password)
    #expect(store.selectedDocument?.content.content == "unsaved private edit")
  }

  @Test("Manual and background saves coalesce instead of racing the same revision")
  @MainActor
  func simultaneousSavesUseOneRequest() async throws {
    let keyText = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"
    let key = try NoteCrypto.importDataKey(keyText)
    let payload = try NoteCrypto.encrypt(NoteContent(title: "Concurrent", content: "initial"), id: "save-race", using: key)
    AutoSaveURLProtocol.configure(keyText: keyText, note: EncryptedNoteEnvelope(id: "save-race", version: 1, ciphertext: payload.ciphertext, nonce: payload.nonce))
    AutoSaveURLProtocol.updateDelay = 0.08
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [AutoSaveURLProtocol.self]
    let store = NotesStore(api: NotesAPIClient(baseURL: URL(string: "https://notes.test/")!, session: URLSession(configuration: config)), autoSaveDelay: .seconds(3600))
    await store.login(username: "admin", password: "test-password")
    store.updateSelectedContent("edited")
    async let manual = store.saveSelected()
    async let background = store.saveSelected()
    let results = await (manual, background)
    #expect(results.0 && results.1)
    #expect(AutoSaveURLProtocol.updateRequestCount == 1)
    #expect(store.saveState == .saved)
    #expect(store.selectedDocument?.envelope.revision == 2)

    // A failed attachment upload is observable by the UI, which keeps its local recording.
    #expect(!(await store.addImage(data: Data([1, 2]), contentType: "audio/mp4", pixelWidth: 1, pixelHeight: 1, durationMillis: 1000)))
    #expect(store.errorMessage != nil)
  }

  @Test("Manual save is immediate while automatic save waits for a quiet period")
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
    let store = NotesStore(api: api, autoSaveDelay: .milliseconds(350))

    await store.login(username: "admin", password: "test-password")
    #expect(store.selectedID == noteID)

    store.updateSelectedContent("11111")
    #expect(store.saveState == .dirty)
    try await Task.sleep(for: .milliseconds(120))
    #expect(AutoSaveURLProtocol.updateRequestCount == 0)

    #expect(await store.saveSelected())

    #expect(AutoSaveURLProtocol.updateRequestCount == 1)
    #expect(store.saveState == .saved)
    #expect(store.selectedDocument?.content.content == "11111")
    #expect(store.selectedDocument?.envelope.revision == 2)

    store.updateSelectedContent("中文输入完成后再自动保存")
    #expect(store.saveState == .dirty)
    try await Task.sleep(for: .milliseconds(550))
    #expect(AutoSaveURLProtocol.updateRequestCount == 2)
    #expect(store.saveState == .saved)
    #expect(store.selectedDocument?.envelope.revision == 3)
  }
}

private final class AutoSaveURLProtocol: URLProtocol, @unchecked Sendable {
  nonisolated(unsafe) static var protectionKeyring: NoteProtectionKeyring?
  nonisolated(unsafe) static var rejectUpdates = false
  nonisolated(unsafe) static var updateDelay: TimeInterval = 0
  nonisolated(unsafe) private static var keyText = ""
  nonisolated(unsafe) private static var note: EncryptedNoteEnvelope?
  nonisolated(unsafe) private(set) static var updateRequestCount = 0
  nonisolated(unsafe) private(set) static var loginRequestCount = 0

  static func configure(keyText: String, note: EncryptedNoteEnvelope) {
    protectionKeyring = nil
    rejectUpdates = false
    updateDelay = 0
    self.keyText = keyText
    self.note = note
    updateRequestCount = 0
    loginRequestCount = 0
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
      var statusCode = 200
      switch (request.httpMethod ?? "GET", url.path) {
      case ("POST", "/api/auth/login"):
        Self.loginRequestCount += 1
        responseBody = try json([
          "user": ["username": "admin", "mustChangePassword": false],
          "csrfToken": "test-csrf-token",
        ])
      case ("GET", "/api/admin/workspace-key"):
        responseBody = try json(["workspaceKey": ["key": Self.keyText]])
      case ("GET", "/api/admin/notes-sync"):
        statusCode = 404
        responseBody = try json(["error": "Not found"])
      case ("GET", "/api/admin/encrypted-notes"):
        responseBody = try JSONEncoder().encode(NotesFixture(notes: [Self.note].compactMap { $0 }))
      case ("GET", "/api/admin/encrypted-notes-trash"):
        responseBody = try json(["notes": []])
      case ("GET", "/api/admin/encrypted-note-folders"):
        responseBody = try json(["folders": []])
      case ("GET", "/api/admin/note-protection-keyring"):
        if let keyring = Self.protectionKeyring { responseBody = try JSONEncoder().encode(ProtectionFixture(keyring: keyring)) }
        else { responseBody = try json(["keyring": NSNull()]) }
      case ("PUT", let path) where path == "/api/admin/encrypted-notes/\(Self.note?.id ?? "")":
        if Self.rejectUpdates { throw URLError(.notConnectedToInternet) }
        Self.updateRequestCount += 1
        if request.value(forHTTPHeaderField: "X-CSRF-Token") != "test-csrf-token" {
          statusCode = 403
          responseBody = try json(["error": "Invalid CSRF token."])
        } else {
          guard var updated = Self.note else { throw URLError(.cannotDecodeContentData) }
          updated.revision = Self.updateRequestCount + 1
          updated.updatedAt = "2026-08-14T03:00:00.000Z"
          responseBody = try JSONEncoder().encode(NoteFixture(note: updated))
        }
      default:
        throw URLError(.unsupportedURL)
      }

      let response = HTTPURLResponse(
        url: url,
        statusCode: statusCode,
        httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"]
      )!
      let deliver: @Sendable () -> Void = { [self] in
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: responseBody)
        client?.urlProtocolDidFinishLoading(self)
      }
      if request.httpMethod == "PUT", Self.updateDelay > 0 {
        DispatchQueue.global().asyncAfter(deadline: .now() + Self.updateDelay, execute: deliver)
      } else { deliver() }
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

private struct ProtectionFixture: Encodable { let keyring: NoteProtectionKeyring }

import CryptoKit
import Foundation
import Testing
@testable import NotesCore

@Suite("Incremental notes sync", .serialized)
struct NotesSyncTests {
  private let rawKey = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"

  private func note(_ id: String, body: String = "private-body", deletedAt: String? = nil) throws -> [String: Any] {
    let key = try NoteCrypto.importDataKey(rawKey)
    let payload = try NoteCrypto.encrypt(NoteContent(title: id, content: body), id: id, using: key)
    var result = try JSONSerialization.jsonObject(with: JSONEncoder().encode(payload)) as! [String: Any]
    result["revision"] = 1
    if let deletedAt { result["deletedAt"] = deletedAt }
    return result
  }

  private func page(_ cursor: String, reset: Bool = false, more: Bool = false,
    changes: [[String: Any]] = []) throws -> Data {
    try JSONSerialization.data(withJSONObject: ["version": 1, "cursor": cursor,
      "reset": reset, "hasMore": more, "changes": changes])
  }

  private func change(_ envelope: [String: Any]) -> [String: Any] {
    ["kind": "note", "id": envelope["id"]!, "deleted": false, "note": envelope]
  }

  private func api() -> NotesAPIClient {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [NotesSyncURLProtocol.self]
    return NotesAPIClient(baseURL: URL(string: "https://incremental.test/")!,
      session: URLSession(configuration: config), deviceTokens: MemoryDeviceTokens())
  }

  @Test @MainActor func coldStartThenIdleRefreshUsesDurableCursor() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let cache = NotesSyncCache(directory: directory)
    let first = try page("epoch:1", reset: true, changes: [change(note("one"))])
    NotesSyncURLProtocol.configure([(200, first), (200, try page("epoch:1")), (200, try page("epoch:1"))])
    let store = NotesStore(api: api(), syncCache: cache)
    await store.login(username: "admin", password: "test-password")
    #expect(store.activeNotes.count == 1)
    await store.refresh()
    #expect(store.activeNotes.first?.content.content == "private-body")
    let restarted = NotesStore(api: api(), syncCache: cache)
    await restarted.login(username: "admin", password: "test-password")
    #expect(restarted.activeNotes.count == 1)
    #expect(NotesSyncURLProtocol.queries == [nil, "epoch:1", "epoch:1"])
    #expect(NotesSyncURLProtocol.legacyReads == 0)
    await restarted.logout()
    let key = try NoteCrypto.importDataKey(rawKey)
    #expect(cache.load(scope: await api().notesSyncScope(username: "admin"), key: key) == nil)
  }

  @Test func paginationDeletionAndEpochReset() async throws {
    NotesSyncURLProtocol.configure([
      (200, try page("e:1", reset: true, more: true, changes: [change(note("one")), change(note("old"))])),
      (200, try page("e:2", changes: [change(note("one", body: "new", deletedAt: "now")),
        ["kind": "note", "id": "old", "deleted": true]])),
      (200, try page("new:1", reset: true, changes: [change(note("replacement"))])),
    ])
    let client = api()
    let snapshot = try await client.syncNotes(from: nil)
    #expect(snapshot.notes.count == 1)
    #expect(snapshot.notes["one"]?.deletedAt == "now")
    #expect(snapshot.cursor == "e:2")
    let reset = try await client.syncNotes(from: snapshot)
    #expect(Set(reset.notes.keys) == ["replacement"])
  }

  @Test @MainActor func failedSavePreventsRefreshFromDiscardingEdits() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    NotesSyncURLProtocol.configure([(200, try page("e:1", reset: true, changes: [change(note("one"))]))])
    let store = NotesStore(api: api(), syncCache: NotesSyncCache(directory: directory))
    await store.login(username: "admin", password: "test-password")
    store.updateSelectedContent("unsaved edit")
    await store.refresh()
    #expect(store.selectedDocument?.content.content == "unsaved edit")
    #expect(NotesSyncURLProtocol.queries.count == 1)
    #expect(store.errorMessage != nil)
  }

  @Test @MainActor func interruptedPageAndInvalidCiphertextDoNotAdvanceCache() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let cache = NotesSyncCache(directory: directory)
    let client = api()
    let key = try NoteCrypto.importDataKey(rawKey)
    let scope = await client.notesSyncScope(username: "admin")
    var invalid = try note("one")
    invalid["ciphertext"] = "broken"
    NotesSyncURLProtocol.configure([
      (200, try page("e:1", reset: true, changes: [change(note("one"))])),
      (200, try page("e:2", more: true, changes: [change(note("one", body: "partial"))])),
      (503, Data("{\"error\":\"offline\"}".utf8)),
      (200, try page("e:3", changes: [change(invalid)])),
      (200, try page("e:4", changes: [change(note("one", body: "complete"))])),
    ])
    let store = NotesStore(api: client, syncCache: cache)
    await store.login(username: "admin", password: "test-password")
    await store.refresh()
    #expect(cache.load(scope: scope, key: key)?.cursor == "e:1")
    #expect(store.activeNotes.first?.content.content == "private-body")
    await store.refresh()
    #expect(cache.load(scope: scope, key: key)?.cursor == "e:1")
    #expect(store.activeNotes.first?.content.content == "private-body")
    await store.refresh()
    #expect(cache.load(scope: scope, key: key)?.cursor == "e:4")
    #expect(store.activeNotes.first?.content.content == "complete")
    #expect(NotesSyncURLProtocol.queries == [nil, "e:1", "e:2", "e:1", "e:1"])
  }

  @Test func cacheIsAuthenticatedAndIsolatedByAccountAndKey() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let cache = NotesSyncCache(directory: directory)
    let key = try NoteCrypto.importDataKey(rawKey)
    var snapshot = NotesSyncSnapshot()
    try snapshot.apply(JSONDecoder().decode(NotesSyncPage.self,
      from: page("e:1", reset: true, changes: [change(note("one"))])))
    try cache.save(snapshot, scope: "account-a", key: key)
    #expect(cache.load(scope: "account-a", key: key)?.cursor == "e:1")
    #expect(cache.load(scope: "account-b", key: key) == nil)
    #expect(cache.load(scope: "account-a", key: SymmetricKey(size: .bits256)) == nil)
    let file = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)[0]
    var bytes = try Data(contentsOf: file)
    #expect(!String(decoding: bytes, as: UTF8.self).contains("private-body"))
    bytes[bytes.count - 1] ^= 1
    try bytes.write(to: file)
    #expect(cache.load(scope: "account-a", key: key) == nil)
  }

  @Test func nonAdvancingPageIsRejected() async throws {
    NotesSyncURLProtocol.configure([(200, try page("e:1", more: true)), (200, try page("e:1", more: true))])
    await #expect(throws: NotesAPIError.self) { try await api().syncNotes(from: nil) }
  }
}

private final class NotesSyncURLProtocol: URLProtocol, @unchecked Sendable {
  private static let lock = NSLock()
  nonisolated(unsafe) private static var pages: [(Int, Data)] = []
  nonisolated(unsafe) private static var recordedQueries: [String?] = []
  nonisolated(unsafe) private static var recordedLegacyReads = 0
  static var queries: [String?] { lock.withLock { recordedQueries } }
  static var legacyReads: Int { lock.withLock { recordedLegacyReads } }
  static func configure(_ values: [(Int, Data)]) {
    lock.withLock { pages = values; recordedQueries = []; recordedLegacyReads = 0 }
  }
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func stopLoading() {}
  override func startLoading() {
    let url = request.url!
    var code = 200
    var body = Data("{}".utf8)
    switch url.path {
    case "/api/auth/login":
      body = Data("{\"user\":{\"username\":\"admin\",\"mustChangePassword\":false},\"csrfToken\":\"csrf\"}".utf8)
    case "/api/admin/workspace-key":
      body = Data("{\"workspaceKey\":{\"key\":\"AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE\"}}".utf8)
    case "/api/admin/note-protection-keyring": body = Data("{\"keyring\":null}".utf8)
    case "/api/auth/logout": body = Data("{\"ok\":true}".utf8)
    case "/api/admin/encrypted-notes/one":
      code = 409
      body = Data("{\"error\":\"Note changed on another device.\"}".utf8)
    case "/api/admin/notes-sync":
      (code, body) = Self.lock.withLock {
        Self.recordedQueries.append(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first?.value)
        return Self.pages.isEmpty ? (500, Data("{}".utf8)) : Self.pages.removeFirst()
      }
    default:
      Self.lock.withLock { Self.recordedLegacyReads += 1 }
      code = 404
    }
    client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: code,
      httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: body)
    client?.urlProtocolDidFinishLoading(self)
  }
}

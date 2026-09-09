import Foundation
import Testing

@testable import NotesCore

@Test("Opening replay covers exactly 24 hours for every profile and survives retry")
func openingReplayUsesOneDay() {
  let now: Int64 = 1_800_000_000_000
  let sync = HermesChatOpeningSync(now: Date(timeIntervalSince1970: Double(now) / 1_000))

  for spaceID in ["primary", "personal", "primary"] {
    #expect(sync.sinceMilliseconds(spaceID: spaceID) == now - 86_400_000)
  }
}

@Test("Completed profiles resume incrementally while unfinished profiles still replay")
func openingReplayCompletesEachProfileIndependently() {
  var sync = HermesChatOpeningSync()
  let pendingSince = sync.sinceMilliseconds(spaceID: "personal")
  sync.complete(spaceID: "primary")

  #expect(sync.sinceMilliseconds(spaceID: "primary") == nil)
  #expect(sync.sinceMilliseconds(spaceID: "personal") == pendingSince)
  sync.complete(spaceID: "personal")
  #expect(sync.sinceMilliseconds(spaceID: "personal") == nil)

  sync = HermesChatOpeningSync()
  #expect(sync.sinceMilliseconds(spaceID: "primary") != nil)
  #expect(sync.sinceMilliseconds(spaceID: "personal") != nil)
}

@Test("Opening replay merges missing messages without duplicating or deleting older history")
func openingReplayMergesLocalHistory() async throws {
  let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  defer { try? FileManager.default.removeItem(at: root) }
  let crypto = try HermesChatCrypto(encodedKey: Data(repeating: 5, count: 32).base64EncodedString())
  let history = try HermesChatHistoryStore(spaceID: "primary", crypto: crypto, directory: root)
  let now: Int64 = 1_800_000_000_000
  let old = HermesChatMessage(id: "old", sender: "agent", sentAt: now - 2 * 86_400_000,
    sequence: 1, text: "older history")
  let cached = HermesChatMessage(id: "cached", sender: "agent", sentAt: now - 1_000,
    sequence: 3, text: "cached")
  let missing = HermesChatMessage(id: "missing", sender: "agent", sentAt: now - 2_000,
    sequence: 2, text: "missing")
  _ = await history.recordBatch([old, cached])
  _ = await history.recordBatch([missing, cached])
  let snapshot = await history.loadAndCleanup(retentionDays: 0)

  #expect(snapshot.messages.map(\.id) == ["old", "missing", "cached"])
  #expect(snapshot.lastSequence == 3)
}

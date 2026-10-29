import Foundation
import Testing
@testable import NotesCore

@Suite("Hermes large history integrity")
struct HermesChatLoadTests {
  func message(_ n: Int) -> HermesChatMessage {
    HermesChatMessage(id: "m-\(n)", sender: "agent", sentAt: Int64(n),
      sequence: Int64(n), text: "message \(n)")
  }

  @Test("A persisted cursor bypasses the opening replay, including after restart")
  func incrementalOpening() {
    let sync = HermesChatOpeningSync()
    #expect(sync.sinceMilliseconds(spaceID: "primary", lastSequence: 12_345) == nil)
    #expect(sync.sinceMilliseconds(spaceID: "new", lastSequence: 0) != nil)
    #expect(HermesChatOpeningSync().sinceMilliseconds(spaceID: "primary", lastSequence: 12_345) == nil)
  }

  @Test("Live messages cannot advance the cursor past unfinished history pages")
  func interleavedReplay() {
    var cursor = HermesChatReplayCursor(sequence: 100)
    cursor.receive(sequence: 200, replayed: true)
    cursor.receive(sequence: 10_000, replayed: false)
    #expect(cursor.sequence == 200)
    cursor.receive(sequence: 300, replayed: true)
    cursor.receive(sequence: 199, replayed: true)
    #expect(cursor.sequence == 300)
  }

  @Test("Live events cannot checkpoint past unfinished replay; reconnect replays from the old cursor")
  func deferLiveCheckpoint() {
    var delivery = HermesChatReplayDelivery()
    let live = HermesChatClientEvent.message(spaceID: "primary", message: message(9_000), configurationGeneration: 0)
    let outcome1 = !delivery.enqueue(live, replayed: false)
    #expect(outcome1)
    let outcome2 = !delivery.enqueue(.acknowledged(spaceID: "primary", messageID: "sent", sequence: 9_001, configurationGeneration: 0), replayed: false)
    #expect(outcome2)
    let outcome3 = delivery.enqueue(.message(spaceID: "primary", message: message(101), configurationGeneration: 0), replayed: true)
    #expect(outcome3)
    var transient = message(102)
    transient.replaceSequence = 101
    let outcome4 = !delivery.enqueue(.message(spaceID: "primary", message: transient, configurationGeneration: 0), replayed: false)
    #expect(outcome4)
    let outcome5 = delivery.complete().count == 2
    #expect(outcome5)
    let outcome6 = delivery.enqueue(live, replayed: false)
    #expect(outcome6)
    let outcome7 = delivery.complete().isEmpty
    #expect(outcome7)
    var reconnect = HermesChatReplayDelivery()
    let outcome8 = !reconnect.enqueue(live, replayed: false)
    #expect(outcome8)
  }

  @Test("Slow consumers receive every event beyond the former 1000-event buffer")
  func slowConsumer() async {
    let (stream, continuation) = HermesChatClient.makeEventStream()
    for n in 1...5_000 {
      continuation.yield(.message(spaceID: "primary", message: message(n), configurationGeneration: 0))
    }
    continuation.yield(.resumed(spaceID: "primary", latestSequence: 5_000, configurationGeneration: 0))
    continuation.finish()
    var sequences: [Int64] = []
    for await event in stream {
      switch event {
      case .message(_, let message, _): sequences.append(message.sequence)
      case .resumed(_, let sequence, _):
        #expect(sequences.count == 5_000)
        #expect(sequence == sequences.last)
      default: Issue.record("Unexpected event")
      }
    }
    #expect(sequences == (1...5_000).map(Int64.init))
  }

  @Test("Indexed merge matches sequential rules for duplicates, edits, pending messages and legacy copies")
  func mergeParity() {
    var initial = (1...200).map(message)
    initial.append(initial[10])
    var events: [HermesChatMessage] = []
    for n in (1...300).reversed() {
      var edit = message(n + 500)
      edit.replaceSequence = Int64(n)
      edit.finalUpdate = n % 3 != 0
      events += [edit, message(n), edit, message(n)]
    }
    var pending = message(0)
    events.append(pending)
    pending.sequence = 1001
    events.append(pending)
    var expected = initial
    let flags = events.map { HermesChatMessageMerge.apply($0, to: &expected) }
    var actual = initial
    let actualFlags = HermesChatMessageMerge.applyBatch(events, to: &actual)
    #expect(actualFlags == flags)
    #expect(actual == expected)
  }

  @Test("History pages drain fully before continuing, with independent profile identities")
  @MainActor
  func pageDrain() async {
    let store = HermesChatStore.preview()
    await store.start()
    for page in 0..<20 {
      for n in (page * 100 + 1)...(page * 100 + 100) {
        for profile in ["primary", "personal"] {
          await store.handle(.message(spaceID: profile, message: message(n), configurationGeneration: 0))
        }
      }
      // No real transport is connected; the page event still drains the store.
      await store.handle(.replayPage(spaceID: "primary", transportGeneration: -1, configurationGeneration: 0))
      for profile in ["primary", "personal"] {
        #expect(store.messages(spaceID: profile).filter { $0.id.hasPrefix("m-") }.count == (page + 1) * 100)
      }
    }
    await store.suspendTransport()
    await store.resumeTransport()
    for n in 1...2_000 {
      await store.handle(.message(spaceID: "primary", message: message(n), configurationGeneration: 1))
    }
    await store.handle(.resumed(spaceID: "primary", latestSequence: 2_000, configurationGeneration: 1))
    #expect(store.messages(spaceID: "primary").filter { $0.id.hasPrefix("m-") }.count == 2_000)
    await store.stop()
  }

  @Test("20000 messages persist, reopen and replay with final edits intact")
  func largeHistory() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let crypto = try HermesChatCrypto(encodedKey: Data(repeating: 7, count: 32).base64EncodedString())
    let history = try HermesChatHistoryStore(spaceID: "primary", crypto: crypto, directory: root)
    let originals = (1...20_000).map(message)
    let start = ContinuousClock.now
    _ = await history.recordBatch(originals)
    var final = message(20_001)
    final.replaceSequence = 19_999
    final.finalUpdate = true
    final.text = "final reply"
    _ = await history.recordBatch([final] + Array(originals.suffix(100)))
    let reopened = try HermesChatHistoryStore(spaceID: "primary", crypto: crypto, directory: root)
    let snapshot = await reopened.loadAndCleanup(retentionDays: 0)
    #expect(snapshot.messages.count == 20_000)
    #expect(snapshot.messages.map(\.id) == originals.map(\.id))
    #expect(snapshot.messages.first { $0.sequence == 19_999 }?.text == "final reply")
    #expect(snapshot.lastSequence == 20_001)
    #expect(HermesChatOpeningSync().sinceMilliseconds(spaceID: "primary", lastSequence: snapshot.lastSequence) == nil)
    print("Hermes 20000-message encrypted write/replay/reopen: \(start.duration(to: .now))")
  }
}

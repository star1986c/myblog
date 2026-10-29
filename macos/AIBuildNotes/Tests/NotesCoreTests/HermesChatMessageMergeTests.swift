import CryptoKit
import Foundation
import Testing
@testable import NotesCore

@Suite("Hermes replay bubble identity")
struct HermesChatMessageMergeTests {
  private func message(_ id: String, _ sequence: Int64, _ text: String,
    target: Int64 = 0, final: Bool = false) -> HermesChatMessage {
    HermesChatMessage(id: id, sender: "agent", sentAt: 1000, sequence: sequence,
      text: text, replaceSequence: target, finalUpdate: final)
  }

  @Test("Final-first, repeated originals and stale finals keep the latest reply and original identity")
  func outOfOrderReplay() {
    let original = message("base", 21, "partial")
    let final = message("final", 22, "complete", target: 21, final: true)
    let newer = message("newer", 24, "corrected", target: 21, final: true)
    for events in [[final, original, final, newer, final, original],
      [original, newer, final, original], [newer, final, original, newer]] {
      var messages: [HermesChatMessage] = []
      for event in events { HermesChatMessageMerge.apply(event, to: &messages) }
      #expect(messages.count == 1)
      #expect(messages.first?.id == "base")
      #expect(messages.first?.sequence == 21)
      #expect(messages.first?.lastEditSequence == 24)
      #expect(messages.first?.text == "corrected")
    }
  }

  @Test("An empty edit attachment list preserves images; nil interaction clears the prompt")
  func attachmentsAndInteraction() {
    var original = message("base", 21, "partial")
    let image = HermesChatAttachmentDescriptor(id: "image", name: "photo.png",
      contentType: "image/png", plaintextBytes: 100)
    original.attachments = [image]
    original.interaction = HermesChatInteraction(id: "prompt", kind: "approval", state: "pending",
      expiresAt: 0, options: [])
    let final = message("final", 22, "complete", target: 21, final: true)
    for events in [[original, final, original], [final, original]] {
      var messages: [HermesChatMessage] = []
      for event in events { HermesChatMessageMerge.apply(event, to: &messages) }
      #expect(messages.first?.attachments == [image])
      #expect(messages.first?.interaction == nil)
      #expect(messages.first?.text == "complete")
    }
  }

  @Test("Transient edits update an existing bubble but never create an orphan")
  func transientEdits() {
    var messages: [HermesChatMessage] = []
    let transient = message("partial-edit", 21, "streaming", target: 21)
    HermesChatMessageMerge.apply(transient, to: &messages)
    #expect(messages.isEmpty)
    HermesChatMessageMerge.apply(message("base", 21, "initial"), to: &messages)
    HermesChatMessageMerge.apply(transient, to: &messages)
    #expect(messages.count == 1)
    #expect(messages.first?.text == "streaming")
    #expect(messages.first?.lastEditSequence == nil)
  }

  @Test("Independent messages with identical text and pending zero sequences remain separate")
  func independentReplies() {
    var messages: [HermesChatMessage] = []
    for item in [message("a", 21, "OK"), message("b", 22, "OK"),
      message("pending-a", 0, "OK"), message("pending-b", 0, "OK")] {
      HermesChatMessageMerge.apply(item, to: &messages)
      HermesChatMessageMerge.apply(item, to: &messages)
    }
    #expect(messages.count == 4)
    #expect(HermesChatMessageMerge.normalize(messages).count == 4)
  }

  @Test("Replaying an edit repairs legacy orphan copies alongside the original")
  func legacyOrphans() {
    let final = message("final", 22, "complete", target: 21, final: true)
    let legacy = message("final", 22, "complete")
    var messages = [message("base", 21, "partial"), legacy, legacy]
    HermesChatMessageMerge.apply(final, to: &messages)
    #expect(messages.count == 1)
    #expect(messages.first?.id == "base")
    #expect(messages.first?.sequence == 21)
    #expect(messages.first?.text == "complete")
  }

  @Test("Old encrypted snapshots decode without revision metadata and persist duplicate repair")
  func legacySnapshot() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let crypto = try HermesChatCrypto(encodedKey: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")
    let legacy = message("final", 22, "complete")
    let plaintext = try JSONEncoder().encode(HermesChatSnapshotPayload(v: 1, lastSequence: 22,
      messages: [legacy, legacy, legacy]))
    #expect(!String(decoding: plaintext, as: UTF8.self).contains("lastEditSequence"))
    let envelope = try crypto.encryptLocalSnapshot(plaintext, spaceID: "primary")
    let name = SHA256.hash(data: Data("primary".utf8)).map { String(format: "%02x", $0) }.joined()
    try JSONEncoder().encode(envelope).write(to: root.appendingPathComponent(name + ".json"))
    let store = try HermesChatHistoryStore(spaceID: "primary", crypto: crypto, directory: root)
    let repaired = await store.loadAndCleanup(retentionDays: 0)
    #expect(repaired.messages.count == 1)
    #expect(repaired.lastSequence == 22)
    let replayed = await store.record(message("final", 22, "complete", target: 21, final: true))
    #expect(replayed.messages.first?.sequence == 21)
    let reopened = try HermesChatHistoryStore(spaceID: "primary", crypto: crypto, directory: root)
    let restored = await reopened.record(message("base", 21, "partial"))
    #expect(restored.messages.count == 1)
    #expect(restored.messages.first?.id == "base")
    #expect(restored.messages.first?.text == "complete")
    #expect(restored.lastSequence == 22)
  }

  @Test("Visible bubbles survive replay after backgrounding without duplicate unread counts")
  @MainActor
  func foregroundReplay() async {
    let store = HermesChatStore.preview()
    await store.start()
    let unreadBefore = store.unreadCount(spaceID: "primary")
    let final = message("final-replay", 102, "complete", target: 101, final: true)
    for _ in 0..<2 {
      await store.handle(.message(spaceID: "primary", message: final, configurationGeneration: 0))
    }
    await store.suspendTransport()
    await store.resumeTransport()
    for item in [final, message("base-replay", 101, "partial"), final] {
      await store.handle(.message(spaceID: "primary", message: item, configurationGeneration: 1))
    }
    await store.handle(.resumed(spaceID: "primary", latestSequence: 102, configurationGeneration: 1))
    let bubbles = store.messages(spaceID: "primary").filter { $0.sequence == 101 || $0.sequence == 102 }
    #expect(bubbles.count == 1)
    #expect(bubbles.first?.text == "complete")
    #expect(bubbles.first?.id == "base-replay")
    #expect(store.unreadCount(spaceID: "primary") == unreadBefore)
    #expect(!store.messages(spaceID: "personal").contains { $0.id == "base-replay" })
    await store.stop()
  }
}

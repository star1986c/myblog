import CryptoKit
import Foundation
import Testing

@testable import NotesCore

@Test("Hermes macOS history keeps sequence checkpoints while cleaning old messages")
func hermesHistoryRetentionKeepsCheckpoint() async throws {
  let root = FileManager.default.temporaryDirectory
    .appendingPathComponent(UUID().uuidString, isDirectory: true)
  defer { try? FileManager.default.removeItem(at: root) }
  let crypto = try HermesChatCrypto(
    encodedKey: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
  )
  let store = try HermesChatHistoryStore(
    spaceID: "primary",
    crypto: crypto,
    directory: root
  )
  let now: Int64 = 1_800_000_000_000
  _ = await store.record(HermesChatMessage(
    id: "old-message",
    sender: "agent",
    sentAt: now - 40 * 86_400_000,
    sequence: 7,
    text: "old"
  ))
  _ = await store.record(HermesChatMessage(
    id: "new-message",
    sender: "client",
    sentAt: now,
    sequence: 8,
    text: "new"
  ))

  let cleaned = await store.loadAndCleanup(retentionDays: 30, nowMilliseconds: now)
  #expect(cleaned.messages.map(\.id) == ["new-message"])
  #expect(cleaned.lastSequence == 8)

  let restored = try HermesChatHistoryStore(
    spaceID: "primary",
    crypto: crypto,
    directory: root
  )
  let reloaded = await restored.loadAndCleanup(retentionDays: 0)
  #expect(reloaded == cleaned)
}

@Test("Hermes final stream edits replace one cached message without duplicating it")
func hermesHistoryAppliesFinalEdit() async throws {
  let root = FileManager.default.temporaryDirectory
    .appendingPathComponent(UUID().uuidString, isDirectory: true)
  defer { try? FileManager.default.removeItem(at: root) }
  let crypto = try HermesChatCrypto(
    encodedKey: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
  )
  let store = try HermesChatHistoryStore(
    spaceID: "personal",
    crypto: crypto,
    directory: root
  )
  _ = await store.record(HermesChatMessage(
    id: "550e8400-e29b-41d4-a716-446655440010",
    sender: "agent",
    sentAt: 1_800_000_000_000,
    sequence: 21,
    text: "partial"
  ))

  let intermediate = await store.record(HermesChatMessage(
    id: "550e8400-e29b-41d4-a716-446655440011",
    sender: "agent",
    sentAt: 1_800_000_000_010,
    sequence: 0,
    text: "still streaming",
    replaceSequence: 21,
    finalUpdate: false
  ))
  #expect(intermediate.messages.first?.text == "partial")

  let final = await store.record(HermesChatMessage(
    id: "550e8400-e29b-41d4-a716-446655440012",
    sender: "agent",
    sentAt: 1_800_000_000_020,
    sequence: 22,
    text: "complete",
    replaceSequence: 21,
    finalUpdate: true
  ))
  #expect(final.messages.count == 1)
  #expect(final.messages.first?.id == "550e8400-e29b-41d4-a716-446655440010")
  #expect(final.messages.first?.text == "complete")
  #expect(final.lastSequence == 22)
}

@Test("Hermes attachment cache stores only encrypted R2 bytes")
func hermesAttachmentCiphertextCache() async throws {
  let root = FileManager.default.temporaryDirectory
    .appendingPathComponent(UUID().uuidString, isDirectory: true)
  defer { try? FileManager.default.removeItem(at: root) }
  let crypto = try HermesChatCrypto(
    encodedKey: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
  )
  let encrypted = try crypto.encryptAttachment(
    Data("audio fixture".utf8),
    contentType: "audio/mpeg",
    filename: "voice.mp3"
  )
  let cache = HermesChatAttachmentCache(directory: root)

  await cache.store(encrypted.ciphertext, for: encrypted.descriptor, spaceID: "primary")
  #expect(
    await cache.data(for: encrypted.descriptor, spaceID: "primary")
      == encrypted.ciphertext
  )
  #expect(await cache.data(for: encrypted.descriptor, spaceID: "personal") == nil)
}

@Test("Hermes attachment cache removes expired ciphertext without touching another profile")
func hermesAttachmentCacheRetentionIsProfileScoped() async throws {
  let root = FileManager.default.temporaryDirectory
    .appendingPathComponent(UUID().uuidString, isDirectory: true)
  defer { try? FileManager.default.removeItem(at: root) }
  let crypto = try HermesChatCrypto(
    encodedKey: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
  )
  let encrypted = try crypto.encryptAttachment(
    Data("encrypted cache retention".utf8),
    contentType: "text/plain",
    filename: "report.txt"
  )
  let cache = HermesChatAttachmentCache(directory: root)
  await cache.store(encrypted.ciphertext, for: encrypted.descriptor, spaceID: "primary")
  await cache.store(encrypted.ciphertext, for: encrypted.descriptor, spaceID: "personal")

  let enumerator = FileManager.default.enumerator(
    at: root,
    includingPropertiesForKeys: [.isRegularFileKey]
  )
  let files = (enumerator?.allObjects as? [URL] ?? []).filter {
    (try? $0.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true
  }
  for file in files {
    try FileManager.default.setAttributes(
      [.modificationDate: Date(timeIntervalSince1970: 1_000)],
      ofItemAtPath: file.path
    )
  }

  await cache.cleanup(spaceID: "primary", retentionDays: 30, now: Date())
  #expect(await cache.data(for: encrypted.descriptor, spaceID: "primary") == nil)
  #expect(await cache.data(for: encrypted.descriptor, spaceID: "personal") != nil)
}

@Test("Hermes private R2 cache verifies size and SHA-256 before reuse")
func hermesPrivateAttachmentCacheVerifiesIntegrity() async throws {
  let root = FileManager.default.temporaryDirectory
    .appendingPathComponent(UUID().uuidString, isDirectory: true)
  defer { try? FileManager.default.removeItem(at: root) }
  try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  let payload = Data(
    repeating: 0x5a,
    count: HermesChatCrypto.maximumAttachmentBytes + 1
  )
  let digest = SHA256.hash(data: payload)
    .map { String(format: "%02x", $0) }
    .joined()
  let descriptor = HermesChatAttachmentDescriptor(
    id: "550e8400-e29b-41d4-a716-446655440099",
    name: "generated.mp4",
    contentType: "video/mp4",
    plaintextBytes: payload.count,
    storage: HermesChatCrypto.privateAttachmentStorage,
    sha256: digest
  )
  let staging = root.appendingPathComponent("download.tmp")
  try payload.write(to: staging, options: [.atomic])
  let cache = HermesChatAttachmentCache(directory: root)

  let stored = try await cache.storePrivateDownloadedFile(
    staging,
    for: descriptor,
    spaceID: "primary"
  )
  #expect(await cache.privateFile(for: descriptor, spaceID: "primary") == stored)

  let handle = try FileHandle(forWritingTo: stored)
  try handle.write(contentsOf: Data([0]))
  try handle.close()
  #expect(await cache.privateFile(for: descriptor, spaceID: "primary") == nil)
}

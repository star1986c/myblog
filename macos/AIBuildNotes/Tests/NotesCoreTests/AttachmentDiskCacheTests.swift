import Foundation
import Testing

@testable import NotesCore

@Test("Encrypted attachment cache persists bytes and invalidates changed envelopes")
func attachmentDiskCacheRoundTripAndInvalidation() async throws {
  let root = FileManager.default.temporaryDirectory
    .appendingPathComponent(UUID().uuidString, isDirectory: true)
  defer { try? FileManager.default.removeItem(at: root) }
  let cache = AttachmentDiskCache(directory: root)
  let body = Data(repeating: 0xA5, count: 48)
  let envelope = cachedEnvelope(ciphertextBytes: body.count)

  await cache.store(body, for: envelope)
  #expect(await cache.data(for: envelope) == body)

  var changed = envelope
  changed.revision += 1
  changed.updatedAt = "2026-08-14T12:00:00.000Z"
  #expect(await cache.data(for: changed) == nil)
}

@Test("Encrypted attachment cache rejects truncated files and removes note entries")
func attachmentDiskCacheRejectsCorruptionAndCleansNote() async throws {
  let root = FileManager.default.temporaryDirectory
    .appendingPathComponent(UUID().uuidString, isDirectory: true)
  defer { try? FileManager.default.removeItem(at: root) }
  let cache = AttachmentDiskCache(directory: root)
  let envelope = cachedEnvelope(ciphertextBytes: 48)

  await cache.store(Data(repeating: 1, count: 47), for: envelope)
  #expect(await cache.data(for: envelope) == nil)

  await cache.store(Data(repeating: 2, count: 48), for: envelope)
  await cache.removeAll(noteID: envelope.noteId)
  #expect(await cache.data(for: envelope) == nil)
}

private func cachedEnvelope(ciphertextBytes: Int) -> EncryptedAttachmentEnvelope {
  EncryptedAttachmentEnvelope(
    id: "attachment_cache_1234",
    noteId: "note_cache_1234",
    version: 1,
    revision: 1,
    ciphertext: "encrypted-metadata",
    nonce: "metadata-nonce",
    isLocked: true,
    ciphertextBytes: ciphertextBytes,
    createdAt: "2026-08-14T11:00:00.000Z",
    updatedAt: "2026-08-14T11:00:00.000Z"
  )
}

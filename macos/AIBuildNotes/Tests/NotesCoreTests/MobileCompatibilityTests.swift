import Foundation
import Testing
@testable import NotesCore

@Suite("iOS compatibility")
struct MobileCompatibilityTests {
  @Test("Recorded AAC metadata round-trips through the Android-compatible envelope")
  func recordedAudio() throws {
    let key = AttachmentCrypto.createMediaKey()
    let body = Data([0, 1, 2, 3, 4])
    let encrypted = try AttachmentCrypto.encrypt(body, contentType: "audio/mp4", pixelWidth: 1,
      pixelHeight: 1, noteID: "audio-note", attachmentID: "audio-file", isLocked: true,
      mediaKeyValue: key, durationMillis: 1250)
    let envelope = EncryptedAttachmentEnvelope(id: "audio-file", noteId: "audio-note", version: 1,
      ciphertext: encrypted.payload.ciphertext, nonce: encrypted.payload.nonce, isLocked: true,
      ciphertextBytes: encrypted.body.count)
    let metadata = try AttachmentCrypto.decryptMetadata(envelope, mediaKeyValue: key)
    #expect(metadata.contentType == "audio/mp4")
    #expect(metadata.durationMillis == 1250)
    #expect(try AttachmentCrypto.decryptBody(encrypted.body, envelope: envelope, metadata: metadata) == body)
    #expect(encrypted.body != body)
  }

  @Test("Reject missing, zero and over-limit recording duration before upload")
  func invalidAudio() {
    for duration: Int? in [nil, 0, -1, 300_001] {
      #expect(throws: AttachmentCryptoError.self) {
        try AttachmentCrypto.encrypt(Data([1]), contentType: "audio/mp4", pixelWidth: 1,
          pixelHeight: 1, noteID: "note", attachmentID: "file", isLocked: false,
          mediaKeyValue: AttachmentCrypto.createMediaKey(), durationMillis: duration)
      }
    }
  }

  @Test("Suspending flushes queued events, rejects stale transport events, and keeps local messages")
  @MainActor
  func suspensionPreservesQueuedHistory() async {
    let store = HermesChatStore.preview()
    await store.start()
    let incoming = HermesChatMessage(id: "queued-before-background", sender: "agent", sentAt: Int64(Date().timeIntervalSince1970 * 1000), sequence: 15, text: "pending batch")
    await store.handle(.message(spaceID: "primary", message: incoming, configurationGeneration: 0))
    await store.suspendTransport()
    #expect(store.isTransportSuspended)
    #expect(store.messages(spaceID: "primary").contains { $0.id == incoming.id })
    #expect(store.connectionState == .idle)
    await store.handle(.ready(configurationGeneration: 0))
    #expect(store.connectionState == .idle)
    await store.resumeTransport()
    #expect(!store.isTransportSuspended)
    await store.handle(.ready(configurationGeneration: 0))
    #expect(store.connectionState == .idle)
    await store.handle(.ready(configurationGeneration: 1))
    #expect(store.connectionState == .connected)
    #expect(store.messages(spaceID: "primary").contains { $0.id == incoming.id })
    await store.stop()
  }
}

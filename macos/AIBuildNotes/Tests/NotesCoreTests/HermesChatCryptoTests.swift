import Foundation
import Testing

@testable import NotesCore

private let hermesFixtureKey = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"

@Test("macOS Hermes messages use the Android and NAS AES-GCM envelope")
func hermesChatMessageRoundTrip() throws {
  let crypto = try HermesChatCrypto(encodedKey: hermesFixtureKey)
  let id = "550e8400-e29b-41d4-a716-446655440000"
  let envelope = try crypto.encryptMessageEnvelope(
    sender: "client",
    text: "跨端同步消息",
    attachments: [],
    messageID: id,
    sentAt: 1_800_000_000_000
  )
  let encoded = try JSONEncoder().encode(envelope)

  #expect(!String(decoding: encoded, as: UTF8.self).contains("跨端同步消息"))
  let message = try crypto.decryptMessageEnvelope(envelope, sequence: 17)
  #expect(message.id == id)
  #expect(message.sender == "client")
  #expect(message.text == "跨端同步消息")
  #expect(message.sequence == 17)
}

@Test("macOS sends the durable message envelope directly like Android")
func hermesChatOutgoingMessageFrame() throws {
  let crypto = try HermesChatCrypto(encodedKey: hermesFixtureKey)
  let id = "550e8400-e29b-41d4-a716-446655440001"
  let envelope = try crypto.encryptMessageEnvelope(
    sender: "client",
    text: "same wire frame",
    attachments: [],
    messageID: id,
    sentAt: 1_800_000_000_001
  )
  let frame = try HermesChatClient.outgoingMessageFrame(envelope)

  #expect(frame["v"] as? Int == 1)
  #expect(frame["type"] as? String == "message")
  #expect(frame["id"] as? String == id)
  #expect(frame["sender"] as? String == "client")
  #expect(frame["encrypted"] is [String: Any])
  #expect(frame["message"] == nil)
}

@Test("Hermes attachments keep descriptors authenticated and bytes encrypted")
func hermesChatAttachmentRoundTrip() throws {
  let crypto = try HermesChatCrypto(encodedKey: hermesFixtureKey)
  let plaintext = Data("PDF fixture".utf8)
  let encrypted = try crypto.encryptAttachment(
    plaintext,
    contentType: "application/pdf",
    filename: "日报.pdf"
  )

  #expect(encrypted.ciphertext != plaintext)
  #expect(encrypted.descriptor.name == "日报.pdf")
  #expect(encrypted.descriptor.contentType == "application/pdf")
  #expect(
    try crypto.decryptAttachment(
      encrypted.ciphertext,
      descriptor: encrypted.descriptor
    ) == plaintext
  )

  let moved = HermesChatAttachmentDescriptor(
    id: encrypted.descriptor.id,
    name: encrypted.descriptor.name,
    contentType: "text/plain",
    plaintextBytes: encrypted.descriptor.plaintextBytes,
    nonce: encrypted.descriptor.nonce
  )
  #expect(throws: HermesChatCryptoError.decryptionFailed) {
    try crypto.decryptAttachment(encrypted.ciphertext, descriptor: moved)
  }
}

@Test("macOS accepts private R2 descriptors only from the Hermes Agent")
func hermesChatPrivateR2DescriptorValidation() throws {
  let crypto = try HermesChatCrypto(encodedKey: hermesFixtureKey)
  let descriptor = HermesChatAttachmentDescriptor(
    id: "550e8400-e29b-41d4-a716-446655440099",
    name: "generated.mp4",
    contentType: "video/mp4",
    plaintextBytes: HermesChatCrypto.maximumAttachmentBytes + 1,
    storage: HermesChatCrypto.privateAttachmentStorage,
    sha256: String(repeating: "ab", count: 32)
  )
  let envelope = try crypto.encryptMessageEnvelope(
    sender: "agent",
    text: "大文件输出",
    attachments: [descriptor],
    messageID: "550e8400-e29b-41d4-a716-446655440098",
    sentAt: 1_800_000_000_002
  )
  let message = try crypto.decryptMessageEnvelope(envelope, sequence: 18)
  #expect(message.attachments == [descriptor])
  #expect(message.attachments[0].isPrivateR2)

  #expect(throws: HermesChatCryptoError.invalidAttachment) {
    try crypto.encryptMessageEnvelope(
      sender: "client",
      text: "伪造直传",
      attachments: [descriptor],
      messageID: "550e8400-e29b-41d4-a716-446655440097",
      sentAt: 1_800_000_000_003
    )
  }
}

@Test("Hermes local history encryption is isolated by profile id")
func hermesChatLocalSnapshotBinding() throws {
  let crypto = try HermesChatCrypto(encodedKey: hermesFixtureKey)
  let envelope = try crypto.encryptLocalSnapshot(
    Data("local message cache".utf8),
    spaceID: "primary"
  )

  #expect(
    try crypto.decryptLocalSnapshot(envelope, spaceID: "primary")
      == Data("local message cache".utf8)
  )
  #expect(throws: HermesChatCryptoError.decryptionFailed) {
    try crypto.decryptLocalSnapshot(envelope, spaceID: "personal")
  }
}

@Test("Hermes rejects malformed or wrong-length chat keys")
func hermesChatKeyValidation() {
  #expect(throws: HermesChatCryptoError.invalidKey) {
    try HermesChatCrypto(encodedKey: "not-a-key")
  }
}

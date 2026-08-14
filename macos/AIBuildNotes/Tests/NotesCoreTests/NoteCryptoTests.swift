import CryptoKit
import Foundation
import Testing

@testable import NotesCore

@Test("Swift decrypts the existing Web Crypto envelope format")
func decryptsWebCryptoEnvelope() throws {
  let key = try NoteCrypto.importDataKey(
    "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"
  )
  let envelope = EncryptedNoteEnvelope(
    id: "note_12345678",
    version: 1,
    ciphertext: "fPS9ID47pN_p7lR_9EBpHYCZ84yE3_kUs_PCwVqTERMbEDxK5X8v_KhCz2hBxXCtdeg0gQ",
    nonce: "AgICAgICAgICAgIC"
  )

  #expect(
    try NoteCrypto.decrypt(envelope, using: key) == NoteContent(title: "跨端", content: "hello"))
}

@Test("AES-GCM round trip keeps plaintext out of the envelope")
func roundTrip() throws {
  let key = SymmetricKey(size: .bits256)
  let content = NoteContent(title: "账号记录", content: "private-value")
  let payload = try NoteCrypto.encrypt(content, id: "note_87654321", using: key)
  let serialized = try JSONEncoder().encode(payload)

  #expect(!String(decoding: serialized, as: UTF8.self).contains("private-value"))

  let envelope = EncryptedNoteEnvelope(
    id: payload.id,
    version: payload.version,
    ciphertext: payload.ciphertext,
    nonce: payload.nonce
  )
  #expect(try NoteCrypto.decrypt(envelope, using: key) == content)
}

@Test("Ciphertext is bound to the note id")
func bindsCiphertextToRecord() throws {
  let key = SymmetricKey(size: .bits256)
  let payload = try NoteCrypto.encrypt(
    NoteContent(title: "SSH", content: "secret"),
    id: "note_12345678",
    using: key
  )
  let movedEnvelope = EncryptedNoteEnvelope(
    id: "note_87654321",
    version: payload.version,
    ciphertext: payload.ciphertext,
    nonce: payload.nonce
  )

  #expect(throws: NoteCryptoError.decryptionFailed) {
    try NoteCrypto.decrypt(movedEnvelope, using: key)
  }
}

@Test("Independent protection password wraps one key and encrypts note bodies")
func protectionPasswordRoundTrip() throws {
  let password = "correct horse battery staple"
  let created = try NoteProtectionCrypto.createKeyring(password: password)
  let keyring = NoteProtectionKeyring(
    iterations: created.payload.iterations,
    salt: created.payload.salt,
    wrappedKey: created.payload.wrappedKey,
    nonce: created.payload.nonce
  )
  let recovered = try NoteProtectionCrypto.unlockKeyring(keyring, password: password)
  let body = try NoteProtectionCrypto.encryptBody(
    "server-password-123",
    noteID: "note_protected_1234",
    using: recovered
  )
  #expect(!body.ciphertext.contains("server-password-123"))
  #expect(
    try NoteProtectionCrypto.decryptBody(
      body,
      noteID: "note_protected_1234",
      using: recovered
    ) == "server-password-123"
  )
  #expect(throws: NoteUnlockError.incorrectPassword) {
    try NoteProtectionCrypto.unlockKeyring(keyring, password: "wrong-password-value")
  }
}

@Test("Attachment metadata and image bytes stay encrypted and bound to the note")
func attachmentRoundTripAndBinding() throws {
  let noteID = "note_attachment_1234"
  let attachmentID = "attachment_swift_1234"
  let image = Data([1, 3, 3, 7, 9, 11])
  let mediaKey = AttachmentCrypto.createMediaKey()
  let encrypted = try AttachmentCrypto.encrypt(
    image,
    contentType: "image/png",
    pixelWidth: 64,
    pixelHeight: 32,
    noteID: noteID,
    attachmentID: attachmentID,
    isLocked: true,
    mediaKeyValue: mediaKey
  )
  #expect(!encrypted.payload.ciphertext.contains("image/png"))

  let envelope = EncryptedAttachmentEnvelope(
    id: attachmentID,
    noteId: noteID,
    version: 1,
    ciphertext: encrypted.payload.ciphertext,
    nonce: encrypted.payload.nonce,
    isLocked: true,
    ciphertextBytes: encrypted.body.count
  )
  let metadata = try AttachmentCrypto.decryptMetadata(envelope, mediaKeyValue: mediaKey)
  #expect(metadata.contentType == "image/png")
  #expect(
    try AttachmentCrypto.decryptBody(
      encrypted.body,
      envelope: envelope,
      metadata: metadata
    ) == image
  )

  let moved = EncryptedAttachmentEnvelope(
    id: attachmentID,
    noteId: "note_attachment_other",
    version: 1,
    ciphertext: envelope.ciphertext,
    nonce: envelope.nonce,
    isLocked: true,
    ciphertextBytes: envelope.ciphertextBytes
  )
  #expect(throws: AttachmentCryptoError.decryptionFailed) {
    try AttachmentCrypto.decryptMetadata(moved, mediaKeyValue: mediaKey)
  }
}

@Test("Protected note payload also protects the shared attachment media key")
func protectedAttachmentKeyRoundTrip() throws {
  let created = try NoteProtectionCrypto.createKeyring(
    password: "correct horse battery staple"
  )
  let mediaKey = AttachmentCrypto.createMediaKey()
  let envelope = try NoteProtectionCrypto.encryptBody(
    "protected body",
    noteID: "note_protected_media",
    attachmentKey: mediaKey,
    using: created.key
  )
  let payload = try NoteProtectionCrypto.decryptPayload(
    envelope,
    noteID: "note_protected_media",
    using: created.key
  )
  #expect(payload.content == "protected body")
  #expect(payload.attachmentKey == mediaKey)
}

@Test("Folder names are encrypted and bound to their folder id")
func folderRoundTripAndBinding() throws {
  let key = SymmetricKey(size: .bits256)
  let payload = try FolderCrypto.encrypt(
    FolderContent(name: "账号信息"),
    id: "folder_12345678",
    using: key
  )
  #expect(!payload.ciphertext.contains("账号信息"))

  let envelope = EncryptedFolderEnvelope(
    id: payload.id,
    version: payload.version,
    ciphertext: payload.ciphertext,
    nonce: payload.nonce
  )
  #expect(try FolderCrypto.decrypt(envelope, using: key) == FolderContent(name: "账号信息"))

  let moved = EncryptedFolderEnvelope(
    id: "folder_87654321",
    version: payload.version,
    ciphertext: payload.ciphertext,
    nonce: payload.nonce
  )
  #expect(throws: FolderCryptoError.decryptionFailed) {
    try FolderCrypto.decrypt(moved, using: key)
  }
}

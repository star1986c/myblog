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

import CryptoKit
import Foundation
import CommonCrypto

public enum NoteCryptoError: LocalizedError, Equatable {
  case invalidKey
  case invalidEnvelope
  case decryptionFailed

  public var errorDescription: String? {
    switch self {
    case .invalidKey: "记事加密密钥无效。"
    case .invalidEnvelope: "加密笔记格式无效。"
    case .decryptionFailed: "无法解密笔记，请确认密钥和数据完整。"
    }
  }
}

public enum NoteCrypto {
  private static let envelopeVersion = 1
  private static let nonceBytes = 12
  private static let tagBytes = 16
  private static let keyBytes = 32

  public static func importDataKey(_ value: String) throws -> SymmetricKey {
    guard let data = decodeBase64URL(value), data.count == keyBytes else {
      throw NoteCryptoError.invalidKey
    }
    return SymmetricKey(data: data)
  }

  public static func encrypt(
    _ content: NoteContent,
    id: String,
    using key: SymmetricKey
  ) throws -> EncryptedNotePayload {
    let normalized = content.normalized()
    let plaintext = try JSONEncoder().encode(normalized)
    let nonce = AES.GCM.Nonce()
    let sealed = try AES.GCM.seal(
      plaintext,
      using: key,
      nonce: nonce,
      authenticating: additionalData(id: id, version: envelopeVersion)
    )
    var encrypted = sealed.ciphertext
    encrypted.append(sealed.tag)
    return EncryptedNotePayload(
      id: id,
      version: envelopeVersion,
      ciphertext: encodeBase64URL(encrypted),
      nonce: encodeBase64URL(Data(nonce)),
      isLocked: normalized.protectedContent != nil
    )
  }

  public static func decrypt(
    _ envelope: EncryptedNoteEnvelope,
    using key: SymmetricKey
  ) throws -> NoteContent {
    guard envelope.version == envelopeVersion,
      let nonceData = decodeBase64URL(envelope.nonce),
      nonceData.count == nonceBytes,
      let encrypted = decodeBase64URL(envelope.ciphertext),
      encrypted.count > tagBytes
    else {
      throw NoteCryptoError.invalidEnvelope
    }

    let ciphertext = encrypted.dropLast(tagBytes)
    let tag = encrypted.suffix(tagBytes)
    do {
      let box = try AES.GCM.SealedBox(
        nonce: AES.GCM.Nonce(data: nonceData),
        ciphertext: ciphertext,
        tag: tag
      )
      let plaintext = try AES.GCM.open(
        box,
        using: key,
        authenticating: additionalData(id: envelope.id, version: envelope.version)
      )
      return try JSONDecoder().decode(NoteContent.self, from: plaintext).normalized()
    } catch {
      throw NoteCryptoError.decryptionFailed
    }
  }

  private static func additionalData(id: String, version: Int) -> Data {
    Data("ai-build-lab:encrypted-note:\(id):v\(version)".utf8)
  }

  static func encodeBase64URL(_ data: Data) -> String {
    data.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  static func decodeBase64URL(_ value: String) -> Data? {
    guard !value.isEmpty,
      value.unicodeScalars.allSatisfy({
        CharacterSet.alphanumerics.contains($0) || $0 == "-" || $0 == "_"
      })
    else {
      return nil
    }
    var normalized =
      value
      .replacingOccurrences(of: "-", with: "+")
      .replacingOccurrences(of: "_", with: "/")
    normalized += String(repeating: "=", count: (4 - normalized.count % 4) % 4)
    return Data(base64Encoded: normalized)
  }
}

public enum AttachmentCryptoError: LocalizedError, Equatable {
  case unsupportedImage
  case imageTooLarge
  case invalidEnvelope
  case decryptionFailed

  public var errorDescription: String? {
    switch self {
    case .unsupportedImage: "仅支持 JPEG、PNG 和 WebP 图片。"
    case .imageTooLarge: "单张图片不能超过 10 MiB。"
    case .invalidEnvelope: "加密图片格式无效。"
    case .decryptionFailed: "图片无法解密，请确认数据完整。"
    }
  }
}

public enum AttachmentCrypto {
  public static let maxPlaintextBytes = 10 * 1024 * 1024
  private static let version = 1
  private static let nonceBytes = 12
  private static let tagBytes = 16
  private static let allowedContentTypes = ["image/jpeg", "image/png", "image/webp", "audio/mp4"]

  public struct EncryptedImage: Equatable, Sendable {
    public let payload: EncryptedAttachmentPayload
    public let body: Data
    public let metadata: AttachmentMetadata
  }

  public static func createMediaKey() -> String {
    let key = SymmetricKey(size: .bits256)
    return NoteCrypto.encodeBase64URL(key.withUnsafeBytes { Data($0) })
  }

  public static func encrypt(
    _ imageData: Data,
    contentType: String,
    pixelWidth: Int,
    pixelHeight: Int,
    noteID: String,
    attachmentID: String,
    isLocked: Bool,
    mediaKeyValue: String
  ) throws -> EncryptedImage {
    guard allowedContentTypes.contains(contentType) else {
      throw AttachmentCryptoError.unsupportedImage
    }
    guard !imageData.isEmpty, imageData.count <= maxPlaintextBytes else {
      throw AttachmentCryptoError.imageTooLarge
    }
    let mediaKey = try NoteCrypto.importDataKey(mediaKeyValue)
    let attachmentKey = SymmetricKey(size: .bits256)
    let objectNonce = AES.GCM.Nonce()
    let objectBox = try AES.GCM.seal(
      imageData,
      using: attachmentKey,
      nonce: objectNonce,
      authenticating: contentAdditionalData(noteID: noteID, attachmentID: attachmentID)
    )
    var encryptedBody = objectBox.ciphertext
    encryptedBody.append(objectBox.tag)

    let metadata = AttachmentMetadata(
      contentType: contentType,
      pixelWidth: max(1, pixelWidth),
      pixelHeight: max(1, pixelHeight),
      plaintextBytes: imageData.count,
      durationMillis: nil,
      objectNonce: NoteCrypto.encodeBase64URL(Data(objectNonce)),
      dataKey: NoteCrypto.encodeBase64URL(attachmentKey.withUnsafeBytes { Data($0) })
    )
    let metadataNonce = AES.GCM.Nonce()
    let metadataBox = try AES.GCM.seal(
      JSONEncoder().encode(metadata),
      using: mediaKey,
      nonce: metadataNonce,
      authenticating: metadataAdditionalData(noteID: noteID, attachmentID: attachmentID)
    )
    var encryptedMetadata = metadataBox.ciphertext
    encryptedMetadata.append(metadataBox.tag)
    return EncryptedImage(
      payload: EncryptedAttachmentPayload(
        id: attachmentID,
        noteId: noteID,
        ciphertext: NoteCrypto.encodeBase64URL(encryptedMetadata),
        nonce: NoteCrypto.encodeBase64URL(Data(metadataNonce)),
        isLocked: isLocked
      ),
      body: encryptedBody,
      metadata: metadata
    )
  }

  public static func decryptMetadata(
    _ envelope: EncryptedAttachmentEnvelope,
    mediaKeyValue: String
  ) throws -> AttachmentMetadata {
    guard envelope.version == version,
      let nonce = NoteCrypto.decodeBase64URL(envelope.nonce), nonce.count == nonceBytes,
      let encrypted = NoteCrypto.decodeBase64URL(envelope.ciphertext), encrypted.count > tagBytes
    else { throw AttachmentCryptoError.invalidEnvelope }
    do {
      let mediaKey = try NoteCrypto.importDataKey(mediaKeyValue)
      let box = try AES.GCM.SealedBox(
        nonce: AES.GCM.Nonce(data: nonce),
        ciphertext: encrypted.dropLast(tagBytes),
        tag: encrypted.suffix(tagBytes)
      )
      let plaintext = try AES.GCM.open(
        box,
        using: mediaKey,
        authenticating: metadataAdditionalData(
          noteID: envelope.noteId,
          attachmentID: envelope.id
        )
      )
      let metadata = try JSONDecoder().decode(AttachmentMetadata.self, from: plaintext)
      guard allowedContentTypes.contains(metadata.contentType),
        metadata.plaintextBytes > 0,
        metadata.plaintextBytes <= maxPlaintextBytes,
        (metadata.contentType != "audio/mp4"
          || ((metadata.durationMillis ?? 0) > 0 && (metadata.durationMillis ?? 0) <= 300_000)),
        NoteCrypto.decodeBase64URL(metadata.objectNonce)?.count == nonceBytes,
        NoteCrypto.decodeBase64URL(metadata.dataKey)?.count == 32
      else { throw AttachmentCryptoError.invalidEnvelope }
      return metadata
    } catch let error as AttachmentCryptoError {
      throw error
    } catch {
      throw AttachmentCryptoError.decryptionFailed
    }
  }

  public static func decryptBody(
    _ encryptedBody: Data,
    envelope: EncryptedAttachmentEnvelope,
    metadata: AttachmentMetadata
  ) throws -> Data {
    guard encryptedBody.count == envelope.ciphertextBytes,
      encryptedBody.count > tagBytes,
      let nonce = NoteCrypto.decodeBase64URL(metadata.objectNonce), nonce.count == nonceBytes,
      let keyData = NoteCrypto.decodeBase64URL(metadata.dataKey), keyData.count == 32
    else { throw AttachmentCryptoError.invalidEnvelope }
    do {
      let box = try AES.GCM.SealedBox(
        nonce: AES.GCM.Nonce(data: nonce),
        ciphertext: encryptedBody.dropLast(tagBytes),
        tag: encryptedBody.suffix(tagBytes)
      )
      let plaintext = try AES.GCM.open(
        box,
        using: SymmetricKey(data: keyData),
        authenticating: contentAdditionalData(
          noteID: envelope.noteId,
          attachmentID: envelope.id
        )
      )
      guard plaintext.count == metadata.plaintextBytes else {
        throw AttachmentCryptoError.invalidEnvelope
      }
      return plaintext
    } catch let error as AttachmentCryptoError {
      throw error
    } catch {
      throw AttachmentCryptoError.decryptionFailed
    }
  }

  private static func metadataAdditionalData(noteID: String, attachmentID: String) -> Data {
    Data("my-notes:attachment-metadata:\(noteID):\(attachmentID):v1".utf8)
  }

  private static func contentAdditionalData(noteID: String, attachmentID: String) -> Data {
    Data("my-notes:attachment-content:\(noteID):\(attachmentID):v1".utf8)
  }
}

public struct ProtectedNotePlaintext: Codable, Equatable, Sendable {
  public var content: String
  public var attachmentKey: String?

  public init(content: String, attachmentKey: String? = nil) {
    self.content = content
    self.attachmentKey = attachmentKey
  }
}

public enum NoteProtectionCrypto {
  public static let iterations = 310_000
  private static let keyBytes = 32
  private static let saltBytes = 16
  private static let nonceBytes = 12
  private static let tagBytes = 16

  public static func createKeyring(password: String) throws
    -> (payload: NoteProtectionKeyringPayload, key: SymmetricKey)
  {
    guard password.count >= 12 else { throw NoteUnlockError.passwordTooShort }
    let protectionKey = SymmetricKey(size: .bits256)
    let salt = randomData(count: saltBytes)
    let wrappingKey = try deriveKey(password: password, salt: salt, iterations: iterations)
    let wrapped = try seal(
      Data(protectionKey.withUnsafeBytes { Data($0) }),
      using: wrappingKey,
      additionalData: Data("ai-build-lab:note-protection-key:v1".utf8)
    )
    return (
      NoteProtectionKeyringPayload(
        id: "notes-protection",
        version: 1,
        kdf: "PBKDF2-SHA256",
        iterations: iterations,
        salt: NoteCrypto.encodeBase64URL(salt),
        wrappedKey: wrapped.ciphertext,
        nonce: wrapped.nonce
      ),
      protectionKey
    )
  }

  public static func unlockKeyring(
    _ keyring: NoteProtectionKeyring,
    password: String
  ) throws -> SymmetricKey {
    guard keyring.id == "notes-protection", keyring.version == 1,
      keyring.kdf == "PBKDF2-SHA256",
      let salt = NoteCrypto.decodeBase64URL(keyring.salt), salt.count == saltBytes,
      let nonce = NoteCrypto.decodeBase64URL(keyring.nonce), nonce.count == nonceBytes,
      let wrapped = NoteCrypto.decodeBase64URL(keyring.wrappedKey),
      wrapped.count == keyBytes + tagBytes
    else { throw NoteCryptoError.invalidEnvelope }
    let wrappingKey = try deriveKey(
      password: password,
      salt: salt,
      iterations: keyring.iterations
    )
    do {
      let plaintext = try open(
        wrapped,
        nonce: nonce,
        using: wrappingKey,
        additionalData: Data("ai-build-lab:note-protection-key:v1".utf8)
      )
      guard plaintext.count == keyBytes else { throw NoteCryptoError.invalidKey }
      return SymmetricKey(data: plaintext)
    } catch {
      throw NoteUnlockError.incorrectPassword
    }
  }

  public static func encryptBody(
    _ content: String,
    noteID: String,
    attachmentKey: String? = nil,
    using key: SymmetricKey
  ) throws -> ProtectedNoteBodyEnvelope {
    let plaintext: Data
    if let attachmentKey {
      plaintext = try JSONEncoder().encode(
        ProtectedNotePlaintext(
          content: String(content.prefix(500_000)),
          attachmentKey: attachmentKey
        )
      )
    } else {
      plaintext = Data(content.prefix(500_000).utf8)
    }
    let sealed = try seal(
      plaintext,
      using: key,
      additionalData: bodyAdditionalData(noteID)
    )
    return ProtectedNoteBodyEnvelope(ciphertext: sealed.ciphertext, nonce: sealed.nonce)
  }

  public static func decryptBody(
    _ envelope: ProtectedNoteBodyEnvelope,
    noteID: String,
    using key: SymmetricKey
  ) throws -> String {
    try decryptPayload(envelope, noteID: noteID, using: key).content
  }

  public static func decryptPayload(
    _ envelope: ProtectedNoteBodyEnvelope,
    noteID: String,
    using key: SymmetricKey
  ) throws -> ProtectedNotePlaintext {
    guard envelope.version == 1,
      let nonce = NoteCrypto.decodeBase64URL(envelope.nonce), nonce.count == nonceBytes,
      let encrypted = NoteCrypto.decodeBase64URL(envelope.ciphertext), encrypted.count > tagBytes
    else { throw NoteCryptoError.invalidEnvelope }
    do {
      let plaintext = try open(
        encrypted,
        nonce: nonce,
        using: key,
        additionalData: bodyAdditionalData(noteID)
      )
      if let payload = try? JSONDecoder().decode(ProtectedNotePlaintext.self, from: plaintext) {
        return payload
      }
      guard let value = String(data: plaintext, encoding: .utf8) else {
        throw NoteCryptoError.invalidEnvelope
      }
      return ProtectedNotePlaintext(content: value)
    } catch {
      throw NoteCryptoError.decryptionFailed
    }
  }

  private static func deriveKey(password: String, salt: Data, iterations: Int) throws
    -> SymmetricKey
  {
    guard iterations >= 100_000, iterations <= 2_000_000 else {
      throw NoteCryptoError.invalidEnvelope
    }
    var result = Data(count: keyBytes)
    let status = result.withUnsafeMutableBytes { outputBuffer in
      salt.withUnsafeBytes { saltBuffer in
        password.withCString { passwordPointer in
          CCKeyDerivationPBKDF(
            CCPBKDFAlgorithm(kCCPBKDF2),
            passwordPointer,
            password.lengthOfBytes(using: .utf8),
            saltBuffer.bindMemory(to: UInt8.self).baseAddress,
            salt.count,
            CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
            UInt32(iterations),
            outputBuffer.bindMemory(to: UInt8.self).baseAddress,
            keyBytes
          )
        }
      }
    }
    guard status == kCCSuccess else { throw NoteCryptoError.invalidKey }
    return SymmetricKey(data: result)
  }

  private static func seal(
    _ plaintext: Data,
    using key: SymmetricKey,
    additionalData: Data
  ) throws -> (ciphertext: String, nonce: String) {
    let nonce = AES.GCM.Nonce()
    let sealed = try AES.GCM.seal(
      plaintext,
      using: key,
      nonce: nonce,
      authenticating: additionalData
    )
    var encrypted = sealed.ciphertext
    encrypted.append(sealed.tag)
    return (
      NoteCrypto.encodeBase64URL(encrypted),
      NoteCrypto.encodeBase64URL(Data(nonce))
    )
  }

  private static func open(
    _ encrypted: Data,
    nonce: Data,
    using key: SymmetricKey,
    additionalData: Data
  ) throws -> Data {
    let box = try AES.GCM.SealedBox(
      nonce: AES.GCM.Nonce(data: nonce),
      ciphertext: encrypted.dropLast(tagBytes),
      tag: encrypted.suffix(tagBytes)
    )
    return try AES.GCM.open(box, using: key, authenticating: additionalData)
  }

  private static func randomData(count: Int) -> Data {
    Data((0..<count).map { _ in UInt8.random(in: .min ... .max) })
  }

  private static func bodyAdditionalData(_ id: String) -> Data {
    Data("ai-build-lab:protected-note-body:\(id):v1".utf8)
  }
}

public enum FolderCryptoError: LocalizedError, Equatable {
  case invalidEnvelope
  case decryptionFailed

  public var errorDescription: String? {
    switch self {
    case .invalidEnvelope: "加密文件夹格式无效。"
    case .decryptionFailed: "无法解密文件夹名称，请确认密钥和数据完整。"
    }
  }
}

public enum FolderCrypto {
  private static let envelopeVersion = 1
  private static let nonceBytes = 12
  private static let tagBytes = 16

  public static func encrypt(
    _ content: FolderContent,
    id: String,
    using key: SymmetricKey
  ) throws -> EncryptedFolderPayload {
    let plaintext = try JSONEncoder().encode(content.normalized())
    let nonce = AES.GCM.Nonce()
    let sealed = try AES.GCM.seal(
      plaintext,
      using: key,
      nonce: nonce,
      authenticating: additionalData(id: id, version: envelopeVersion)
    )
    var encrypted = sealed.ciphertext
    encrypted.append(sealed.tag)
    return EncryptedFolderPayload(
      id: id,
      version: envelopeVersion,
      ciphertext: encodeBase64URL(encrypted),
      nonce: encodeBase64URL(Data(nonce))
    )
  }

  public static func decrypt(
    _ envelope: EncryptedFolderEnvelope,
    using key: SymmetricKey
  ) throws -> FolderContent {
    guard envelope.version == envelopeVersion,
      let nonceData = decodeBase64URL(envelope.nonce),
      nonceData.count == nonceBytes,
      let encrypted = decodeBase64URL(envelope.ciphertext),
      encrypted.count > tagBytes
    else {
      throw FolderCryptoError.invalidEnvelope
    }

    do {
      let box = try AES.GCM.SealedBox(
        nonce: AES.GCM.Nonce(data: nonceData),
        ciphertext: encrypted.dropLast(tagBytes),
        tag: encrypted.suffix(tagBytes)
      )
      let plaintext = try AES.GCM.open(
        box,
        using: key,
        authenticating: additionalData(id: envelope.id, version: envelope.version)
      )
      return try JSONDecoder().decode(FolderContent.self, from: plaintext).normalized()
    } catch {
      throw FolderCryptoError.decryptionFailed
    }
  }

  private static func additionalData(id: String, version: Int) -> Data {
    Data("ai-build-lab:encrypted-folder:\(id):v\(version)".utf8)
  }

  private static func encodeBase64URL(_ data: Data) -> String {
    data.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  private static func decodeBase64URL(_ value: String) -> Data? {
    guard !value.isEmpty,
      value.unicodeScalars.allSatisfy({
        CharacterSet.alphanumerics.contains($0) || $0 == "-" || $0 == "_"
      })
    else {
      return nil
    }
    var normalized = value
      .replacingOccurrences(of: "-", with: "+")
      .replacingOccurrences(of: "_", with: "/")
    normalized += String(repeating: "=", count: (4 - normalized.count % 4) % 4)
    return Data(base64Encoded: normalized)
  }
}

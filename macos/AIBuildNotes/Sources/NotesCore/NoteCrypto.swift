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
    using key: SymmetricKey
  ) throws -> ProtectedNoteBodyEnvelope {
    let sealed = try seal(
      Data(content.prefix(500_000).utf8),
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
      guard let value = String(data: plaintext, encoding: .utf8) else {
        throw NoteCryptoError.invalidEnvelope
      }
      return value
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

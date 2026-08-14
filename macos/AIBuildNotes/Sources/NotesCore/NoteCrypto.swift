import CryptoKit
import Foundation

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
      nonce: encodeBase64URL(Data(nonce))
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
    var normalized =
      value
      .replacingOccurrences(of: "-", with: "+")
      .replacingOccurrences(of: "_", with: "/")
    normalized += String(repeating: "=", count: (4 - normalized.count % 4) % 4)
    return Data(base64Encoded: normalized)
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

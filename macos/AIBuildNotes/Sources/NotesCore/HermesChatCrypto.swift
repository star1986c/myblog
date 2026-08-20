import CryptoKit
import Foundation

public enum HermesChatCryptoError: LocalizedError, Equatable, Sendable {
  case invalidKey
  case invalidEnvelope
  case invalidMessage
  case invalidAttachment
  case decryptionFailed

  public var errorDescription: String? {
    switch self {
    case .invalidKey: "聊天密钥必须是包含 32 字节的 Base64URL。"
    case .invalidEnvelope: "收到不支持的 Hermes 加密格式。"
    case .invalidMessage: "Hermes 消息格式无效。"
    case .invalidAttachment: "Hermes 附件格式无效。"
    case .decryptionFailed: "无法解密 Hermes 消息，请检查此 profile 的聊天密钥。"
    }
  }
}

public struct HermesEncryptedAttachment: Equatable, Sendable {
  public let descriptor: HermesChatAttachmentDescriptor
  public let ciphertext: Data
}

public struct HermesChatCrypto: Sendable {
  public static let maximumAttachmentBytes = 10 * 1024 * 1024
  public static let maximumAgentAttachmentBytes = 512 * 1024 * 1024
  public static let privateAttachmentStorage = "r2-private-v1"

  private let key: SymmetricKey

  public init(encodedKey: String) throws {
    guard let raw = Data(base64URLEncoded: encodedKey), raw.count == 32 else {
      throw HermesChatCryptoError.invalidKey
    }
    key = SymmetricKey(data: raw)
  }

  public static func generateKey() -> String {
    let key = SymmetricKey(size: .bits256)
    return key.withUnsafeBytes { Data($0).base64URLEncodedString() }
  }

  func encryptMessageEnvelope(
    sender: String,
    text: String,
    attachments: [HermesChatAttachmentDescriptor],
    messageID: String,
    sentAt: Int64,
    replaceSequence: Int64 = 0,
    finalUpdate: Bool = false
  ) throws -> HermesChatMessageEnvelope {
    guard sender == "client" || sender == "agent", Self.isCanonicalUUID(messageID) else {
      throw HermesChatCryptoError.invalidMessage
    }
    guard replaceSequence >= 0 else { throw HermesChatCryptoError.invalidMessage }
    for attachment in attachments {
      try Self.validate(descriptor: attachment, sender: sender)
    }
    let payload = HermesChatPlaintextPayload(
      text: text,
      attachments: attachments,
      replaceSeq: replaceSequence > 0 ? replaceSequence : nil,
      final: replaceSequence > 0 ? finalUpdate : nil
    )
    return try encryptPayload(payload, sender: sender, messageID: messageID, sentAt: sentAt)
  }

  func encryptInteractionEnvelope(
    promptID: String,
    optionID: String,
    messageID: String,
    sentAt: Int64
  ) throws -> HermesChatMessageEnvelope {
    guard Self.isCanonicalUUID(promptID), Self.isCanonicalUUID(messageID),
      Self.isInteractionToken(optionID)
    else { throw HermesChatCryptoError.invalidMessage }
    return try encryptPayload(
      HermesChatPlaintextPayload(
        text: "",
        interactionResponse: HermesChatInteractionResponse(
          promptId: promptID,
          optionId: optionID
        )
      ),
      sender: "client",
      messageID: messageID,
      sentAt: sentAt
    )
  }

  func decryptMessageEnvelope(
    _ envelope: HermesChatMessageEnvelope,
    sequence: Int64
  ) throws -> HermesChatMessage {
    guard envelope.v == 1, envelope.type == "message",
      envelope.sender == "client" || envelope.sender == "agent",
      Self.isCanonicalUUID(envelope.id), envelope.sentAt >= 0,
      envelope.encrypted.alg == "A256GCM"
    else { throw HermesChatCryptoError.invalidEnvelope }
    do {
      let plaintext = try open(
        encrypted: envelope.encrypted,
        authenticating: Self.messageAAD(
          id: envelope.id,
          sender: envelope.sender,
          sentAt: envelope.sentAt
        )
      )
      let payload = try JSONDecoder().decode(HermesChatPlaintextPayload.self, from: plaintext)
      let replaceSequence = payload.replaceSeq ?? 0
      let finalUpdate = payload.final ?? false
      if (payload.replaceSeq == nil) != (payload.final == nil) || replaceSequence < 0 {
        throw HermesChatCryptoError.invalidMessage
      }
      if let interaction = payload.interaction {
        try Self.validate(interaction: interaction, sender: envelope.sender)
      }
      guard payload.text.count <= 50_000, payload.attachments.count <= 8 else {
        throw HermesChatCryptoError.invalidMessage
      }
      for attachment in payload.attachments {
        try Self.validate(descriptor: attachment, sender: envelope.sender)
      }
      return HermesChatMessage(
        id: envelope.id,
        sender: envelope.sender,
        sentAt: envelope.sentAt,
        sequence: max(0, sequence),
        text: payload.text,
        attachments: payload.attachments,
        interaction: payload.interaction,
        replaceSequence: replaceSequence,
        finalUpdate: finalUpdate
      )
    } catch let error as HermesChatCryptoError {
      throw error
    } catch {
      throw HermesChatCryptoError.decryptionFailed
    }
  }

  public func encryptAttachment(
    _ plaintext: Data,
    contentType: String,
    filename: String
  ) throws -> HermesEncryptedAttachment {
    guard !plaintext.isEmpty, plaintext.count <= Self.maximumAttachmentBytes else {
      throw HermesChatCryptoError.invalidAttachment
    }
    let id = UUID().uuidString.lowercased()
    let safeType = try Self.safeContentType(contentType)
    let nonce = AES.GCM.Nonce()
    let sealed = try AES.GCM.seal(
      plaintext,
      using: key,
      nonce: nonce,
      authenticating: Self.attachmentAAD(
        id: id,
        contentType: safeType,
        bytes: plaintext.count
      )
    )
    let descriptor = HermesChatAttachmentDescriptor(
      id: id,
      name: Self.safeFilename(filename),
      contentType: safeType,
      plaintextBytes: plaintext.count,
      nonce: Data(nonce).base64URLEncodedString()
    )
    return HermesEncryptedAttachment(
      descriptor: descriptor,
      ciphertext: sealed.ciphertext + sealed.tag
    )
  }

  public func decryptAttachment(
    _ ciphertext: Data,
    descriptor: HermesChatAttachmentDescriptor
  ) throws -> Data {
    try Self.validate(descriptor: descriptor, sender: "client")
    guard let nonce = descriptor.nonce,
      let nonceData = Data(base64URLEncoded: nonce), nonceData.count == 12,
      ciphertext.count >= 16
    else { throw HermesChatCryptoError.invalidAttachment }
    do {
      let sealed = try AES.GCM.SealedBox(
        nonce: AES.GCM.Nonce(data: nonceData),
        ciphertext: ciphertext.dropLast(16),
        tag: ciphertext.suffix(16)
      )
      let plaintext = try AES.GCM.open(
        sealed,
        using: key,
        authenticating: Self.attachmentAAD(
          id: descriptor.id,
          contentType: descriptor.contentType,
          bytes: descriptor.plaintextBytes
        )
      )
      guard plaintext.count == descriptor.plaintextBytes else {
        throw HermesChatCryptoError.invalidAttachment
      }
      return plaintext
    } catch let error as HermesChatCryptoError {
      throw error
    } catch {
      throw HermesChatCryptoError.decryptionFailed
    }
  }

  func encryptLocalSnapshot(_ plaintext: Data, spaceID: String) throws -> HermesChatLocalEnvelope {
    let nonce = AES.GCM.Nonce()
    let sealed = try AES.GCM.seal(
      plaintext,
      using: key,
      nonce: nonce,
      authenticating: try Self.localSnapshotAAD(spaceID: spaceID)
    )
    return HermesChatLocalEnvelope(
      v: 1,
      alg: "A256GCM",
      nonce: Data(nonce).base64URLEncodedString(),
      ciphertext: (sealed.ciphertext + sealed.tag).base64URLEncodedString()
    )
  }

  func decryptLocalSnapshot(_ envelope: HermesChatLocalEnvelope, spaceID: String) throws -> Data {
    guard envelope.v == 1, envelope.alg == "A256GCM",
      let nonce = Data(base64URLEncoded: envelope.nonce), nonce.count == 12,
      let combined = Data(base64URLEncoded: envelope.ciphertext), combined.count >= 16
    else { throw HermesChatCryptoError.invalidEnvelope }
    do {
      let box = try AES.GCM.SealedBox(
        nonce: AES.GCM.Nonce(data: nonce),
        ciphertext: combined.dropLast(16),
        tag: combined.suffix(16)
      )
      return try AES.GCM.open(
        box,
        using: key,
        authenticating: Self.localSnapshotAAD(spaceID: spaceID)
      )
    } catch let error as HermesChatCryptoError {
      throw error
    } catch {
      throw HermesChatCryptoError.decryptionFailed
    }
  }

  private func encryptPayload(
    _ payload: HermesChatPlaintextPayload,
    sender: String,
    messageID: String,
    sentAt: Int64
  ) throws -> HermesChatMessageEnvelope {
    let plaintext = try JSONEncoder().encode(payload)
    let nonce = AES.GCM.Nonce()
    let sealed = try AES.GCM.seal(
      plaintext,
      using: key,
      nonce: nonce,
      authenticating: Self.messageAAD(id: messageID, sender: sender, sentAt: sentAt)
    )
    return HermesChatMessageEnvelope(
      v: 1,
      type: "message",
      id: messageID,
      sender: sender,
      sentAt: sentAt,
      encrypted: HermesChatEncryptedFields(
        alg: "A256GCM",
        nonce: Data(nonce).base64URLEncodedString(),
        ciphertext: (sealed.ciphertext + sealed.tag).base64URLEncodedString()
      )
    )
  }

  private func open(encrypted: HermesChatEncryptedFields, authenticating aad: Data) throws -> Data {
    guard let nonce = Data(base64URLEncoded: encrypted.nonce), nonce.count == 12,
      let combined = Data(base64URLEncoded: encrypted.ciphertext), combined.count >= 16
    else { throw HermesChatCryptoError.invalidEnvelope }
    let box = try AES.GCM.SealedBox(
      nonce: AES.GCM.Nonce(data: nonce),
      ciphertext: combined.dropLast(16),
      tag: combined.suffix(16)
    )
    return try AES.GCM.open(box, using: key, authenticating: aad)
  }

  private static func messageAAD(id: String, sender: String, sentAt: Int64) -> Data {
    Data("hermes-chat-message-v1|\(id)|\(sender)|\(sentAt)".utf8)
  }

  private static func attachmentAAD(id: String, contentType: String, bytes: Int) -> Data {
    Data("hermes-chat-attachment-v1|\(id)|\(contentType)|\(bytes)".utf8)
  }

  private static func localSnapshotAAD(spaceID: String) throws -> Data {
    let normalized = spaceID.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard normalized.range(of: "^[a-z0-9][a-z0-9_-]{0,63}$", options: .regularExpression)
      == normalized.startIndex..<normalized.endIndex
    else { throw HermesChatCryptoError.invalidMessage }
    return Data("hermes-chat-local-cache-v1|\(normalized)".utf8)
  }

  private static func validate(
    descriptor: HermesChatAttachmentDescriptor,
    sender: String
  ) throws {
    guard isCanonicalUUID(descriptor.id), descriptor.plaintextBytes > 0,
      !descriptor.name.isEmpty, descriptor.name.count <= 120,
      (try? safeContentType(descriptor.contentType)) == descriptor.contentType
    else { throw HermesChatCryptoError.invalidAttachment }
    if descriptor.isPrivateR2 {
      guard sender == "agent",
        descriptor.plaintextBytes > maximumAttachmentBytes,
        descriptor.plaintextBytes <= maximumAgentAttachmentBytes,
        descriptor.nonce?.isEmpty != false,
        let sha256 = descriptor.sha256,
        sha256.count == 64,
        sha256 == sha256.lowercased(),
        sha256.range(of: "^[0-9a-f]{64}$", options: .regularExpression)
          == sha256.startIndex..<sha256.endIndex
      else { throw HermesChatCryptoError.invalidAttachment }
      return
    }
    guard descriptor.storage == nil || descriptor.storage == "" || descriptor.storage == "encrypted-v1",
      descriptor.sha256 == nil || descriptor.sha256 == "",
      descriptor.plaintextBytes <= maximumAttachmentBytes,
      let nonce = descriptor.nonce,
      Data(base64URLEncoded: nonce)?.count == 12
    else { throw HermesChatCryptoError.invalidAttachment }
  }

  private static func validate(interaction: HermesChatInteraction, sender: String) throws {
    let kinds = ["approval", "slash_confirm", "clarify", "model", "choice"]
    let states = ["pending", "resolved", "expired", "error"]
    guard sender == "agent", isCanonicalUUID(interaction.id), kinds.contains(interaction.kind),
      states.contains(interaction.state), interaction.expiresAt >= 0,
      interaction.options.count <= 24,
      (interaction.state != "pending" || !interaction.options.isEmpty),
      (interaction.stage?.count ?? 0) <= 32,
      (interaction.status?.count ?? 0) <= 500,
      (interaction.pageInfo?.count ?? 0) <= 100
    else { throw HermesChatCryptoError.invalidMessage }
    for option in interaction.options {
      guard isInteractionToken(option.id), !option.label.isEmpty, option.label.count <= 120,
        ["default", "primary", "danger", "warning"].contains(option.style)
      else { throw HermesChatCryptoError.invalidMessage }
    }
  }

  private static func isCanonicalUUID(_ value: String) -> Bool {
    guard let parsed = UUID(uuidString: value) else { return false }
    return parsed.uuidString.lowercased() == value.lowercased() && value == value.lowercased()
  }

  private static func isInteractionToken(_ value: String) -> Bool {
    guard (1...64).contains(value.count) else { return false }
    return value.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression)
      == value.startIndex..<value.endIndex
  }

  private static func safeContentType(_ value: String) throws -> String {
    let normalized = value.split(separator: ";", maxSplits: 1).first.map(String.init)?
      .trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
      ?? "application/octet-stream"
    guard !normalized.isEmpty, normalized.count <= 100,
      normalized.range(of: "^[a-z0-9!#$&^_.+\\-/]+$", options: .regularExpression)
        == normalized.startIndex..<normalized.endIndex
    else { throw HermesChatCryptoError.invalidAttachment }
    return normalized
  }

  private static func safeFilename(_ value: String) -> String {
    let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "._ -"))
    let output = value.unicodeScalars.map { allowed.contains($0) ? Character(String($0)) : "_" }
    var filename = String(output).trimmingCharacters(in: CharacterSet(charactersIn: " ."))
    if filename.isEmpty { filename = "attachment" }
    return String(filename.prefix(120))
  }
}

private extension Data {
  init?(base64URLEncoded value: String) {
    var normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
      .replacingOccurrences(of: "-", with: "+")
      .replacingOccurrences(of: "_", with: "/")
    let remainder = normalized.count % 4
    if remainder != 0 { normalized.append(String(repeating: "=", count: 4 - remainder)) }
    self.init(base64Encoded: normalized)
  }

  func base64URLEncodedString() -> String {
    base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}

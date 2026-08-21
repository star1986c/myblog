import Foundation

public struct HermesChatProfile: Codable, Equatable, Hashable, Identifiable, Sendable {
  public let id: String
  public let label: String

  public init(id: String, label: String) {
    self.id = id
    self.label = label
  }
}

public struct HermesChatMultiplexTicket: Codable, Equatable, Sendable {
  public let ticket: String
  public let spaceIds: [String]
  public let expiresInSeconds: Int
}

public struct HermesChatDeleteResult: Codable, Equatable, Sendable {
  public let ok: Bool
  public let spaceId: String
  public let messagesDeleted: Int
  public let attachmentsDeleted: Int
}

public struct HermesChatCleanupResult: Codable, Equatable, Sendable {
  public let ok: Bool
  public let spaceId: String
  public let cloudRetentionDays: Int
  public let messagesDeleted: Int
  public let attachmentsDeleted: Int
  public let ciphertextBytesDeleted: Int
  public let lastSequence: Int64
}

public struct HermesChatAttachmentDescriptor: Codable, Equatable, Hashable, Identifiable, Sendable {
  public let id: String
  public let name: String
  public let contentType: String
  public let plaintextBytes: Int
  public let nonce: String?
  public let storage: String?
  public let sha256: String?

  public init(
    id: String,
    name: String,
    contentType: String,
    plaintextBytes: Int,
    nonce: String? = nil,
    storage: String? = nil,
    sha256: String? = nil
  ) {
    self.id = id
    self.name = name
    self.contentType = contentType
    self.plaintextBytes = plaintextBytes
    self.nonce = nonce
    self.storage = storage
    self.sha256 = sha256
  }

  public var isPrivateR2: Bool { storage == "r2-private-v1" }
}

public struct HermesChatDirectDownloadTicket: Codable, Equatable, Sendable {
  public let attachmentId: String
  public let storage: String
  public let plaintextBytes: Int
  public let sha256: String
  public let downloadUrl: String
  public let expiresInSeconds: Int
  public let expiresAt: String
}

public struct HermesChatInteractionOption: Codable, Equatable, Hashable, Identifiable, Sendable {
  public let id: String
  public let label: String
  public let style: String
  public let selected: Bool
  public let disabled: Bool
  public let wide: Bool

  public init(
    id: String,
    label: String,
    style: String = "default",
    selected: Bool = false,
    disabled: Bool = false,
    wide: Bool = false
  ) {
    self.id = id
    self.label = label
    self.style = style
    self.selected = selected
    self.disabled = disabled
    self.wide = wide
  }

  private enum CodingKeys: String, CodingKey {
    case id, label, style, selected, disabled, wide
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    id = try container.decode(String.self, forKey: .id)
    label = try container.decode(String.self, forKey: .label)
    style = try container.decodeIfPresent(String.self, forKey: .style) ?? "default"
    selected = try container.decodeIfPresent(Bool.self, forKey: .selected) ?? false
    disabled = try container.decodeIfPresent(Bool.self, forKey: .disabled) ?? false
    wide = try container.decodeIfPresent(Bool.self, forKey: .wide) ?? false
  }
}

public struct HermesChatInteraction: Codable, Equatable, Hashable, Identifiable, Sendable {
  public let id: String
  public let kind: String
  public let state: String
  public let expiresAt: Int64
  public let options: [HermesChatInteractionOption]
  public let stage: String?
  public let status: String?
  public let pageInfo: String?

  public init(
    id: String,
    kind: String,
    state: String,
    expiresAt: Int64,
    options: [HermesChatInteractionOption],
    stage: String? = nil,
    status: String? = nil,
    pageInfo: String? = nil
  ) {
    self.id = id
    self.kind = kind
    self.state = state
    self.expiresAt = expiresAt
    self.options = options
    self.stage = stage
    self.status = status
    self.pageInfo = pageInfo
  }

  public func isExpired(at milliseconds: Int64) -> Bool {
    state == "pending" && expiresAt > 0 && expiresAt <= milliseconds
  }

  public func isPending(at milliseconds: Int64) -> Bool {
    state == "pending" && !isExpired(at: milliseconds)
  }
}

public struct HermesChatMessage: Codable, Equatable, Identifiable, Sendable {
  public let id: String
  public let sender: String
  public let sentAt: Int64
  public var sequence: Int64
  public var text: String
  public var attachments: [HermesChatAttachmentDescriptor]
  public var interaction: HermesChatInteraction?
  public var replaceSequence: Int64
  public var finalUpdate: Bool

  public init(
    id: String,
    sender: String,
    sentAt: Int64,
    sequence: Int64,
    text: String,
    attachments: [HermesChatAttachmentDescriptor] = [],
    interaction: HermesChatInteraction? = nil,
    replaceSequence: Int64 = 0,
    finalUpdate: Bool = false
  ) {
    self.id = id
    self.sender = sender
    self.sentAt = sentAt
    self.sequence = sequence
    self.text = text
    self.attachments = attachments
    self.interaction = interaction
    self.replaceSequence = replaceSequence
    self.finalUpdate = finalUpdate
  }

  public var isAgent: Bool { sender == "agent" }
}

public enum HermesChatConnectionState: Equatable, Sendable {
  case idle
  case connecting
  case connected
  case disconnected(String)
}

public struct HermesChatHistorySnapshot: Equatable, Sendable {
  public var lastSequence: Int64
  public var messages: [HermesChatMessage]

  public init(lastSequence: Int64 = 0, messages: [HermesChatMessage] = []) {
    self.lastSequence = max(0, lastSequence)
    self.messages = messages
  }
}

struct HermesChatEncryptedFields: Codable, Equatable, Sendable {
  let alg: String
  let nonce: String
  let ciphertext: String
}

struct HermesChatMessageEnvelope: Codable, Equatable, Sendable {
  let v: Int
  let type: String
  let id: String
  let sender: String
  let sentAt: Int64
  let encrypted: HermesChatEncryptedFields
}

struct HermesChatInteractionResponse: Codable, Equatable, Sendable {
  let promptId: String
  let optionId: String
}

struct HermesChatPlaintextPayload: Codable, Equatable, Sendable {
  let text: String
  let attachments: [HermesChatAttachmentDescriptor]
  let interaction: HermesChatInteraction?
  let interactionResponse: HermesChatInteractionResponse?
  let replaceSeq: Int64?
  let final: Bool?

  init(
    text: String,
    attachments: [HermesChatAttachmentDescriptor] = [],
    interaction: HermesChatInteraction? = nil,
    interactionResponse: HermesChatInteractionResponse? = nil,
    replaceSeq: Int64? = nil,
    final: Bool? = nil
  ) {
    self.text = text
    self.attachments = attachments
    self.interaction = interaction
    self.interactionResponse = interactionResponse
    self.replaceSeq = replaceSeq
    self.final = final
  }
}

struct HermesChatLocalEnvelope: Codable, Equatable, Sendable {
  let v: Int
  let alg: String
  let nonce: String
  let ciphertext: String
}

struct HermesChatSnapshotPayload: Codable, Equatable, Sendable {
  let v: Int
  let lastSequence: Int64
  let messages: [HermesChatMessage]
}

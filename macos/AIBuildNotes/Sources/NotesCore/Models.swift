import Foundation

public struct AdminUser: Codable, Equatable, Sendable {
  public let username: String
  public let mustChangePassword: Bool

  public init(username: String, mustChangePassword: Bool) {
    self.username = username
    self.mustChangePassword = mustChangePassword
  }
}

public enum NoteUnlockError: LocalizedError, Equatable, Sendable {
  case incorrectPassword
  case passwordTooShort
  case confirmationMismatch
  case notConfigured

  public var errorDescription: String? {
    switch self {
    case .incorrectPassword: "密码不正确。"
    case .passwordTooShort: "保护密码至少需要 12 个字符。"
    case .confirmationMismatch: "两次输入的保护密码不一致。"
    case .notConfigured: "尚未设置独立保护密码。"
    }
  }
}

public struct EncryptedNoteEnvelope: Codable, Equatable, Identifiable, Sendable {
  public let id: String
  public var folderId: String?
  public let version: Int
  public var revision: Int
  public var ciphertext: String
  public var nonce: String
  public let createdAt: String?
  public var updatedAt: String?
  public var deletedAt: String?
  public var isLocked: Bool

  public init(
    id: String,
    folderId: String? = nil,
    version: Int,
    revision: Int = 1,
    ciphertext: String,
    nonce: String,
    createdAt: String? = nil,
    updatedAt: String? = nil,
    deletedAt: String? = nil,
    isLocked: Bool = false
  ) {
    self.id = id
    self.folderId = folderId
    self.version = version
    self.revision = revision
    self.ciphertext = ciphertext
    self.nonce = nonce
    self.createdAt = createdAt
    self.updatedAt = updatedAt
    self.deletedAt = deletedAt
    self.isLocked = isLocked
  }

  private enum CodingKeys: String, CodingKey {
    case id, folderId, version, revision, ciphertext, nonce, createdAt, updatedAt, deletedAt,
      isLocked
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    id = try container.decode(String.self, forKey: .id)
    folderId = try container.decodeIfPresent(String.self, forKey: .folderId)
    version = try container.decode(Int.self, forKey: .version)
    revision = try container.decodeIfPresent(Int.self, forKey: .revision) ?? 1
    ciphertext = try container.decode(String.self, forKey: .ciphertext)
    nonce = try container.decode(String.self, forKey: .nonce)
    createdAt = try container.decodeIfPresent(String.self, forKey: .createdAt)
    updatedAt = try container.decodeIfPresent(String.self, forKey: .updatedAt)
    deletedAt = try container.decodeIfPresent(String.self, forKey: .deletedAt)
    isLocked = try container.decodeIfPresent(Bool.self, forKey: .isLocked) ?? false
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(id, forKey: .id)
    try container.encodeIfPresent(folderId, forKey: .folderId)
    try container.encode(version, forKey: .version)
    try container.encode(revision, forKey: .revision)
    try container.encode(ciphertext, forKey: .ciphertext)
    try container.encode(nonce, forKey: .nonce)
    try container.encodeIfPresent(createdAt, forKey: .createdAt)
    try container.encodeIfPresent(updatedAt, forKey: .updatedAt)
    try container.encodeIfPresent(deletedAt, forKey: .deletedAt)
    try container.encode(isLocked, forKey: .isLocked)
  }

  public var displayDate: Date? {
    Self.parseDate(deletedAt ?? updatedAt ?? createdAt)
  }

  private static func parseDate(_ value: String?) -> Date? {
    guard let value else { return nil }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
  }
}

public struct EncryptedFolderEnvelope: Codable, Equatable, Identifiable, Sendable {
  public let id: String
  public let version: Int
  public var revision: Int
  public var ciphertext: String
  public var nonce: String
  public var sortOrder: Int?
  public let createdAt: String?
  public var updatedAt: String?

  public init(
    id: String,
    version: Int,
    revision: Int = 1,
    ciphertext: String,
    nonce: String,
    sortOrder: Int? = nil,
    createdAt: String? = nil,
    updatedAt: String? = nil
  ) {
    self.id = id
    self.version = version
    self.revision = revision
    self.ciphertext = ciphertext
    self.nonce = nonce
    self.sortOrder = sortOrder
    self.createdAt = createdAt
    self.updatedAt = updatedAt
  }
}

public struct EncryptedFolderPayload: Codable, Equatable, Sendable {
  public let id: String
  public let version: Int
  public let ciphertext: String
  public let nonce: String

  public init(id: String, version: Int, ciphertext: String, nonce: String) {
    self.id = id
    self.version = version
    self.ciphertext = ciphertext
    self.nonce = nonce
  }
}

public struct EncryptedAttachmentEnvelope: Codable, Equatable, Identifiable, Sendable {
  public let id: String
  public let noteId: String
  public let version: Int
  public var revision: Int
  public var ciphertext: String
  public var nonce: String
  public var isLocked: Bool
  public let ciphertextBytes: Int
  public let createdAt: String?
  public var updatedAt: String?

  public init(
    id: String,
    noteId: String,
    version: Int,
    revision: Int = 1,
    ciphertext: String,
    nonce: String,
    isLocked: Bool,
    ciphertextBytes: Int,
    createdAt: String? = nil,
    updatedAt: String? = nil
  ) {
    self.id = id
    self.noteId = noteId
    self.version = version
    self.revision = revision
    self.ciphertext = ciphertext
    self.nonce = nonce
    self.isLocked = isLocked
    self.ciphertextBytes = ciphertextBytes
    self.createdAt = createdAt
    self.updatedAt = updatedAt
  }
}

public struct EncryptedAttachmentPayload: Codable, Equatable, Sendable {
  public let id: String
  public let noteId: String
  public let version: Int
  public let ciphertext: String
  public let nonce: String
  public let isLocked: Bool

  public init(
    id: String,
    noteId: String,
    version: Int = 1,
    ciphertext: String,
    nonce: String,
    isLocked: Bool
  ) {
    self.id = id
    self.noteId = noteId
    self.version = version
    self.ciphertext = ciphertext
    self.nonce = nonce
    self.isLocked = isLocked
  }
}

public struct AttachmentMetadata: Codable, Equatable, Sendable {
  public let contentType: String
  public let pixelWidth: Int
  public let pixelHeight: Int
  public let plaintextBytes: Int
  public let objectNonce: String
  public let dataKey: String

  public init(
    contentType: String,
    pixelWidth: Int,
    pixelHeight: Int,
    plaintextBytes: Int,
    objectNonce: String,
    dataKey: String
  ) {
    self.contentType = contentType
    self.pixelWidth = pixelWidth
    self.pixelHeight = pixelHeight
    self.plaintextBytes = plaintextBytes
    self.objectNonce = objectNonce
    self.dataKey = dataKey
  }
}

public struct NoteAttachment: Equatable, Identifiable, Sendable {
  public var envelope: EncryptedAttachmentEnvelope
  public var metadata: AttachmentMetadata
  public var imageData: Data?

  public init(
    envelope: EncryptedAttachmentEnvelope,
    metadata: AttachmentMetadata,
    imageData: Data? = nil
  ) {
    self.envelope = envelope
    self.metadata = metadata
    self.imageData = imageData
  }

  public var id: String { envelope.id }
}

public struct AttachmentUsage: Codable, Equatable, Sendable {
  public let attachmentCount: Int
  public let ciphertextBytes: Int
  public let maxCiphertextBytes: Int
  public let maxAttachmentBytes: Int
  public let maxAttachmentsPerNote: Int
}

public struct FolderContent: Codable, Equatable, Sendable {
  public var name: String

  public init(name: String) {
    self.name = name
  }

  public func normalized() -> FolderContent {
    FolderContent(name: String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(80)))
  }
}

public struct NoteFolder: Equatable, Identifiable, Sendable {
  public var envelope: EncryptedFolderEnvelope
  public var content: FolderContent

  public init(envelope: EncryptedFolderEnvelope, content: FolderContent) {
    self.envelope = envelope
    self.content = content
  }

  public var id: String { envelope.id }
  public var name: String {
    let normalized = content.normalized().name
    return normalized.isEmpty ? "未命名文件夹" : normalized
  }
}

public struct EncryptedNotePayload: Codable, Equatable, Sendable {
  public let id: String
  public let version: Int
  public let ciphertext: String
  public let nonce: String
  public let isLocked: Bool

  public init(id: String, version: Int, ciphertext: String, nonce: String, isLocked: Bool = false) {
    self.id = id
    self.version = version
    self.ciphertext = ciphertext
    self.nonce = nonce
    self.isLocked = isLocked
  }
}

public struct ProtectedNoteBodyEnvelope: Codable, Equatable, Sendable {
  public let version: Int
  public let ciphertext: String
  public let nonce: String

  public init(version: Int = 1, ciphertext: String, nonce: String) {
    self.version = version
    self.ciphertext = ciphertext
    self.nonce = nonce
  }
}

public struct NoteProtectionKeyring: Codable, Equatable, Sendable {
  public let id: String
  public let version: Int
  public let kdf: String
  public let iterations: Int
  public let salt: String
  public let wrappedKey: String
  public let nonce: String
  public let revision: Int
  public let createdAt: String?
  public let updatedAt: String?

  public init(
    id: String = "notes-protection",
    version: Int = 1,
    kdf: String = "PBKDF2-SHA256",
    iterations: Int,
    salt: String,
    wrappedKey: String,
    nonce: String,
    revision: Int = 1,
    createdAt: String? = nil,
    updatedAt: String? = nil
  ) {
    self.id = id
    self.version = version
    self.kdf = kdf
    self.iterations = iterations
    self.salt = salt
    self.wrappedKey = wrappedKey
    self.nonce = nonce
    self.revision = revision
    self.createdAt = createdAt
    self.updatedAt = updatedAt
  }
}

public struct NoteProtectionKeyringPayload: Codable, Equatable, Sendable {
  public let id: String
  public let version: Int
  public let kdf: String
  public let iterations: Int
  public let salt: String
  public let wrappedKey: String
  public let nonce: String
}

public struct NoteContent: Codable, Equatable, Sendable {
  public var title: String
  public var content: String
  public var protectedContent: ProtectedNoteBodyEnvelope?
  public var attachmentKey: String?

  public init(
    title: String,
    content: String,
    protectedContent: ProtectedNoteBodyEnvelope? = nil,
    attachmentKey: String? = nil
  ) {
    self.title = title
    self.content = content
    self.protectedContent = protectedContent
    self.attachmentKey = attachmentKey
  }

  private enum CodingKeys: String, CodingKey {
    case title, content, protectedContent, attachmentKey, isProtected
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    title = try container.decode(String.self, forKey: .title)
    content = try container.decode(String.self, forKey: .content)
    protectedContent = try container.decodeIfPresent(
      ProtectedNoteBodyEnvelope.self,
      forKey: .protectedContent
    )
    attachmentKey = try container.decodeIfPresent(String.self, forKey: .attachmentKey)
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(title, forKey: .title)
    try container.encode(protectedContent == nil ? content : "", forKey: .content)
    try container.encodeIfPresent(protectedContent, forKey: .protectedContent)
    if protectedContent == nil {
      try container.encodeIfPresent(attachmentKey, forKey: .attachmentKey)
    }
  }

  public func normalized() -> NoteContent {
    let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
    return NoteContent(
      title: String((trimmedTitle.isEmpty ? "无标题笔记" : trimmedTitle).prefix(200)),
      content: String(content.prefix(500_000)),
      protectedContent: protectedContent,
      attachmentKey: attachmentKey
    )
  }
}

public struct NoteDocument: Equatable, Identifiable, Sendable {
  public var envelope: EncryptedNoteEnvelope
  public var content: NoteContent

  public init(envelope: EncryptedNoteEnvelope, content: NoteContent) {
    self.envelope = envelope
    self.content = content
  }

  public var id: String { envelope.id }
  public var folderId: String? { envelope.folderId }
  public var isProtected: Bool { envelope.isLocked }

  public var title: String {
    let value = content.title.trimmingCharacters(in: .whitespacesAndNewlines)
    return value.isEmpty ? "无标题笔记" : value
  }

  public var excerpt: String {
    if isProtected { return "••••••••" }
    let collapsed = content.content
      .split(whereSeparator: { $0.isWhitespace })
      .joined(separator: " ")
    return collapsed.isEmpty ? "暂无正文" : String(collapsed.prefix(90))
  }

  public func matches(search query: String) -> Bool {
    let value = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !value.isEmpty else { return true }
    return content.title.localizedCaseInsensitiveContains(value)
      || (!isProtected && content.content.localizedCaseInsensitiveContains(value))
  }

  public func belongs(to folderId: String?) -> Bool {
    envelope.folderId == folderId
  }
}

public enum NoteLocation: Hashable, Identifiable, Sendable {
  case allNotes
  case unfiled
  case folder(String)
  case trash

  public var id: String {
    switch self {
    case .allNotes: "all-notes"
    case .unfiled: "unfiled"
    case .folder(let id): "folder:\(id)"
    case .trash: "trash"
    }
  }

  public var isTrash: Bool { self == .trash }
}

public enum NoteListDisplayMode: String, CaseIterable, Identifiable, Sendable {
  case cards
  case details
  case titles

  public var id: String { rawValue }
  public var title: String {
    switch self {
    case .cards: "图文卡片"
    case .details: "详细列表"
    case .titles: "标题列表"
    }
  }
  public var systemImage: String {
    switch self {
    case .cards: "square.grid.2x2"
    case .details: "list.bullet.rectangle"
    case .titles: "list.bullet"
    }
  }
}

public enum NoteSaveState: Equatable, Sendable {
  case idle
  case dirty
  case saving
  case saved
  case failed
  case conflict
}

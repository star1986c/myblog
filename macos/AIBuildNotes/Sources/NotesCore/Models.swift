import Foundation

public struct AdminUser: Codable, Equatable, Sendable {
  public let username: String
  public let mustChangePassword: Bool

  public init(username: String, mustChangePassword: Bool) {
    self.username = username
    self.mustChangePassword = mustChangePassword
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

  public init(
    id: String,
    folderId: String? = nil,
    version: Int,
    revision: Int = 1,
    ciphertext: String,
    nonce: String,
    createdAt: String? = nil,
    updatedAt: String? = nil,
    deletedAt: String? = nil
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
  }

  private enum CodingKeys: String, CodingKey {
    case id, folderId, version, revision, ciphertext, nonce, createdAt, updatedAt, deletedAt
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
  public let createdAt: String?
  public var updatedAt: String?

  public init(
    id: String,
    version: Int,
    revision: Int = 1,
    ciphertext: String,
    nonce: String,
    createdAt: String? = nil,
    updatedAt: String? = nil
  ) {
    self.id = id
    self.version = version
    self.revision = revision
    self.ciphertext = ciphertext
    self.nonce = nonce
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

  public init(id: String, version: Int, ciphertext: String, nonce: String) {
    self.id = id
    self.version = version
    self.ciphertext = ciphertext
    self.nonce = nonce
  }
}

public struct NoteContent: Codable, Equatable, Sendable {
  public var title: String
  public var content: String

  public init(title: String, content: String) {
    self.title = title
    self.content = content
  }

  public func normalized() -> NoteContent {
    let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
    return NoteContent(
      title: String((trimmedTitle.isEmpty ? "无标题笔记" : trimmedTitle).prefix(200)),
      content: String(content.prefix(500_000))
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

  public var title: String {
    let value = content.title.trimmingCharacters(in: .whitespacesAndNewlines)
    return value.isEmpty ? "无标题笔记" : value
  }

  public var excerpt: String {
    let collapsed = content.content
      .split(whereSeparator: { $0.isWhitespace })
      .joined(separator: " ")
    return collapsed.isEmpty ? "暂无正文" : String(collapsed.prefix(90))
  }

  public func matches(search query: String) -> Bool {
    let value = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !value.isEmpty else { return true }
    return content.title.localizedCaseInsensitiveContains(value)
      || content.content.localizedCaseInsensitiveContains(value)
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
  case saving
  case saved
  case failed
  case conflict
}

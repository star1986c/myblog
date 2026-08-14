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
  public let version: Int
  public var revision: Int
  public var ciphertext: String
  public var nonce: String
  public let createdAt: String?
  public var updatedAt: String?
  public var deletedAt: String?

  public init(
    id: String,
    version: Int,
    revision: Int = 1,
    ciphertext: String,
    nonce: String,
    createdAt: String? = nil,
    updatedAt: String? = nil,
    deletedAt: String? = nil
  ) {
    self.id = id
    self.version = version
    self.revision = revision
    self.ciphertext = ciphertext
    self.nonce = nonce
    self.createdAt = createdAt
    self.updatedAt = updatedAt
    self.deletedAt = deletedAt
  }

  private enum CodingKeys: String, CodingKey {
    case id, version, revision, ciphertext, nonce, createdAt, updatedAt, deletedAt
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    id = try container.decode(String.self, forKey: .id)
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
}

public enum NoteSection: String, CaseIterable, Identifiable, Sendable {
  case notes
  case trash

  public var id: String { rawValue }
  public var title: String { self == .notes ? "全部笔记" : "回收站" }
  public var systemImage: String { self == .notes ? "note.text" : "trash" }
}

public enum NoteSaveState: Equatable, Sendable {
  case idle
  case saving
  case saved
  case failed
  case conflict
}

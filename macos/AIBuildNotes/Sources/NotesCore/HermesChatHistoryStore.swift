import CryptoKit
import Foundation

public actor HermesChatHistoryStore {
  private static let maximumSnapshotBytes = 64 * 1024 * 1024
  private static let maximumMessages = 20_000

  private let directory: URL
  private let snapshotURL: URL
  private let spaceID: String
  private let crypto: HermesChatCrypto
  private var cached: HermesChatHistorySnapshot?

  public init(
    spaceID: String,
    crypto: HermesChatCrypto,
    directory: URL? = nil
  ) throws {
    let normalized = try Self.normalize(spaceID)
    self.spaceID = normalized
    self.crypto = crypto
    self.directory = directory ?? Self.defaultDirectory
    self.snapshotURL = self.directory
      .appendingPathComponent(Self.sha256(normalized))
      .appendingPathExtension("json")
  }

  public func loadAndCleanup(
    retentionDays: Int,
    nowMilliseconds: Int64 = Int64(Date().timeIntervalSince1970 * 1_000)
  ) -> HermesChatHistorySnapshot {
    var snapshot = loadSnapshot()
    guard retentionDays > 0 else { return snapshot }
    let cutoff = nowMilliseconds - Int64(retentionDays) * 86_400_000
    let retained = snapshot.messages.filter { $0.sentAt <= 0 || $0.sentAt >= cutoff }
    if retained.count != snapshot.messages.count {
      snapshot.messages = retained
      cached = snapshot
      try? write(snapshot)
    }
    return snapshot
  }

  @discardableResult
  public func record(_ incoming: HermesChatMessage) -> HermesChatHistorySnapshot {
    var snapshot = loadSnapshot()
    if incoming.replaceSequence > 0 && !incoming.finalUpdate { return snapshot }

    if incoming.replaceSequence > 0 {
      if let index = snapshot.messages.firstIndex(where: {
        $0.sequence == incoming.replaceSequence
      }) {
        var target = snapshot.messages[index]
        target.text = incoming.text
        if !incoming.attachments.isEmpty { target.attachments = incoming.attachments }
        target.interaction = incoming.interaction
        target.replaceSequence = 0
        target.finalUpdate = false
        snapshot.messages[index] = target
      } else {
        var standalone = incoming
        standalone.replaceSequence = 0
        standalone.finalUpdate = false
        snapshot.messages.append(standalone)
      }
    } else if let index = snapshot.messages.firstIndex(where: { $0.id == incoming.id }) {
      snapshot.messages[index] = incoming
    } else {
      snapshot.messages.append(incoming)
    }

    if snapshot.messages.count > Self.maximumMessages {
      snapshot.messages.removeFirst(snapshot.messages.count - Self.maximumMessages)
    }
    snapshot.lastSequence = max(snapshot.lastSequence, max(0, incoming.sequence))
    cached = snapshot
    try? write(snapshot)
    return snapshot
  }

  @discardableResult
  public func acknowledge(messageID: String, sequence: Int64) -> HermesChatHistorySnapshot {
    guard sequence > 0 else { return loadSnapshot() }
    var snapshot = loadSnapshot()
    if let index = snapshot.messages.firstIndex(where: { $0.id == messageID }) {
      snapshot.messages[index].sequence = sequence
    }
    snapshot.lastSequence = max(snapshot.lastSequence, sequence)
    cached = snapshot
    try? write(snapshot)
    return snapshot
  }

  @discardableResult
  public func deleteMessages(ids: Set<String>) -> HermesChatHistorySnapshot {
    guard !ids.isEmpty else { return loadSnapshot() }
    var snapshot = loadSnapshot()
    snapshot.messages.removeAll { ids.contains($0.id) }
    cached = snapshot
    try? write(snapshot)
    return snapshot
  }

  @discardableResult
  public func clearMessages() -> HermesChatHistorySnapshot {
    var snapshot = loadSnapshot()
    snapshot.messages = []
    cached = snapshot
    try? write(snapshot)
    return snapshot
  }

  public func removeLocalSnapshot() {
    cached = HermesChatHistorySnapshot()
    try? FileManager.default.removeItem(at: snapshotURL)
  }

  private func loadSnapshot() -> HermesChatHistorySnapshot {
    if let cached { return cached }
    guard let data = try? Data(contentsOf: snapshotURL),
      !data.isEmpty, data.count <= Self.maximumSnapshotBytes
    else {
      let empty = HermesChatHistorySnapshot()
      cached = empty
      return empty
    }
    do {
      let envelope = try JSONDecoder().decode(HermesChatLocalEnvelope.self, from: data)
      let plaintext = try crypto.decryptLocalSnapshot(envelope, spaceID: spaceID)
      let payload = try JSONDecoder().decode(HermesChatSnapshotPayload.self, from: plaintext)
      guard payload.v == 1, payload.messages.count <= Self.maximumMessages else {
        throw HermesChatCryptoError.invalidEnvelope
      }
      let valid = payload.messages.filter(Self.isValidCachedMessage)
      guard valid.count == payload.messages.count else {
        throw HermesChatCryptoError.invalidMessage
      }
      let snapshot = HermesChatHistorySnapshot(
        lastSequence: payload.lastSequence,
        messages: valid
      )
      cached = snapshot
      return snapshot
    } catch {
      try? FileManager.default.removeItem(at: snapshotURL)
      let empty = HermesChatHistorySnapshot()
      cached = empty
      return empty
    }
  }

  private func write(_ snapshot: HermesChatHistorySnapshot) throws {
    try FileManager.default.createDirectory(
      at: directory,
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700]
    )
    let payload = HermesChatSnapshotPayload(
      v: 1,
      lastSequence: snapshot.lastSequence,
      messages: snapshot.messages
    )
    let plaintext = try JSONEncoder().encode(payload)
    let envelope = try crypto.encryptLocalSnapshot(plaintext, spaceID: spaceID)
    let encrypted = try JSONEncoder().encode(envelope)
    guard encrypted.count <= Self.maximumSnapshotBytes else {
      throw HermesChatCryptoError.invalidEnvelope
    }
    try encrypted.write(to: snapshotURL, options: [.atomic, .completeFileProtection])
    try? FileManager.default.setAttributes(
      [.posixPermissions: 0o600],
      ofItemAtPath: snapshotURL.path
    )
  }

  private static func isValidCachedMessage(_ message: HermesChatMessage) -> Bool {
    !message.id.isEmpty
      && (message.sender == "client" || message.sender == "agent")
      && message.sentAt >= 0
      && message.sequence >= 0
      && message.text.count <= 50_000
      && message.attachments.count <= 8
  }

  private static func normalize(_ value: String) throws -> String {
    let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard normalized.range(of: "^[a-z0-9][a-z0-9_-]{0,63}$", options: .regularExpression)
      == normalized.startIndex..<normalized.endIndex
    else { throw HermesChatCryptoError.invalidMessage }
    return normalized
  }

  private static func sha256(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
  }

  private static var defaultDirectory: URL {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)
      .first ?? FileManager.default.temporaryDirectory
    return base
      .appendingPathComponent("My Notes", isDirectory: true)
      .appendingPathComponent("HermesChatHistory-v1", isDirectory: true)
  }
}

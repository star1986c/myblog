import CryptoKit
import Foundation

public actor HermesChatAttachmentCache {
  private let root: URL

  public init(directory: URL? = nil) {
    if let directory {
      root = directory
    } else {
      let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)
        .first ?? FileManager.default.temporaryDirectory
      root = base
        .appendingPathComponent("My Notes", isDirectory: true)
        .appendingPathComponent("HermesChatAttachments-v1", isDirectory: true)
    }
  }

  public func data(
    for descriptor: HermesChatAttachmentDescriptor,
    spaceID: String
  ) -> Data? {
    let url = fileURL(for: descriptor, spaceID: spaceID)
    guard let data = try? Data(contentsOf: url),
      data.count == descriptor.plaintextBytes + 16
    else {
      try? FileManager.default.removeItem(at: url)
      return nil
    }
    return data
  }

  public func store(
    _ ciphertext: Data,
    for descriptor: HermesChatAttachmentDescriptor,
    spaceID: String
  ) {
    guard ciphertext.count == descriptor.plaintextBytes + 16 else { return }
    let directory = profileDirectory(spaceID)
    do {
      try FileManager.default.createDirectory(
        at: directory,
        withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700]
      )
      let url = fileURL(for: descriptor, spaceID: spaceID)
      try ciphertext.write(to: url, options: [.atomic, .completeFileProtection])
      try? FileManager.default.setAttributes(
        [.posixPermissions: 0o600],
        ofItemAtPath: url.path
      )
    } catch {
      // The R2 ciphertext cache is optional; a later open can download it again.
    }
  }

  public func remove(
    descriptor: HermesChatAttachmentDescriptor,
    spaceID: String
  ) {
    try? FileManager.default.removeItem(at: fileURL(for: descriptor, spaceID: spaceID))
  }

  public func clear(spaceID: String) {
    try? FileManager.default.removeItem(at: profileDirectory(spaceID))
  }

  public func cleanup(
    spaceID: String,
    retentionDays: Int,
    now: Date = Date()
  ) {
    guard retentionDays > 0 else { return }
    let directory = profileDirectory(spaceID)
    guard let files = try? FileManager.default.contentsOfDirectory(
      at: directory,
      includingPropertiesForKeys: [.contentModificationDateKey, .isRegularFileKey],
      options: [.skipsHiddenFiles]
    ) else { return }
    let cutoff = now.addingTimeInterval(-Double(retentionDays) * 86_400)
    for file in files {
      let values = try? file.resourceValues(forKeys: [
        .contentModificationDateKey,
        .isRegularFileKey,
      ])
      guard values?.isRegularFile == true,
        let modified = values?.contentModificationDate,
        modified < cutoff
      else { continue }
      try? FileManager.default.removeItem(at: file)
    }
  }

  private func fileURL(
    for descriptor: HermesChatAttachmentDescriptor,
    spaceID: String
  ) -> URL {
    let fingerprint = [
      descriptor.id,
      descriptor.contentType,
      String(descriptor.plaintextBytes),
      descriptor.nonce,
    ].joined(separator: "|")
    return profileDirectory(spaceID)
      .appendingPathComponent(Self.sha256(fingerprint))
      .appendingPathExtension("bin")
  }

  private func profileDirectory(_ spaceID: String) -> URL {
    root.appendingPathComponent(Self.sha256(spaceID.lowercased()), isDirectory: true)
  }

  private static func sha256(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
  }
}

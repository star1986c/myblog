import CryptoKit
import Foundation

/// Stores only the encrypted R2 object bytes. Decrypted images remain in memory.
public actor AttachmentDiskCache {
  private static let directoryName = "EncryptedAttachmentCache-v1"
  private static let maximumCiphertextBytes = AttachmentCrypto.maxPlaintextBytes + 16

  private let directory: URL
  private let fileManager: FileManager

  public init(directory: URL? = nil, fileManager: FileManager = .default) {
    self.fileManager = fileManager
    if let directory {
      self.directory = directory
    } else {
      let caches = fileManager.urls(for: .cachesDirectory, in: .userDomainMask).first
        ?? fileManager.temporaryDirectory
      self.directory = caches.appendingPathComponent(Self.directoryName, isDirectory: true)
    }
  }

  public func data(for envelope: EncryptedAttachmentEnvelope) -> Data? {
    guard isValidSize(envelope.ciphertextBytes) else { return nil }
    let url = fileURL(for: envelope)
    guard let data = try? Data(contentsOf: url, options: .mappedIfSafe),
      data.count == envelope.ciphertextBytes
    else {
      try? fileManager.removeItem(at: url)
      return nil
    }
    try? fileManager.setAttributes(
      [.modificationDate: Date()],
      ofItemAtPath: url.path
    )
    return data
  }

  public func store(_ data: Data, for envelope: EncryptedAttachmentEnvelope) {
    guard isValidSize(envelope.ciphertextBytes), data.count == envelope.ciphertextBytes else {
      remove(for: envelope)
      return
    }
    do {
      try createDirectoryIfNeeded()
      try data.write(to: fileURL(for: envelope), options: [.atomic])
    } catch {
      // Cache failures must never prevent an image from being displayed.
    }
  }

  public func remove(for envelope: EncryptedAttachmentEnvelope) {
    try? fileManager.removeItem(at: fileURL(for: envelope))
  }

  public func removeAll(noteID: String) {
    guard let files = try? fileManager.contentsOfDirectory(
      at: directory,
      includingPropertiesForKeys: nil
    ) else { return }
    let prefix = notePrefix(noteID)
    for file in files where file.lastPathComponent.hasPrefix(prefix) {
      try? fileManager.removeItem(at: file)
    }
  }

  public func retain(_ envelopes: [EncryptedAttachmentEnvelope], noteID: String) {
    guard let files = try? fileManager.contentsOfDirectory(
      at: directory,
      includingPropertiesForKeys: nil
    ) else { return }
    let prefix = notePrefix(noteID)
    let retained = Set(envelopes.map { fileURL(for: $0).lastPathComponent })
    for file in files
    where file.lastPathComponent.hasPrefix(prefix)
      && !retained.contains(file.lastPathComponent)
    {
      try? fileManager.removeItem(at: file)
    }
  }

  private func createDirectoryIfNeeded() throws {
    try fileManager.createDirectory(
      at: directory,
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700]
    )
  }

  private func fileURL(for envelope: EncryptedAttachmentEnvelope) -> URL {
    let fingerprint = [
      String(envelope.version),
      String(envelope.revision),
      envelope.ciphertext,
      envelope.nonce,
      String(envelope.ciphertextBytes),
      envelope.updatedAt ?? "",
    ].joined(separator: "|")
    let name = "\(notePrefix(envelope.noteId))\(hash(envelope.id))-\(hash(fingerprint)).bin"
    return directory.appendingPathComponent(name, isDirectory: false)
  }

  private func notePrefix(_ noteID: String) -> String {
    "\(hash(noteID))-"
  }

  private func hash(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
  }

  private func isValidSize(_ size: Int) -> Bool {
    size > 16 && size <= Self.maximumCiphertextBytes
  }
}

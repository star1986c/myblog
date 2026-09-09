import CryptoKit
import Foundation

public struct NotesSyncSnapshot: Codable, Sendable {
  var cursor = ""
  var notes: [String: EncryptedNoteEnvelope] = [:]
  var folders: [String: EncryptedFolderEnvelope] = [:]

  mutating func apply(_ page: NotesSyncPage) throws {
    guard page.version == 1, !page.cursor.isEmpty,
      !page.hasMore || page.cursor != cursor
    else { throw NotesAPIError.invalidResponse }
    if page.reset { notes.removeAll(); folders.removeAll() }
    for change in page.changes {
      switch change.kind {
      case "note":
        if change.deleted { notes.removeValue(forKey: change.id) }
        else if let note = change.note, note.id == change.id { notes[change.id] = note }
        else { throw NotesAPIError.invalidResponse }
      case "folder":
        if change.deleted { folders.removeValue(forKey: change.id) }
        else if let folder = change.folder, folder.id == change.id { folders[change.id] = folder }
        else { throw NotesAPIError.invalidResponse }
      default: throw NotesAPIError.invalidResponse
      }
    }
    cursor = page.cursor
  }
}

struct NotesSyncPage: Decodable, Sendable {
  let version: Int
  let reset: Bool
  let hasMore: Bool
  let cursor: String
  let changes: [Change]

  struct Change: Decodable, Sendable {
    let kind: String
    let id: String
    let deleted: Bool
    let note: EncryptedNoteEnvelope?
    let folder: EncryptedFolderEnvelope?
  }
}

/// Only encrypted server envelopes and their cursor are persisted. AES-GCM also
/// authenticates the complete snapshot, so corruption cannot silently skip data.
public struct NotesSyncCache: Sendable {
  private let directory: URL

  public init(directory: URL? = nil) {
    self.directory = directory ?? FileManager.default.urls(for: .applicationSupportDirectory,
      in: .userDomainMask)[0].appendingPathComponent("My Notes/NotesSync-v1", isDirectory: true)
  }

  func load(scope: String, key: SymmetricKey) -> NotesSyncSnapshot? {
    do {
      let bytes = try Data(contentsOf: fileURL(scope))
      let plaintext = try AES.GCM.open(AES.GCM.SealedBox(combined: bytes), using: key,
        authenticating: Data(scope.utf8))
      let snapshot = try JSONDecoder().decode(NotesSyncSnapshot.self, from: plaintext)
      guard !snapshot.cursor.isEmpty,
        snapshot.notes.allSatisfy({ $0.key == $0.value.id }),
        snapshot.folders.allSatisfy({ $0.key == $0.value.id }) else { return nil }
      return snapshot
    } catch { return nil }
  }

  func save(_ snapshot: NotesSyncSnapshot, scope: String, key: SymmetricKey) throws {
    guard !snapshot.cursor.isEmpty else { return }
    let plaintext = try JSONEncoder().encode(snapshot)
    let sealed = try AES.GCM.seal(plaintext, using: key, authenticating: Data(scope.utf8))
    guard let bytes = sealed.combined else { throw NotesAPIError.invalidResponse }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    try bytes.write(to: fileURL(scope), options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL(scope).path)
  }

  func clear(scope: String) { try? FileManager.default.removeItem(at: fileURL(scope)) }

  private func fileURL(_ scope: String) -> URL {
    let hash = SHA256.hash(data: Data(scope.utf8)).map { String(format: "%02x", $0) }.joined()
    return directory.appendingPathComponent(hash + ".bin")
  }
}

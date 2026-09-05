import Foundation
import Security

public protocol NotesDeviceTokenStoring: Sendable {
  func load() -> String?
  func save(_ token: String?) throws
}

/// Device credentials are local to this Mac and scoped to the server URL.
public struct NotesDeviceTokenKeychain: NotesDeviceTokenStoring {
  private let account: String

  public init(account: String) { self.account = account }

  private var query: [String: Any] {
    [kSecClass as String: kSecClassGenericPassword,
     kSecAttrService as String: "io.qzz.superstar1014.aibuildnotes.device-token",
     kSecAttrAccount as String: account]
  }

  public func load() -> String? {
    var query = query
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
      let data = result as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  public func save(_ token: String?) throws {
    guard let token, !token.isEmpty else {
      let status = SecItemDelete(query as CFDictionary)
      guard status == errSecSuccess || status == errSecItemNotFound else {
        throw HermesChatKeychainError.unexpectedStatus(status)
      }
      return
    }
    let attributes: [String: Any] = [
      kSecValueData as String: Data(token.utf8),
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if status == errSecItemNotFound {
      status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
    }
    guard status == errSecSuccess else {
      throw HermesChatKeychainError.unexpectedStatus(status)
    }
  }
}

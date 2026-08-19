import Foundation
import Security

public protocol HermesChatKeyStoring: Sendable {
  func loadKey(spaceID: String) -> String?
  func saveKey(_ key: String, spaceID: String) throws
  func removeKey(spaceID: String) throws
}
public enum HermesChatKeychainError: LocalizedError, Sendable {
  case unexpectedStatus(OSStatus)

  public var errorDescription: String? {
    switch self {
    case .unexpectedStatus(let status):
      "无法访问 macOS 钥匙串（错误 \(status)）。"
    }
  }
}

public final class HermesChatKeychain: HermesChatKeyStoring, @unchecked Sendable {
  private let service: String

  public init(service: String = "io.qzz.superstar1014.aibuildnotes.hermes-chat") {
    self.service = service
  }

  public func loadKey(spaceID: String) -> String? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: normalized(spaceID),
      kSecMatchLimit as String: kSecMatchLimitOne,
      kSecReturnData as String: true,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    guard status == errSecSuccess, let data = result as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  public func saveKey(_ key: String, spaceID: String) throws {
    _ = try HermesChatCrypto(encodedKey: key)
    let account = normalized(spaceID)
    let data = Data(key.trimmingCharacters(in: .whitespacesAndNewlines).utf8)
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    let attributes: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
    ]
    let update = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if update == errSecSuccess { return }
    guard update == errSecItemNotFound else {
      throw HermesChatKeychainError.unexpectedStatus(update)
    }
    var insert = query
    for (key, value) in attributes { insert[key] = value }
    let status = SecItemAdd(insert as CFDictionary, nil)
    guard status == errSecSuccess else {
      throw HermesChatKeychainError.unexpectedStatus(status)
    }
  }

  public func removeKey(spaceID: String) throws {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: normalized(spaceID),
    ]
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw HermesChatKeychainError.unexpectedStatus(status)
    }
  }

  private func normalized(_ value: String) -> String {
    value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  }
}

import Foundation

public enum CloudflareBillingError: LocalizedError, Equatable, Sendable {
  case invalidAccountID
  case missingToken
  case invalidResponse
  case decoding
  case notCovered
  case server(status: Int, message: String)

  public var errorDescription: String? {
    switch self {
    case .invalidAccountID:
      "Account ID 应为 32 位十六进制字符串。"
    case .missingToken:
      "请输入具有 Billing Read 权限的 Cloudflare API Token。"
    case .invalidResponse:
      "Cloudflare 返回了无效响应。"
    case .decoding:
      "无法读取 Cloudflare 账单响应；接口格式可能已经变化。"
    case .notCovered:
      "此账户暂未被 Cloudflare Pay-as-you-go 账单用量 API 覆盖。"
    case .server(_, let message):
      message
    }
  }
}

public protocol CloudflareBillingFetching: Sendable {
  func usageInfo(accountID: String, token: String) async throws -> CloudflareBillingUsageInfo
  func billableUsage(accountID: String, token: String) async throws
    -> [CloudflareBillableUsageRecord]
}

public actor CloudflareBillingClient: CloudflareBillingFetching {
  private let baseURL: URL
  private let session: URLSession

  public init(
    baseURL: URL = URL(string: "https://api.cloudflare.com/client/v4/")!,
    session: URLSession? = nil
  ) {
    self.baseURL = baseURL
    if let session {
      self.session = session
    } else {
      let configuration = URLSessionConfiguration.ephemeral
      configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
      configuration.urlCache = nil
      self.session = URLSession(configuration: configuration)
    }
  }

  public func usageInfo(accountID: String, token: String) async throws
    -> CloudflareBillingUsageInfo
  {
    try await request(
      path: "accounts/\(try validatedAccountID(accountID))/billable-usage/info",
      token: try validatedToken(token)
    )
  }

  public func billableUsage(accountID: String, token: String) async throws
    -> [CloudflareBillableUsageRecord]
  {
    try await request(
      path: "accounts/\(try validatedAccountID(accountID))/billable-usage",
      token: try validatedToken(token)
    )
  }

  private func request<Result: Decodable>(path: String, token: String) async throws -> Result {
    guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
      throw CloudflareBillingError.invalidResponse
    }
    var request = URLRequest(url: url)
    request.timeoutInterval = 30
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

    let (data, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse else {
      throw CloudflareBillingError.invalidResponse
    }
    let decoded = try? JSONDecoder().decode(CloudflareAPIEnvelope<Result>.self, from: data)
    guard (200..<300).contains(http.statusCode), decoded?.success == true else {
      let message = decoded?.errors.first?.message ?? Self.fallbackMessage(for: http.statusCode)
      throw CloudflareBillingError.server(status: http.statusCode, message: message)
    }
    guard let result = decoded?.result else { throw CloudflareBillingError.decoding }
    return result
  }

  private func validatedAccountID(_ value: String) throws -> String {
    let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard normalized.count == 32,
      normalized.unicodeScalars.allSatisfy({ CharacterSet(charactersIn: "0123456789abcdef").contains($0) })
    else { throw CloudflareBillingError.invalidAccountID }
    return normalized
  }

  private func validatedToken(_ value: String) throws -> String {
    let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalized.isEmpty else { throw CloudflareBillingError.missingToken }
    return normalized
  }

  private static func fallbackMessage(for status: Int) -> String {
    switch status {
    case 401, 403:
      "Cloudflare 拒绝访问。请确认 Token 具有该账户的 Billing Read 权限。"
    case 404:
      "Cloudflare 未为此账户开放账单用量 API。"
    case 429:
      "Cloudflare 请求过于频繁，请稍后再试。"
    default:
      "Cloudflare 请求失败（HTTP \(status)）。"
    }
  }
}

private struct CloudflareAPIEnvelope<Result: Decodable>: Decodable {
  let success: Bool
  let result: Result?
  let errors: [CloudflareAPIMessage]

  private enum CodingKeys: String, CodingKey { case success, result, errors }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    success = try container.decodeIfPresent(Bool.self, forKey: .success) ?? false
    result = try container.decodeIfPresent(Result.self, forKey: .result)
    errors = try container.decodeIfPresent([CloudflareAPIMessage].self, forKey: .errors) ?? []
  }
}

private struct CloudflareAPIMessage: Decodable {
  let message: String
}

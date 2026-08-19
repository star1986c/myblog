import Combine
import Foundation
import Security
import UserNotifications

public protocol CloudflareBillingTokenStoring: Sendable {
  func loadToken() -> String?
  func saveToken(_ token: String) throws
  func removeToken() throws
}

public final class CloudflareBillingKeychain: CloudflareBillingTokenStoring, @unchecked Sendable {
  private let service: String
  private let account = "cloudflare-billing-read-token"

  public init(service: String = "io.qzz.superstar1014.aibuildnotes.cloudflare-billing") {
    self.service = service
  }

  public func loadToken() -> String? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecMatchLimit as String: kSecMatchLimitOne,
      kSecReturnData as String: true,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    guard status == errSecSuccess, let data = result as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  public func saveToken(_ token: String) throws {
    let normalized = token.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalized.isEmpty else { throw CloudflareBillingError.missingToken }
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    let attributes: [String: Any] = [
      kSecValueData as String: Data(normalized.utf8),
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

  public func removeToken() throws {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw HermesChatKeychainError.unexpectedStatus(status)
    }
  }
}

public protocol CloudflareBillingNotifying: Sendable {
  func enableDailyReminder() async throws
  func disableDailyReminder() async
  func notifyBudgetReached(cost: Double, threshold: Double, currency: String, periodKey: String)
    async throws
}

public final class CloudflareBillingNotificationCenter: CloudflareBillingNotifying,
  @unchecked Sendable
{
  private let center = UNUserNotificationCenter.current()
  private let dailyIdentifier = "cloudflare-billing-daily-reminder"

  public init() {}

  public func enableDailyReminder() async throws {
    let granted = try await center.requestAuthorization(options: [.alert, .sound])
    guard granted else {
      throw CloudflareBillingError.server(
        status: 0,
        message: "未获得 macOS 通知权限；可以继续查看报表，但不会发送提醒。"
      )
    }
    let content = UNMutableNotificationContent()
    content.title = "Cloudflare 用量日报"
    content.body = "打开 My Notes 查看本账期费用和各产品用量。"
    content.sound = .default
    var date = DateComponents()
    date.hour = 9
    let trigger = UNCalendarNotificationTrigger(dateMatching: date, repeats: true)
    try await center.add(
      UNNotificationRequest(identifier: dailyIdentifier, content: content, trigger: trigger)
    )
  }

  public func disableDailyReminder() async {
    center.removePendingNotificationRequests(withIdentifiers: [dailyIdentifier])
  }

  public func notifyBudgetReached(
    cost: Double,
    threshold: Double,
    currency: String,
    periodKey: String
  ) async throws {
    let content = UNMutableNotificationContent()
    content.title = "Cloudflare 预算提醒"
    content.body = String(
      format: "本账期用量费用 %.2f %@，已达到 %.2f %@ 的提醒阈值。",
      cost,
      currency,
      threshold,
      currency
    )
    content.sound = .default
    let safePeriod = periodKey.replacingOccurrences(of: ":", with: "-")
    try await center.add(
      UNNotificationRequest(
        identifier: "cloudflare-billing-budget-\(safePeriod)",
        content: content,
        trigger: UNTimeIntervalNotificationTrigger(timeInterval: 1, repeats: false)
      )
    )
  }
}

@MainActor
public final class CloudflareBillingStore: ObservableObject {
  @Published public private(set) var accountID: String
  @Published public private(set) var budgetThreshold: Double
  @Published public private(set) var remindersEnabled: Bool
  @Published public private(set) var hasToken: Bool
  @Published public private(set) var report: CloudflareBillingReport?
  @Published public private(set) var lastUpdated: Date?
  @Published public private(set) var isRefreshing = false
  @Published public private(set) var errorMessage: String?

  private let fetcher: any CloudflareBillingFetching
  private let tokenStore: any CloudflareBillingTokenStoring
  private let notifier: any CloudflareBillingNotifying
  private let defaults: UserDefaults
  private let previewsOnly: Bool

  private enum Keys {
    static let accountID = "cloudflare_billing_account_id_v1"
    static let threshold = "cloudflare_billing_budget_threshold_v1"
    static let reminders = "cloudflare_billing_reminders_v1"
    static let lastAlertedPeriod = "cloudflare_billing_last_alerted_period_v1"
  }

  public init(
    fetcher: any CloudflareBillingFetching = CloudflareBillingClient(),
    tokenStore: any CloudflareBillingTokenStoring = CloudflareBillingKeychain(),
    notifier: any CloudflareBillingNotifying = CloudflareBillingNotificationCenter(),
    defaults: UserDefaults = .standard,
    previewsOnly: Bool = false
  ) {
    self.fetcher = fetcher
    self.tokenStore = tokenStore
    self.notifier = notifier
    self.defaults = defaults
    self.previewsOnly = previewsOnly
    accountID = defaults.string(forKey: Keys.accountID) ?? ""
    let storedThreshold = defaults.double(forKey: Keys.threshold)
    budgetThreshold = storedThreshold > 0 ? storedThreshold : 10
    remindersEnabled = defaults.bool(forKey: Keys.reminders)
    hasToken = tokenStore.loadToken() != nil
  }

  #if DEBUG
    public static func preview() -> CloudflareBillingStore {
      let suite = UserDefaults(suiteName: "cloudflare-billing-preview-\(UUID().uuidString)") ?? .standard
      let store = CloudflareBillingStore(
        fetcher: PreviewCloudflareBillingFetcher(),
        tokenStore: PreviewCloudflareBillingTokenStore(),
        notifier: PreviewCloudflareBillingNotifier(),
        defaults: suite,
        previewsOnly: true
      )
      store.accountID = "0123456789abcdef0123456789abcdef"
      store.hasToken = true
      store.report = CloudflareBillingReport(records: PreviewCloudflareBillingFetcher.records)
      store.lastUpdated = Date()
      return store
    }
  #endif

  public var isConfigured: Bool { !accountID.isEmpty && hasToken }

  public func start() async {
    guard !previewsOnly, isConfigured else { return }
    await refresh()
  }

  public func refreshIfNeeded() async {
    guard isConfigured, !previewsOnly else { return }
    if let lastUpdated, Date().timeIntervalSince(lastUpdated) < 6 * 60 * 60 { return }
    await refresh()
  }

  public func refresh() async {
    guard !isRefreshing else { return }
    guard let token = tokenStore.loadToken(), !accountID.isEmpty else {
      errorMessage = CloudflareBillingError.missingToken.localizedDescription
      return
    }
    isRefreshing = true
    errorMessage = nil
    defer { isRefreshing = false }
    do {
      let info = try await fetcher.usageInfo(accountID: accountID, token: token)
      guard info.covered else { throw CloudflareBillingError.notCovered }
      let records = try await fetcher.billableUsage(accountID: accountID, token: token)
      let nextReport = CloudflareBillingReport(records: records)
      report = nextReport
      lastUpdated = Date()
      try await issueBudgetAlertIfNeeded(for: nextReport)
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  @discardableResult
  public func configure(
    accountID newAccountID: String,
    token newToken: String,
    budgetThreshold newThreshold: Double,
    remindersEnabled newRemindersEnabled: Bool
  ) async -> Bool {
    guard !isRefreshing else { return false }
    let normalizedID = newAccountID.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let providedToken = newToken.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let effectiveToken = providedToken.isEmpty ? tokenStore.loadToken() : providedToken else {
      errorMessage = CloudflareBillingError.missingToken.localizedDescription
      return false
    }
    guard newThreshold > 0 else {
      errorMessage = "预算提醒阈值必须大于 0。"
      return false
    }

    isRefreshing = true
    errorMessage = nil
    defer { isRefreshing = false }
    do {
      let info = try await fetcher.usageInfo(accountID: normalizedID, token: effectiveToken)
      guard info.covered else { throw CloudflareBillingError.notCovered }
      let records = try await fetcher.billableUsage(accountID: normalizedID, token: effectiveToken)
      if !providedToken.isEmpty { try tokenStore.saveToken(providedToken) }
      accountID = normalizedID
      budgetThreshold = newThreshold
      remindersEnabled = newRemindersEnabled
      hasToken = true
      defaults.set(accountID, forKey: Keys.accountID)
      defaults.set(budgetThreshold, forKey: Keys.threshold)
      defaults.set(remindersEnabled, forKey: Keys.reminders)
      let nextReport = CloudflareBillingReport(records: records)
      report = nextReport
      lastUpdated = Date()
      if remindersEnabled {
        do {
          try await notifier.enableDailyReminder()
          try await issueBudgetAlertIfNeeded(for: nextReport)
        } catch {
          remindersEnabled = false
          defaults.set(false, forKey: Keys.reminders)
          errorMessage = error.localizedDescription
        }
      } else {
        await notifier.disableDailyReminder()
      }
      return true
    } catch {
      errorMessage = error.localizedDescription
      return false
    }
  }

  public func removeConfiguration() async {
    do {
      try tokenStore.removeToken()
      await notifier.disableDailyReminder()
      defaults.removeObject(forKey: Keys.accountID)
      defaults.removeObject(forKey: Keys.threshold)
      defaults.removeObject(forKey: Keys.reminders)
      defaults.removeObject(forKey: Keys.lastAlertedPeriod)
      accountID = ""
      budgetThreshold = 10
      remindersEnabled = false
      hasToken = false
      report = nil
      lastUpdated = nil
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  public func clearError() { errorMessage = nil }

  private func issueBudgetAlertIfNeeded(for report: CloudflareBillingReport) async throws {
    guard remindersEnabled, report.totalCost >= budgetThreshold else { return }
    let periodKey = report.periodStart.map { String(Int($0.timeIntervalSince1970)) } ?? "current"
    guard defaults.string(forKey: Keys.lastAlertedPeriod) != periodKey else { return }
    try await notifier.notifyBudgetReached(
      cost: report.totalCost,
      threshold: budgetThreshold,
      currency: report.currency,
      periodKey: periodKey
    )
    defaults.set(periodKey, forKey: Keys.lastAlertedPeriod)
  }
}

#if DEBUG
  private struct PreviewCloudflareBillingTokenStore: CloudflareBillingTokenStoring {
    func loadToken() -> String? { "preview-token" }
    func saveToken(_ token: String) throws {}
    func removeToken() throws {}
  }

  private struct PreviewCloudflareBillingNotifier: CloudflareBillingNotifying {
    func enableDailyReminder() async throws {}
    func disableDailyReminder() async {}
    func notifyBudgetReached(cost: Double, threshold: Double, currency: String, periodKey: String)
      async throws
    {}
  }

  private struct PreviewCloudflareBillingFetcher: CloudflareBillingFetching {
    static let records = [
      CloudflareBillableUsageRecord(
        billingAccountName: "Superstar Blog",
        billingCurrency: "USD",
        billingPeriodStart: "2026-08-01T00:00:00Z",
        chargeDescription: "Workers requests",
        chargePeriodEnd: "2026-08-19T00:00:00Z",
        chargePeriodStart: "2026-08-18T00:00:00Z",
        consumedQuantity: 4_280_000,
        consumedUnit: "Requests",
        contractedCost: 2.14,
        serviceName: "Workers Standard Requests",
        serviceFamilyName: "Workers"
      ),
      CloudflareBillableUsageRecord(
        billingAccountName: "Superstar Blog",
        billingCurrency: "USD",
        billingPeriodStart: "2026-08-01T00:00:00Z",
        chargeDescription: "R2 storage",
        chargePeriodEnd: "2026-08-19T00:00:00Z",
        chargePeriodStart: "2026-08-18T00:00:00Z",
        consumedQuantity: 7.4,
        consumedUnit: "GB-months",
        contractedCost: 0,
        serviceName: "R2 Standard Storage",
        serviceFamilyName: "R2"
      ),
      CloudflareBillableUsageRecord(
        billingAccountName: "Superstar Blog",
        billingCurrency: "USD",
        billingPeriodStart: "2026-08-01T00:00:00Z",
        chargeDescription: "D1 rows read",
        chargePeriodEnd: "2026-08-19T00:00:00Z",
        chargePeriodStart: "2026-08-18T00:00:00Z",
        consumedQuantity: 8_900_000,
        consumedUnit: "Rows",
        contractedCost: 0,
        serviceName: "D1 Rows Read",
        serviceFamilyName: "D1"
      ),
    ]

    func usageInfo(accountID: String, token: String) async throws -> CloudflareBillingUsageInfo {
      CloudflareBillingUsageInfo(covered: true, subscriptions: [])
    }

    func billableUsage(accountID: String, token: String) async throws
      -> [CloudflareBillableUsageRecord]
    {
      Self.records
    }
  }
#endif

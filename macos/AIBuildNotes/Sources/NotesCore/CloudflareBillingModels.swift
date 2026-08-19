import Foundation

public struct CloudflareBillingSubscription: Codable, Equatable, Sendable {
  public let id: String
  public let billingCycleAnchorTimestamp: String
  public let startTimestamp: String
  public let endTimestamp: String?

  public init(
    id: String,
    billingCycleAnchorTimestamp: String,
    startTimestamp: String,
    endTimestamp: String? = nil
  ) {
    self.id = id
    self.billingCycleAnchorTimestamp = billingCycleAnchorTimestamp
    self.startTimestamp = startTimestamp
    self.endTimestamp = endTimestamp
  }

  private enum CodingKeys: String, CodingKey {
    case id
    case billingCycleAnchorTimestamp = "billing_cycle_anchor_timestamp"
    case startTimestamp = "start_timestamp"
    case endTimestamp = "end_timestamp"
  }
}

public struct CloudflareBillingUsageInfo: Codable, Equatable, Sendable {
  public let covered: Bool
  public let subscriptions: [CloudflareBillingSubscription]

  public init(covered: Bool, subscriptions: [CloudflareBillingSubscription]) {
    self.covered = covered
    self.subscriptions = subscriptions
  }
}

public struct CloudflareBillableUsageRecord: Codable, Equatable, Sendable {
  public let billedCost: Double?
  public let billingAccountName: String?
  public let billingCurrency: String?
  public let billingPeriodStart: String?
  public let chargeDescription: String
  public let chargePeriodEnd: String
  public let chargePeriodStart: String
  public let consumedQuantity: Double
  public let consumedUnit: String
  public let contractedCost: Double?
  public let cumulativeContractedCost: Double?
  public let pricingQuantity: Double?
  public let pricingUnit: String?
  public let serviceName: String
  public let serviceFamilyName: String?
  public let zoneName: String?

  public init(
    billedCost: Double? = nil,
    billingAccountName: String? = nil,
    billingCurrency: String? = nil,
    billingPeriodStart: String? = nil,
    chargeDescription: String,
    chargePeriodEnd: String,
    chargePeriodStart: String,
    consumedQuantity: Double,
    consumedUnit: String,
    contractedCost: Double? = nil,
    cumulativeContractedCost: Double? = nil,
    pricingQuantity: Double? = nil,
    pricingUnit: String? = nil,
    serviceName: String,
    serviceFamilyName: String? = nil,
    zoneName: String? = nil
  ) {
    self.billedCost = billedCost
    self.billingAccountName = billingAccountName
    self.billingCurrency = billingCurrency
    self.billingPeriodStart = billingPeriodStart
    self.chargeDescription = chargeDescription
    self.chargePeriodEnd = chargePeriodEnd
    self.chargePeriodStart = chargePeriodStart
    self.consumedQuantity = consumedQuantity
    self.consumedUnit = consumedUnit
    self.contractedCost = contractedCost
    self.cumulativeContractedCost = cumulativeContractedCost
    self.pricingQuantity = pricingQuantity
    self.pricingUnit = pricingUnit
    self.serviceName = serviceName
    self.serviceFamilyName = serviceFamilyName
    self.zoneName = zoneName
  }

  private enum CodingKeys: String, CodingKey {
    case billedCost = "BilledCost"
    case billingAccountName = "BillingAccountName"
    case billingCurrency = "BillingCurrency"
    case billingPeriodStart = "BillingPeriodStart"
    case chargeDescription = "ChargeDescription"
    case chargePeriodEnd = "ChargePeriodEnd"
    case chargePeriodStart = "ChargePeriodStart"
    case consumedQuantity = "ConsumedQuantity"
    case consumedUnit = "ConsumedUnit"
    case contractedCost = "ContractedCost"
    case cumulativeContractedCost = "CumulatedContractedCost"
    case pricingQuantity = "PricingQuantity"
    case pricingUnit = "PricingUnit"
    case serviceName = "ServiceName"
    case serviceFamilyName = "ServiceFamilyName"
    case zoneName = "ZoneName"
  }

  public var effectiveCost: Double { contractedCost ?? billedCost ?? 0 }
}

public struct CloudflareUsageMetric: Equatable, Identifiable, Sendable {
  public let name: String
  public let quantity: Double
  public let unit: String

  public init(name: String, quantity: Double, unit: String) {
    self.name = name
    self.quantity = quantity
    self.unit = unit
  }

  public var id: String { "\(name)|\(unit)" }
}

public struct CloudflareProductUsage: Equatable, Identifiable, Sendable {
  public let name: String
  public let cost: Double
  public let metrics: [CloudflareUsageMetric]

  public init(name: String, cost: Double, metrics: [CloudflareUsageMetric]) {
    self.name = name
    self.cost = cost
    self.metrics = metrics
  }

  public var id: String { name }
}

public struct CloudflareBillingReport: Equatable, Sendable {
  public let accountName: String
  public let currency: String
  public let periodStart: Date?
  public let periodEnd: Date?
  public let totalCost: Double
  public let products: [CloudflareProductUsage]
  public let recordCount: Int

  public init(records: [CloudflareBillableUsageRecord]) {
    accountName = records.compactMap(\.billingAccountName).first ?? "Cloudflare 账户"
    currency = records.compactMap(\.billingCurrency).first ?? "USD"
    periodStart = records.compactMap { Self.parseDate($0.billingPeriodStart) }.min()
      ?? records.compactMap { Self.parseDate($0.chargePeriodStart) }.min()
    periodEnd = records.compactMap { Self.parseDate($0.chargePeriodEnd) }.max()
    totalCost = records.reduce(0) { $0 + $1.effectiveCost }
    recordCount = records.count

    let grouped = Dictionary(grouping: records) { record in
      let family = record.serviceFamilyName?.trimmingCharacters(in: .whitespacesAndNewlines)
      return family?.isEmpty == false ? family! : record.serviceName
    }
    products = grouped.map { productName, productRecords in
      let metricGroups = Dictionary(grouping: productRecords) { record in
        let unit = record.consumedUnit.isEmpty ? (record.pricingUnit ?? "Count") : record.consumedUnit
        return "\(record.serviceName)|\(unit)"
      }
      let metrics = metricGroups.map { _, metricRecords in
        let first = metricRecords[0]
        let unit = first.consumedUnit.isEmpty ? (first.pricingUnit ?? "Count") : first.consumedUnit
        return CloudflareUsageMetric(
          name: first.serviceName,
          quantity: metricRecords.reduce(0) { $0 + $1.consumedQuantity },
          unit: unit
        )
      }
      .sorted { lhs, rhs in
        if lhs.name == rhs.name { return lhs.unit < rhs.unit }
        return lhs.name < rhs.name
      }
      return CloudflareProductUsage(
        name: productName,
        cost: productRecords.reduce(0) { $0 + $1.effectiveCost },
        metrics: metrics
      )
    }
    .sorted { lhs, rhs in
      if lhs.cost == rhs.cost { return lhs.name < rhs.name }
      return lhs.cost > rhs.cost
    }
  }

  private static func parseDate(_ value: String?) -> Date? {
    guard let value else { return nil }
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
  }
}

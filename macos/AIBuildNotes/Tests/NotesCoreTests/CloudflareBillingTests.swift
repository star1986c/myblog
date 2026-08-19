import Foundation
import Testing

@testable import NotesCore

@Suite("Cloudflare billing report", .serialized)
struct CloudflareBillingTests {
  @Test("Billing API uses a bearer token and decodes PayGo usage")
  func fetchesBillableUsage() async throws {
    CloudflareBillingURLProtocol.requests = []
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [CloudflareBillingURLProtocol.self]
    let client = CloudflareBillingClient(
      baseURL: URL(string: "https://api.cloudflare.test/client/v4/")!,
      session: URLSession(configuration: configuration)
    )
    let accountID = "0123456789abcdef0123456789abcdef"

    let info = try await client.usageInfo(accountID: accountID, token: "read-only-token")
    let records = try await client.billableUsage(accountID: accountID, token: "read-only-token")

    #expect(info.covered)
    #expect(info.subscriptions.first?.id == "subscription-1")
    #expect(records.count == 3)
    #expect(records.first?.serviceFamilyName == "Workers")
    #expect(records.first?.contractedCost == 0.5)
    #expect(CloudflareBillingURLProtocol.requests.count == 2)
    #expect(
      CloudflareBillingURLProtocol.requests.allSatisfy {
        $0.value(forHTTPHeaderField: "Authorization") == "Bearer read-only-token"
      }
    )
  }

  @Test("Report aggregates daily metrics by product without using cumulative cost twice")
  func aggregatesProductUsage() throws {
    let data = try #require(CloudflareBillingURLProtocol.usageData())
    let envelope = try JSONDecoder().decode(TestUsageEnvelope.self, from: data)
    let report = CloudflareBillingReport(records: envelope.result)

    #expect(report.accountName == "Example Account")
    #expect(report.currency == "USD")
    #expect(report.totalCost == 0.75)
    #expect(report.products.map(\.name) == ["Workers", "R2"])
    let workers = try #require(report.products.first)
    #expect(workers.metrics.first?.quantity == 300_000)
    #expect(workers.metrics.first?.unit == "Requests")
  }

  @Test("Client rejects malformed account ids before sending a request")
  func rejectsMalformedAccountID() async {
    let client = CloudflareBillingClient(
      baseURL: URL(string: "https://api.cloudflare.test/client/v4/")!
    )
    await #expect(throws: CloudflareBillingError.invalidAccountID) {
      _ = try await client.usageInfo(accountID: "not-an-account", token: "token")
    }
  }
}

private struct TestUsageEnvelope: Decodable {
  let result: [CloudflareBillableUsageRecord]
}

private final class CloudflareBillingURLProtocol: URLProtocol, @unchecked Sendable {
  nonisolated(unsafe) static var requests: [URLRequest] = []

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    guard let url = request.url else {
      client?.urlProtocol(self, didFailWithError: URLError(.badURL))
      return
    }
    Self.requests.append(request)
    do {
      let data: Data
      switch url.path {
      case "/client/v4/accounts/0123456789abcdef0123456789abcdef/billable-usage/info":
        data = try JSONSerialization.data(withJSONObject: [
          "success": true,
          "errors": [],
          "result": [
            "covered": true,
            "subscriptions": [
              [
                "id": "subscription-1",
                "billing_cycle_anchor_timestamp": "2026-08-01T00:00:00Z",
                "start_timestamp": "2026-08-01T00:00:00Z",
              ]
            ],
          ],
        ])
      case "/client/v4/accounts/0123456789abcdef0123456789abcdef/billable-usage":
        data = try #require(Self.usageData())
      default:
        throw URLError(.unsupportedURL)
      }
      let response = HTTPURLResponse(
        url: url,
        statusCode: 200,
        httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"]
      )!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: data)
      client?.urlProtocolDidFinishLoading(self)
    } catch {
      client?.urlProtocol(self, didFailWithError: error)
    }
  }

  override func stopLoading() {}

  static func usageData() -> Data? {
    try? JSONSerialization.data(withJSONObject: [
      "success": true,
      "errors": [],
      "result": [
        [
          "BilledCost": 0.5,
          "BillingAccountName": "Example Account",
          "BillingCurrency": "USD",
          "BillingPeriodStart": "2026-08-01T00:00:00Z",
          "ChargeDescription": "Workers Standard requests",
          "ChargePeriodEnd": "2026-08-02T00:00:00Z",
          "ChargePeriodStart": "2026-08-01T00:00:00Z",
          "ConsumedQuantity": 150_000,
          "ConsumedUnit": "Requests",
          "ContractedCost": 0.5,
          "CumulatedContractedCost": 0.5,
          "PricingQuantity": 150_000,
          "PricingUnit": "Requests",
          "ServiceName": "Workers Standard Requests",
          "ServiceFamilyName": "Workers",
        ],
        [
          "BilledCost": 0.25,
          "BillingAccountName": "Example Account",
          "BillingCurrency": "USD",
          "BillingPeriodStart": "2026-08-01T00:00:00Z",
          "ChargeDescription": "Workers Standard requests",
          "ChargePeriodEnd": "2026-08-03T00:00:00Z",
          "ChargePeriodStart": "2026-08-02T00:00:00Z",
          "ConsumedQuantity": 150_000,
          "ConsumedUnit": "Requests",
          "ContractedCost": 0.25,
          "CumulatedContractedCost": 0.75,
          "PricingQuantity": 150_000,
          "PricingUnit": "Requests",
          "ServiceName": "Workers Standard Requests",
          "ServiceFamilyName": "Workers",
        ],
        [
          "BilledCost": 0,
          "BillingAccountName": "Example Account",
          "BillingCurrency": "USD",
          "BillingPeriodStart": "2026-08-01T00:00:00Z",
          "ChargeDescription": "R2 storage",
          "ChargePeriodEnd": "2026-08-03T00:00:00Z",
          "ChargePeriodStart": "2026-08-02T00:00:00Z",
          "ConsumedQuantity": 2.5,
          "ConsumedUnit": "GB-months",
          "ContractedCost": 0,
          "CumulatedContractedCost": 0,
          "PricingQuantity": 2.5,
          "PricingUnit": "GB-months",
          "ServiceName": "R2 Standard Storage",
          "ServiceFamilyName": "R2",
        ],
      ],
    ])
  }
}

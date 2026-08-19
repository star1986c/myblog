import NotesCore
import SwiftUI

struct CloudflareBillingView: View {
  @EnvironmentObject private var store: CloudflareBillingStore
  @State private var showsSettings = false

  var body: some View {
    Group {
      if !store.isConfigured {
        ContentUnavailableView {
          Label("配置 Cloudflare 报表", systemImage: "chart.bar.xaxis")
        } description: {
          Text("使用只读 API Token 查看本账期费用和各产品用量。")
        } actions: {
          Button("开始配置") { showsSettings = true }
            .buttonStyle(.borderedProminent)
        }
      } else if let report = store.report {
        reportView(report)
      } else if store.isRefreshing {
        ProgressView("正在读取 Cloudflare 账单用量…")
          .controlSize(.large)
      } else {
        ContentUnavailableView(
          "尚无报表数据",
          systemImage: "chart.bar.xaxis",
          description: Text("刷新后会显示当前账期的费用和产品用量。")
        )
      }
    }
    .background(Color(nsColor: .windowBackgroundColor))
    .toolbar {
      ToolbarItemGroup {
        Button {
          Task { await store.refresh() }
        } label: {
          Label("刷新", systemImage: "arrow.clockwise")
        }
        .disabled(!store.isConfigured || store.isRefreshing)

        Button {
          showsSettings = true
        } label: {
          Label("报表设置", systemImage: "gearshape")
        }
      }
    }
    .sheet(isPresented: $showsSettings) {
      CloudflareBillingSettingsSheet()
        .environmentObject(store)
    }
  }

  private func reportView(_ report: CloudflareBillingReport) -> some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        reportHeader(report)
        summaryCards(report)

        VStack(alignment: .leading, spacing: 12) {
          HStack(alignment: .firstTextBaseline) {
            Text("产品用量").font(.title2.bold())
            Spacer()
            Text("\(report.recordCount) 条日用量记录")
              .font(.caption)
              .foregroundStyle(.secondary)
          }

          if report.products.isEmpty {
            ContentUnavailableView(
              "本账期暂无计量用量",
              systemImage: "checkmark.circle",
              description: Text("Cloudflare 返回了空的用量记录。")
            )
            .frame(minHeight: 220)
          } else {
            LazyVGrid(
              columns: [GridItem(.adaptive(minimum: 270, maximum: 420), spacing: 14)],
              spacing: 14
            ) {
              ForEach(report.products) { product in
                productCard(product, currency: report.currency)
              }
            }
          }
        }

        Label(
          "Cloudflare 的统一账单 API 返回已用量和费用，不返回跨产品统一的剩余额度。费用为当前用量记录汇总，最终以月度发票为准。",
          systemImage: "info.circle"
        )
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 12))
      }
      .padding(24)
      .frame(maxWidth: 1120, alignment: .leading)
      .frame(maxWidth: .infinity)
    }
  }

  private func reportHeader(_ report: CloudflareBillingReport) -> some View {
    HStack(alignment: .top, spacing: 16) {
      Image(systemName: "cloud.fill")
        .font(.system(size: 28, weight: .semibold))
        .foregroundStyle(.white)
        .frame(width: 58, height: 58)
        .background(Color.orange.gradient, in: RoundedRectangle(cornerRadius: 16))
      VStack(alignment: .leading, spacing: 5) {
        Text("Cloudflare 报表")
          .font(.largeTitle.bold())
        Text(report.accountName)
          .foregroundStyle(.secondary)
        if let start = report.periodStart, let end = report.periodEnd {
          Text("账期用量：\(start.formatted(date: .abbreviated, time: .omitted)) – \(end.formatted(date: .abbreviated, time: .omitted))")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }
      Spacer()
      if store.isRefreshing { ProgressView().controlSize(.small) }
      if let lastUpdated = store.lastUpdated {
        Text("更新于 \(lastUpdated.formatted(date: .omitted, time: .shortened))")
          .font(.caption)
          .foregroundStyle(.tertiary)
      }
    }
  }

  private func summaryCards(_ report: CloudflareBillingReport) -> some View {
    LazyVGrid(
      columns: [GridItem(.adaptive(minimum: 220, maximum: 360), spacing: 14)],
      spacing: 14
    ) {
      summaryCard(
        title: "本账期用量费用",
        value: money(report.totalCost, currency: report.currency),
        detail: "Cloudflare Billable Usage",
        systemImage: "dollarsign.circle.fill",
        tint: report.totalCost >= store.budgetThreshold ? .red : .orange
      )

      VStack(alignment: .leading, spacing: 11) {
        Label("预算提醒", systemImage: "bell.badge.fill")
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(Color.accentColor)
        Text(money(store.budgetThreshold, currency: report.currency))
          .font(.title2.bold())
        ProgressView(value: min(report.totalCost / max(store.budgetThreshold, 0.01), 1))
          .tint(report.totalCost >= store.budgetThreshold ? .red : Color.accentColor)
        Text(store.remindersEnabled ? "每日 09:00 提醒；达到阈值后再提醒一次" : "本机提醒已关闭")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      .padding(16)
      .frame(maxWidth: .infinity, minHeight: 132, alignment: .topLeading)
      .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 14))

      summaryCard(
        title: "计量产品",
        value: "\(report.products.count)",
        detail: "Workers、R2、D1 等",
        systemImage: "square.grid.2x2.fill",
        tint: .blue
      )
    }
  }

  private func summaryCard(
    title: String,
    value: String,
    detail: String,
    systemImage: String,
    tint: Color
  ) -> some View {
    VStack(alignment: .leading, spacing: 11) {
      Label(title, systemImage: systemImage)
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(tint)
      Text(value).font(.title2.bold())
      Text(detail)
        .font(.caption)
        .foregroundStyle(.secondary)
    }
    .padding(16)
    .frame(maxWidth: .infinity, minHeight: 132, alignment: .topLeading)
    .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 14))
  }

  private func productCard(_ product: CloudflareProductUsage, currency: String) -> some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(alignment: .firstTextBaseline) {
        Label(product.name, systemImage: icon(for: product.name))
          .font(.headline)
        Spacer(minLength: 8)
        Text(money(product.cost, currency: currency))
          .font(.headline.monospacedDigit())
          .foregroundStyle(product.cost > 0 ? .primary : .secondary)
      }
      Divider()
      ForEach(product.metrics.prefix(4)) { metric in
        HStack(alignment: .firstTextBaseline) {
          Text(metric.name)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .lineLimit(2)
          Spacer(minLength: 12)
          Text("\(number(metric.quantity)) \(metric.unit)")
            .font(.subheadline.monospacedDigit())
            .multilineTextAlignment(.trailing)
        }
      }
      if product.metrics.count > 4 {
        Text("另有 \(product.metrics.count - 4) 项指标")
          .font(.caption)
          .foregroundStyle(.tertiary)
      }
    }
    .padding(16)
    .frame(maxWidth: .infinity, minHeight: 150, alignment: .topLeading)
    .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 14))
    .overlay {
      RoundedRectangle(cornerRadius: 14)
        .stroke(Color(nsColor: .separatorColor), lineWidth: 1)
    }
  }

  private func money(_ value: Double, currency: String) -> String {
    value.formatted(.currency(code: currency).precision(.fractionLength(2)))
  }

  private func number(_ value: Double) -> String {
    value.formatted(.number.notation(.compactName).precision(.fractionLength(0...2)))
  }

  private func icon(for name: String) -> String {
    let normalized = name.lowercased()
    if normalized.contains("worker") { return "bolt.horizontal.circle" }
    if normalized.contains("r2") { return "externaldrive" }
    if normalized.contains("d1") { return "cylinder" }
    if normalized.contains("ai") { return "brain" }
    return "chart.bar"
  }
}

private struct CloudflareBillingSettingsSheet: View {
  @EnvironmentObject private var store: CloudflareBillingStore
  @Environment(\.dismiss) private var dismiss
  @State private var accountID = ""
  @State private var token = ""
  @State private var threshold = 10.0
  @State private var remindersEnabled = false
  @State private var confirmsRemoval = false

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      HStack(spacing: 12) {
        Image(systemName: "cloud.fill")
          .font(.title2)
          .foregroundStyle(.white)
          .frame(width: 44, height: 44)
          .background(Color.orange.gradient, in: RoundedRectangle(cornerRadius: 12))
        VStack(alignment: .leading, spacing: 3) {
          Text("Cloudflare 报表设置").font(.title3.bold())
          Text("Token 只保存在 macOS 钥匙串")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }

      Form {
        TextField("Account ID", text: $accountID)
          .textContentType(.none)
        SecureField(
          store.hasToken ? "API Token（留空则继续使用已保存 Token）" : "API Token（Billing Read）",
          text: $token
        )
        TextField(
          "预算提醒（USD）",
          value: $threshold,
          format: .number.precision(.fractionLength(0...2))
        )
        Toggle("开启本机每日与预算提醒", isOn: $remindersEnabled)
      }
      .formStyle(.grouped)

      VStack(alignment: .leading, spacing: 7) {
        Label("Token 建议只授予 Account → Billing Read，并限制到这个账户。", systemImage: "lock.shield")
        Label("接口目前为 Alpha，且只覆盖符合条件的 Pay-as-you-go 账户。", systemImage: "exclamationmark.triangle")
        Label("每日提醒固定在 09:00；预算提醒会在 App 刷新并发现越线时发送。", systemImage: "clock")
      }
      .font(.caption)
      .foregroundStyle(.secondary)

      HStack {
        if store.isConfigured {
          Button("移除配置", role: .destructive) {
            confirmsRemoval = true
          }
        }
        Spacer()
        Button("取消") { dismiss() }
        Button(store.isRefreshing ? "正在验证…" : "保存并验证") {
          save()
        }
        .buttonStyle(.borderedProminent)
        .disabled(
          store.isRefreshing
            || accountID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || threshold <= 0
        )
      }
    }
    .padding(24)
    .frame(width: 520)
    .onAppear {
      accountID = store.accountID
      threshold = store.budgetThreshold
      remindersEnabled = store.remindersEnabled
    }
    .confirmationDialog(
      "移除 Cloudflare 报表配置？",
      isPresented: $confirmsRemoval
    ) {
      Button("移除配置", role: .destructive) {
        Task {
          await store.removeConfiguration()
          dismiss()
        }
      }
      Button("取消", role: .cancel) {}
    } message: {
      Text("Account ID、本机提醒设置和钥匙串中的只读 Token 都会移除。")
    }
  }

  private func save() {
    Task {
      if await store.configure(
        accountID: accountID,
        token: token,
        budgetThreshold: threshold,
        remindersEnabled: remindersEnabled
      ) {
        token = ""
        dismiss()
      }
    }
  }
}

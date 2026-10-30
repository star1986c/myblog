import SwiftUI
import NotesCore

struct SettingsView: View {
  @EnvironmentObject private var model: MobileModel
  @EnvironmentObject private var notes: NotesStore
  @EnvironmentObject private var chat: HermesChatStore
  @State private var logout = false
  @State private var purge: HermesChatProfile?
  @State private var keyProfile: HermesChatProfile?
  var body: some View {
    Form {
      Section("账号") {
        LabeledContent("当前账号", value: notes.user?.username ?? "")
        NavigationLink("修改登录密码") { AccountPasswordView() }
      }
      Section {
        Toggle("应用锁", isOn: Binding(
          get: { model.appLockEnabled },
          set: { enabled in Task { await model.setAppLock(enabled) } }
        )).disabled(model.isAuthenticating).accessibilityIdentifier("settings.app-lock")
        Picker("返回时要求解锁", selection: Binding(get: { model.lockDelay }, set: model.setLockDelay)) {
          ForEach(MobileLockDelay.allCases) { delay in Text(delay.label).tag(delay) }
        }.pickerStyle(.navigationLink).accessibilityIdentifier("settings.lock-delay")
      } header: {
        Text("隐私")
      } footer: {
        Text(model.appLockEnabled
          ? "使用 Face ID 或设备密码解锁。宽限期内返回免验证，重新启动仍需解锁。笔记保护密码独立。"
          : "应用锁未开启。开启后，可用 Face ID 或设备密码保护应用；所选时间会在开启后生效。")
      }
      Section("外观") {
        Picker("显示模式", selection: Binding(get: { model.appearance }, set: model.setAppearance)) {
          ForEach(MobileAppearance.allCases) { value in Text(value.label).tag(value) }
        }.pickerStyle(.navigationLink).accessibilityIdentifier("settings.appearance")
      }
      Section {
        Picker("本机聊天缓存", selection: Binding(get: { chat.retentionDays }, set: { days in Task { await chat.setRetentionDays(days) } })) {
          Text("保留全部").tag(0)
          Text("7 天").tag(7)
          Text("30 天").tag(30)
          Text("90 天").tag(90)
        }.pickerStyle(.navigationLink).accessibilityIdentifier("settings.retention")
      } header: { Text("聊天缓存") } footer: {
        Text("只影响这台 iPhone 的缓存，不删除云端消息。")
      }
      Section("聊天密钥") {
        ForEach(chat.profiles) { profile in
          Button { keyProfile = profile } label: {
            HStack {
              Label(profile.label, systemImage: "key").foregroundStyle(.primary)
              Spacer()
              Text(chat.isConfigured(spaceID: profile.id) ? "已配置" : "待配置")
                .font(.subheadline).foregroundStyle(.secondary)
              Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
            }
          }.buttonStyle(.plain)
        }
      }
      Section {
        Menu {
          ForEach(chat.profiles) { profile in Button(profile.label, role: .destructive) { purge = profile } }
        } label: {
          Label("清空云端会话记录", systemImage: "trash")
            .foregroundStyle(.red).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
          .disabled(chat.profiles.isEmpty).accessibilityIdentifier("settings.purge")
      } header: { Text("删除记录") } footer: {
        Text("删除所选会话的云端消息和附件，影响所有设备，无法撤销。")
      }
      Section("iPhone 个人版") {
        LabeledContent("版本", value: "\(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "") (\(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""))")
        Text("通知通过 Bark 接收；点击通知可打开 Hermes 会话列表。返回应用后恢复连接并同步消息。")
        Text("免费 Apple 账号的签名有效期为 7 天。到期后用同一账号和 Bundle ID 从 Xcode 重新安装，无需先卸载。")
          .font(.footnote).foregroundStyle(.secondary)
        if model.isPreview { Label("演示数据模式，不连接真实服务", systemImage: "eye").foregroundStyle(.orange) }
      }
      Section { Button("退出登录", role: .destructive) { logout = true }.disabled(model.sessionBusy) }
    }.navigationTitle("设置").formStyle(.grouped)
      .sheet(item: $keyProfile) { profile in ProfileKeyView(profile: profile) }
      .alert("退出登录？", isPresented: $logout) {
        Button("取消", role: .cancel) {}
        Button("退出", role: .destructive) { Task { await model.logout() } }
      } message: { Text("清除本机会话凭证。聊天密钥保留在本机钥匙串，可在会话设置中单独移除。") }
      .alert("清空 \(purge?.label ?? "") 的全部记录？", isPresented: Binding(get: { purge != nil }, set: { if !$0 { purge = nil } })) {
        Button("取消", role: .cancel) { purge = nil }
        Button("清空", role: .destructive) { if let profile = purge { Task { _ = await chat.purgeProfile(spaceID: profile.id) } }; purge = nil }
      } message: { Text("会删除云端及本机聊天记录和附件，无法撤销。") }
  }
}

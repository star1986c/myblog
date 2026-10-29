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
        Text("启用后使用 Face ID 或设备密码。离开应用未超过所选时间，返回时无需再次验证；重新启动应用仍需解锁。受保护笔记使用独立密码。")
      }
      Section("外观") {
        Picker("显示模式", selection: Binding(get: { model.appearance }, set: model.setAppearance)) {
          ForEach(MobileAppearance.allCases) { value in Text(value.label).tag(value) }
        }.pickerStyle(.navigationLink).accessibilityIdentifier("settings.appearance")
      }
      Section("Hermes") {
        Picker("本机聊天缓存", selection: Binding(get: { chat.retentionDays }, set: { days in Task { await chat.setRetentionDays(days) } })) {
          Text("保留全部").tag(0)
          Text("7 天").tag(7)
          Text("30 天").tag(30)
          Text("90 天").tag(90)
        }
        ForEach(chat.profiles) { profile in
          Button("\(profile.label) · 密钥") { keyProfile = profile }
        }
        Menu("清空会话记录", systemImage: "trash") {
          ForEach(chat.profiles) { profile in Button(profile.label, role: .destructive) { purge = profile } }
        }
        Text("清空会话会删除对应云端消息和附件，并影响所有设备；本机缓存天数只影响本机。")
          .font(.footnote).foregroundStyle(.secondary)
      }
      Section("iPhone 个人版") {
        LabeledContent("版本", value: "\(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "") (\(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""))")
        Text("后台推送未启用。重新打开应用后恢复连接并同步消息。")
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

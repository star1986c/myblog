import SwiftUI
import NotesCore
import LocalAuthentication
import Network

@main
struct MyNotesApp: App {
  @StateObject private var model = MobileModel()
  @Environment(\.scenePhase) private var phase

  var body: some Scene {
    WindowGroup {
      MobileRootView()
        .environmentObject(model)
        .environmentObject(model.notes)
        .environmentObject(model.chat)
        .tint(MobileTheme.accent)
        .preferredColorScheme(model.appearance.colorScheme)
        .task { await model.start() }
        .onChange(of: phase) { _, value in model.transition(to: value) }
    }
  }
}

@MainActor
final class MobileModel: ObservableObject {
  let notes: NotesStore
  let chat: HermesChatStore
  let isPreview: Bool
  @Published var tab = 0 { didSet { updateChatVisibility() } }
  @Published var chatPath: [MobileChatRoute] = [] { didSet { updateChatVisibility() } }
  @Published var chatDrafts: [String: MobileDraft] = [:]
  @Published var privacyCovered = false
  @Published var locked: Bool
  @Published var error: String?
  @Published var isStarting = true
  @Published var sessionBusy = false
  private var lifecycleTask: Task<Void, Never>?
  private let monitor = NWPathMonitor()
  private var hasNetwork = false
  private var phase: ScenePhase = .active
  private var started = false
  @Published private(set) var appLockEnabled: Bool
  @Published private(set) var lockDelay: MobileLockDelay
  @Published private(set) var appearance: MobileAppearance
  @Published private(set) var isAuthenticating = false
  private let preferences: UserDefaults
  private let now: () -> ContinuousClock.Instant
  private let authenticate: () async throws -> Bool
  private var lockGrace = MobileLockGrace()

  init(defaults: UserDefaults? = nil,
       now: @escaping () -> ContinuousClock.Instant = { .now },
       authenticate: @escaping () async throws -> Bool = {
         try await LAContext().evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "解锁 My Notes")
       }) {
    #if DEBUG
    isPreview = ProcessInfo.processInfo.arguments.contains("--preview")
      || ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
    #else
    isPreview = false
    #endif
    #if DEBUG
    if isPreview {
      notes = .preview()
      chat = .preview()
    } else {
      let api = NotesAPIClient()
      notes = NotesStore(api: api, autoSaveDelay: .seconds(2))
      chat = HermesChatStore(api: api)
    }
    #else
    let api = NotesAPIClient()
    notes = NotesStore(api: api, autoSaveDelay: .seconds(2))
    chat = HermesChatStore(api: api)
    #endif
    self.now = now
    self.authenticate = authenticate
    // UI previews must never alter the user's real privacy/appearance preferences.
    preferences = defaults ?? (isPreview ? UserDefaults(suiteName: "ios-preview-\(UUID().uuidString)")! : .standard)
    appLockEnabled = preferences.bool(forKey: "ios.app-lock")
    lockDelay = (preferences.object(forKey: "ios.app-lock-delay") as? Int).flatMap(MobileLockDelay.init(rawValue:)) ?? .threeMinutes
    appearance = preferences.string(forKey: "ios.appearance").flatMap(MobileAppearance.init(rawValue:)) ?? .system
    locked = preferences.bool(forKey: "ios.app-lock") // A fresh launch always requires authentication when enabled.
    if !isPreview {
      MobileFiles.cleanTemporaryFiles()
      MobileFiles.excludePrivateDataFromBackup()
    }
  }

  func start() async {
    guard !started else { return }
    started = true
    if !isPreview { await notes.start() }
    if notes.user != nil { await chat.start(); updateChatVisibility() }
    isStarting = false
    guard !isPreview else { return }
    monitor.pathUpdateHandler = { [weak self] path in
      let available = path.status == .satisfied
      Task { @MainActor [weak self] in
        guard let self else { return }
        let restored = available && !self.hasNetwork
        self.hasNetwork = available
        if restored && self.phase == .active && self.notes.user != nil {
          self.reconnectAfterLifecycle()
        }
      }
    }
    monitor.start(queue: DispatchQueue(label: "MyNotes.network"))
  }

  private func reconnectAfterLifecycle() {
    let previous = lifecycleTask
    lifecycleTask = Task {
      await previous?.value
      guard phase == .active, notes.user != nil else { return }
      await chat.resumeTransport()
      updateChatVisibility()
    }
  }

  private func updateChatVisibility() {
    let active = phase == .active && tab == 0 && !locked
    // The path is the single source of truth, including after tab/background changes.
    chat.setApplicationActive(false)
    chat.selectProfile(active ? chatPath.last?.id : nil)
    chat.setApplicationActive(active)
  }

  func setLockDelay(_ delay: MobileLockDelay) {
    lockDelay = delay
    preferences.set(delay.rawValue, forKey: "ios.app-lock-delay")
  }

  func setAppearance(_ value: MobileAppearance) {
    appearance = value
    preferences.set(value.rawValue, forKey: "ios.appearance")
  }

  func login(username: String, password: String) async {
    sessionBusy = true
    defer { sessionBusy = false }
    await notes.login(username: username, password: password)
    if notes.user != nil { await chat.start(); updateChatVisibility() }
  }

  func logout() async {
    sessionBusy = true
    defer { sessionBusy = false }
    guard await notes.saveSelected() else { return }
    await chat.stop()
    chatDrafts = [:]
    chatPath = []
    lockGrace.reset()
    await notes.logout()
    MobileFiles.cleanTemporaryFiles()
    tab = 0
  }

  func transition(to next: ScenePhase) {
    phase = next
    privacyCovered = next != .active
    MobilePrivacyShield.setVisible(next != .active)
    if next == .background {
      lockGrace.enteredBackground(at: now())
      if appLockEnabled && lockDelay == .immediately { locked = true }
    } else if next == .active {
      let expired = lockGrace.returnedToForeground(at: now(), delay: lockDelay)
      if appLockEnabled && expired { locked = true }
    }
    updateChatVisibility()
    guard !isPreview else { return }
    let previous = lifecycleTask
    lifecycleTask = Task {
      await previous?.value
      if next == .background {
        // A short system grace period to save edits, never a persistent service.
        let lease = MobileBackgroundLease()
        lease.begin()
        defer { lease.end() }
        await chat.suspendTransport()
        _ = await notes.saveSelected()
        await notes.relock()

      } else if next == .active && phase == .active && notes.user != nil {
        await chat.resumeTransport()
        updateChatVisibility()
        // Refresh only the list; don't replace the note currently being edited.
        if tab != 1 { await notes.refresh() }
      }
    }
  }

  func unlock() async {
    guard !isAuthenticating else { return }
    isAuthenticating = true
    defer { isAuthenticating = false }
    do {
      if try await authenticate(), phase != .background {
        locked = false
        lockGrace.reset()
        updateChatVisibility()
      }
    } catch { self.error = error.localizedDescription }
  }

  func setAppLock(_ enabled: Bool) async {
    guard !isAuthenticating else { return }
    isAuthenticating = true
    defer { isAuthenticating = false }
    if enabled {
      do {
        guard try await authenticate(), phase != .background else { return }
      } catch { self.error = error.localizedDescription; return }
    }
    appLockEnabled = enabled
    locked = false
    lockGrace.reset()
    preferences.set(enabled, forKey: "ios.app-lock")
    updateChatVisibility()
  }

}

struct MobileRootView: View {
  @EnvironmentObject private var model: MobileModel
  @EnvironmentObject private var notes: NotesStore
  @EnvironmentObject private var chat: HermesChatStore

  var body: some View {
    ZStack {
      if model.locked {
        VStack(spacing: 24) {
          Image(systemName: "lock.shield").font(.system(size: 54)).foregroundStyle(MobileTheme.accent)
          Text("My Notes 已锁定").font(.title2.bold())
          Button("使用 Face ID 或设备密码解锁") { Task { await model.unlock() } }
            .buttonStyle(.borderedProminent).disabled(model.isAuthenticating)
          if model.isAuthenticating { ProgressView() }
        }.frame(maxWidth: .infinity, maxHeight: .infinity).background(MobileTheme.canvas)
      } else if notes.user == nil {
        LoginView()
      } else if notes.user?.mustChangePassword == true {
        NavigationStack { AccountPasswordView(required: true) }
      } else {
        TabView(selection: $model.tab) {
          HermesNavigationView()
            .tabItem { Label("Hermes", systemImage: "bubble.left.and.bubble.right") }.tag(0)
            .badge(chat.totalUnread)
          NavigationStack { NotesListView() }
            .tabItem { Label("笔记", systemImage: "note.text") }.tag(1)
          NavigationStack { SettingsView() }
            .tabItem { Label("设置", systemImage: "gearshape") }.tag(2)
        }
      }
      if model.privacyCovered {
        MobileTheme.canvas.ignoresSafeArea()
          .overlay { Label("My Notes", systemImage: "lock.shield").font(.title2) }
      }
    }
    .mobileErrors()
  }
}

private struct LoginView: View {
  @EnvironmentObject private var model: MobileModel
  @EnvironmentObject private var notes: NotesStore
  @State private var username = ""
  @State private var password = ""
  var body: some View {
    NavigationStack {
      Form {
        Section {
          VStack(alignment: .leading, spacing: 10) {
            Image(systemName: "note.text").font(.system(size: 40)).foregroundStyle(MobileTheme.accent)
            Text("你的笔记与 AI 工作区").font(.title2.bold())
            Text("使用与安卓、Mac 相同的账号登录。笔记和 Hermes 聊天继续使用现有加密协议。")
              .font(.subheadline).foregroundStyle(.secondary)
          }.padding(.vertical, 16)
        }
        Section("账号") {
          TextField("用户名", text: $username).textContentType(.username)
            .textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityIdentifier("login.username")
          SecureField("密码", text: $password).textContentType(.password).accessibilityIdentifier("login.password")
          Button {
            Task { await model.login(username: username.trimmingCharacters(in: .whitespacesAndNewlines), password: password); password = "" }
          } label: {
            HStack { Text("登录"); Spacer(); if notes.isWorking || model.sessionBusy { ProgressView() } }
          }.disabled(username.isEmpty || password.isEmpty || model.isStarting || model.sessionBusy)
            .accessibilityIdentifier("login.submit")
        }
        Section { Text("此版本不接收后台推送。打开应用后会自动恢复聊天连接并补同步。")
            .font(.footnote).foregroundStyle(.secondary) }
        if model.isStarting { ProgressView("正在恢复登录…") }
      }.navigationTitle("My Notes")
    }
  }
}

struct AccountPasswordView: View {
  @EnvironmentObject private var notes: NotesStore
  @Environment(\.dismiss) private var dismiss
  var required = false
  @State private var current = ""
  @State private var next = ""
  @State private var confirmation = ""
  var body: some View {
    Form {
      if required { Text("请先更新初始密码，再继续使用。") }
      SecureField("当前密码", text: $current).textContentType(.password)
      SecureField("新密码（至少 12 个字符）", text: $next).textContentType(.newPassword)
      SecureField("确认新密码", text: $confirmation).textContentType(.newPassword)
      Button("更新密码") {
        Task {
          if await notes.changeLoginPassword(currentPassword: current, newPassword: next) { dismiss() }
        }
      }.disabled(current.isEmpty || next.count < 12 || next != confirmation || notes.isWorking)
    }.navigationTitle("修改登录密码")
  }
}


struct MobileErrorBanner: ViewModifier {
  @EnvironmentObject private var model: MobileModel
  @EnvironmentObject private var notes: NotesStore
  @EnvironmentObject private var chat: HermesChatStore
  func body(content: Content) -> some View {
    content.safeAreaInset(edge: .top, spacing: 0) {
      if let message = model.error ?? notes.errorMessage ?? chat.errorMessage {
        HStack(alignment: .top, spacing: 10) {
          Image(systemName: "exclamationmark.circle.fill")
          Text(message).font(.footnote).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
          Button("关闭提示", systemImage: "xmark") { model.error = nil; notes.clearError(); chat.clearError() }.labelStyle(.iconOnly)
        }.padding(12).foregroundStyle(.primary).background(.regularMaterial)
          .overlay(alignment: .bottom) { Divider() }
      }
    }
  }
}
extension View {
  func mobileErrors() -> some View { modifier(MobileErrorBanner()) }
}


/// Always release the system assertion on expiration as well as normal completion.
@MainActor
final class MobileBackgroundLease {
  typealias Begin = (@escaping @MainActor () -> Void) -> UIBackgroundTaskIdentifier
  private let beginTask: Begin
  private let endTask: (UIBackgroundTaskIdentifier) -> Void
  private var identifier = UIBackgroundTaskIdentifier.invalid

  init(begin: @escaping Begin = { expiration in
    UIApplication.shared.beginBackgroundTask(withName: "Save notes") {
      Task { @MainActor in expiration() }
    }
  }, end: @escaping (UIBackgroundTaskIdentifier) -> Void = { UIApplication.shared.endBackgroundTask($0) }) {
    beginTask = begin
    endTask = end
  }

  func begin() {
    guard identifier == .invalid else { return }
    identifier = beginTask { [weak self] in self?.end() }
  }

  func end() {
    let previous = identifier
    identifier = .invalid
    if previous != .invalid { endTask(previous) }
  }
}

import AppKit
import NotesCore
import SwiftUI
import UniformTypeIdentifiers

struct HermesConversationsView: View {
  @EnvironmentObject private var store: HermesChatStore
  @State private var showsSettings = false

  private var selection: Binding<String?> {
    Binding(
      get: { store.selectedProfileID },
      set: { requestedProfileID in
        Task { @MainActor in
          await Task.yield()
          guard store.selectedProfileID != requestedProfileID else { return }
          store.selectProfile(requestedProfileID)
        }
      }
    )
  }

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 12) {
        VStack(alignment: .leading, spacing: 3) {
          Text("Hermes 会话")
            .font(.title2.bold())
          Text(profileSummary)
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        Spacer()
        Button {
          Task { await store.refreshProfiles() }
        } label: {
          Image(systemName: "arrow.clockwise")
        }
        .disabled(store.isRefreshing)
        .help("刷新聊天对象")

        Button {
          showsSettings = true
        } label: {
          Image(systemName: "key.horizontal")
        }
        .help("管理聊天密钥与缓存")
      }
      .padding(.horizontal, 16)
      .frame(minHeight: 64)

      Divider()

      HStack(spacing: 10) {
        Image(systemName: "lock.shield.fill")
          .foregroundStyle(Color.accentColor)
        Text("每个聊天对象使用独立密钥；本地历史也保持加密")
          .font(.caption)
          .foregroundStyle(.secondary)
        Spacer(minLength: 0)
      }
      .padding(12)
      .background(Color.accentColor.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
      .padding(.horizontal, 12)
      .padding(.vertical, 10)

      if store.profiles.isEmpty {
        ContentUnavailableView {
          Label("暂无 Hermes 会话", systemImage: "message.badge")
        } description: {
          Text("请检查 Cloudflare 上的 profile 配置后重试。")
        } actions: {
          Button("重新加载") { Task { await store.refreshProfiles() } }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        List(selection: selection) {
          Section("所有聊天") {
            ForEach(store.profiles) { profile in
              HermesConversationRow(profile: profile)
                .tag(profile.id)
                .contextMenu {
                  Button("打开会话", systemImage: "message") {
                    store.selectProfile(profile.id)
                  }
                  Button("管理聊天密钥…", systemImage: "key.horizontal") {
                    store.selectProfile(profile.id)
                    showsSettings = true
                  }
                }
            }
          }
        }
        .listStyle(.inset)
      }

      Divider()
      HermesConnectionFooter()
    }
    .background(Color(nsColor: .controlBackgroundColor))
    .sheet(isPresented: $showsSettings) {
      HermesProfileSettingsSheet(initialProfileID: store.selectedProfileID)
        .environmentObject(store)
    }
  }

  private var profileSummary: String {
    if store.profiles.isEmpty {
      return store.isRefreshing ? "正在同步聊天对象…" : "尚未获取聊天对象"
    }
    return "\(store.profiles.count) 个聊天对象 · 多端实时同步"
  }
}

private struct HermesConversationRow: View {
  @EnvironmentObject private var store: HermesChatStore
  let profile: HermesChatProfile

  private var lastMessage: HermesChatMessage? { store.lastMessage(spaceID: profile.id) }
  private var unread: Int { store.unreadCount(spaceID: profile.id) }

  var body: some View {
    HStack(spacing: 12) {
      HermesAvatar(label: profile.label, size: 46)

      VStack(alignment: .leading, spacing: 5) {
        HStack(spacing: 8) {
          Text(profile.label)
            .font(.headline)
            .lineLimit(1)
          if store.typingProfiles.contains(profile.id) || store.awaitingProfiles.contains(profile.id) {
            ProgressView()
              .controlSize(.mini)
              .accessibilityLabel("正在思考")
          }
          Spacer(minLength: 8)
          if let lastMessage {
            Text(HermesChatFormat.shortTime(lastMessage.sentAt))
              .font(.caption2.monospacedDigit())
              .foregroundStyle(.tertiary)
          }
        }

        HStack(spacing: 8) {
          Text(previewText)
            .font(.subheadline)
            .foregroundStyle(
              store.isConfigured(spaceID: profile.id) ? Color.secondary : Color.orange
            )
            .lineLimit(2)
          Spacer(minLength: 8)
          if unread > 0 {
            Text("\(min(unread, 99))")
              .font(.caption2.bold())
              .foregroundStyle(.white)
              .padding(.horizontal, 7)
              .padding(.vertical, 3)
              .background(Color.accentColor, in: Capsule())
              .accessibilityLabel("\(unread) 条未读消息")
          }
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(.vertical, 7)
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
  }

  private var previewText: String {
    guard store.isConfigured(spaceID: profile.id) else { return "尚未设置聊天密钥" }
    guard let lastMessage else { return "聊天已就绪" }
    if !lastMessage.text.isEmpty {
      return lastMessage.text.replacingOccurrences(of: "\n", with: " ")
    }
    if let attachment = lastMessage.attachments.first {
      return "附件：\(attachment.name)"
    }
    return "加密消息"
  }
}

private struct HermesConnectionFooter: View {
  @EnvironmentObject private var store: HermesChatStore

  var body: some View {
    HStack(spacing: 8) {
      Circle()
        .fill(statusColor)
        .frame(width: 8, height: 8)
      Text(statusText)
        .font(.caption)
        .foregroundStyle(.secondary)
        .lineLimit(1)
      Spacer()
      if case .connected = store.connectionState {
        Text("1 条连接 · \(store.configuredProfileIDs.count) 个 profile")
          .font(.caption2)
          .foregroundStyle(.tertiary)
      } else {
        Button("重连") { Task { await store.reconnect() } }
          .buttonStyle(.borderless)
          .controlSize(.small)
      }
    }
    .padding(.horizontal, 14)
    .frame(height: 38)
  }

  private var statusColor: Color {
    switch store.connectionState {
    case .connected: .green
    case .connecting: .orange
    case .idle, .disconnected: .red
    }
  }

  private var statusText: String {
    switch store.connectionState {
    case .idle: "WebSocket 尚未连接"
    case .connecting: "WebSocket 正在连接…"
    case .connected: "WebSocket 已连接 · 端到端加密"
    case .disconnected: "WebSocket 已断开，正在重试"
    }
  }
}

struct HermesChatView: View {
  @EnvironmentObject private var store: HermesChatStore
  @State private var draft = ""
  @State private var selectedFiles: [URL] = []
  @State private var showsFileImporter = false
  @State private var showsCommands = false
  @State private var showsSettings = false
  @State private var showsSearch = false
  @State private var searchText = ""
  @State private var selectedMessageIDs = Set<String>()
  @State private var selectionMode = false
  @State private var pendingDelete: [HermesChatMessage] = []
  @State private var visibleMessageLimit = 160
  @State private var visibleSearchResultLimit = 160
  @FocusState private var composerFocused: Bool

  private var profile: HermesChatProfile? { store.selectedProfile }
  private var messages: [HermesChatMessage] { store.selectedMessages }
  private var hasSearchQuery: Bool {
    showsSearch && !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }
  private var matchingMessages: [HermesChatMessage] {
    let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
    guard hasSearchQuery else { return [] }
    return messages.filter { message in
      message.text.localizedCaseInsensitiveContains(query)
        || message.attachments.contains { $0.name.localizedCaseInsensitiveContains(query) }
    }
  }

  private var visibleMessages: [HermesChatMessage] {
    if hasSearchQuery {
      return Array(matchingMessages.suffix(visibleSearchResultLimit))
    }
    return Array(messages.suffix(visibleMessageLimit))
  }

  private var hiddenLocalMessageCount: Int {
    if hasSearchQuery {
      return max(0, matchingMessages.count - visibleMessages.count)
    }
    return max(0, messages.count - visibleMessages.count)
  }

  var body: some View {
    Group {
      if let profile {
        VStack(spacing: 0) {
          chatHeader(profile)
          Divider()
          if showsSearch { searchBar }
          if store.isConfigured(spaceID: profile.id) {
            messageTimeline(profile)
              .id(profile.id)
            Divider()
            composer(profile)
          } else {
            unconfigured(profile)
          }
        }
      } else {
        ContentUnavailableView(
          "选择一个 Hermes 会话",
          systemImage: "message",
          description: Text("聊天对象会从 Cloudflare 配置动态加载。")
        )
      }
    }
    .background(Color(nsColor: .textBackgroundColor))
    .fileImporter(
      isPresented: $showsFileImporter,
      allowedContentTypes: [.item],
      allowsMultipleSelection: true,
      onCompletion: handleFileSelection
    )
    .sheet(isPresented: $showsCommands) {
      HermesCommandPalette { command in
        insert(command)
        showsCommands = false
      }
    }
    .sheet(isPresented: $showsSettings) {
      HermesProfileSettingsSheet(initialProfileID: store.selectedProfileID)
        .environmentObject(store)
    }
    .confirmationDialog(
      deleteDialogTitle,
      isPresented: Binding(
        get: { !pendingDelete.isEmpty },
        set: { if !$0 { pendingDelete = [] } }
      )
    ) {
      Button("同时从本机和服务器删除", role: .destructive) {
        deletePendingMessages()
      }
      Button("取消", role: .cancel) { pendingDelete = [] }
    } message: {
      Text("附件密文也会从 Cloudflare 删除，此操作无法撤销。")
    }
    .onChange(of: store.selectedProfileID) { _, _ in
      draft = ""
      selectedFiles = []
      selectedMessageIDs = []
      selectionMode = false
      searchText = ""
      visibleMessageLimit = 160
      visibleSearchResultLimit = 160
      Task { @MainActor in composerFocused = true }
    }
    .onChange(of: searchText) { _, _ in
      visibleSearchResultLimit = 160
    }
    .onAppear {
      HermesTemporaryAttachmentFiles.cleanupExpired()
    }
  }

  @ViewBuilder
  private func chatHeader(_ profile: HermesChatProfile) -> some View {
    HStack(spacing: 12) {
      HermesAvatar(label: profile.label, size: 40)
      VStack(alignment: .leading, spacing: 2) {
        Text(profile.label)
          .font(.headline)
          .lineLimit(1)
        HStack(spacing: 5) {
          Circle()
            .fill(connectionColor)
            .frame(width: 7, height: 7)
          Text(connectionLabel(profile.id))
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
      }
      Spacer()

      if selectionMode {
        Text("已选 \(selectedMessageIDs.count) 条")
          .font(.caption)
          .foregroundStyle(.secondary)
        Button(role: .destructive) {
          pendingDelete = messages.filter { selectedMessageIDs.contains($0.id) }
        } label: {
          Label("删除", systemImage: "trash")
        }
        .disabled(selectedMessageIDs.isEmpty)
        Button("完成") {
          selectionMode = false
          selectedMessageIDs = []
        }
      } else {
        Button {
          withAnimation(.easeInOut(duration: 0.16)) { showsSearch.toggle() }
          if !showsSearch { searchText = "" }
        } label: {
          Image(systemName: showsSearch ? "xmark" : "magnifyingglass")
        }
        .help(showsSearch ? "关闭本地消息搜索" : "搜索本地聊天消息")
        if store.isRefreshingMessages {
          ProgressView()
            .controlSize(.small)
            .frame(width: 24, height: 24)
            .help("正在同步云端消息")
        } else {
          Menu {
            ForEach(HermesChatStore.refreshLookbackOptions, id: \.self) { days in
              Button {
                Task { await store.refreshRecentMessages(days: days) }
              } label: {
                if days == store.refreshLookbackDays {
                  Label("最近 \(days) 天", systemImage: "checkmark")
                } else {
                  Text("最近 \(days) 天")
                }
              }
            }
          } label: {
            Image(systemName: "arrow.clockwise")
          }
          .menuStyle(.borderlessButton)
          .fixedSize()
          .help("按时间范围同步当前会话；默认最近 \(store.refreshLookbackDays) 天")
        }
        Button {
          showsSettings = true
        } label: {
          Image(systemName: "ellipsis.circle")
        }
        .help("会话设置")
      }
    }
    .padding(.horizontal, 16)
    .frame(minHeight: 62)
  }

  private var searchBar: some View {
    HStack(spacing: 10) {
      Image(systemName: "magnifyingglass")
        .foregroundStyle(.secondary)
      TextField("搜索本机缓存中的文字或附件名称", text: $searchText)
        .textFieldStyle(.plain)
      if !searchText.isEmpty {
        Text("\(visibleMessages.count)/\(matchingMessages.count) 条")
          .font(.caption.monospacedDigit())
          .foregroundStyle(.secondary)
        Button {
          searchText = ""
        } label: {
          Image(systemName: "xmark.circle.fill")
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .help("清空搜索")
      }
    }
    .padding(.horizontal, 14)
    .frame(height: 42)
    .background(Color(nsColor: .controlBackgroundColor))
    .overlay(alignment: .bottom) { Divider() }
  }

  private func messageTimeline(_ profile: HermesChatProfile) -> some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(spacing: 10) {
          securityBanner
            .padding(.bottom, 4)

          if visibleMessages.isEmpty {
            ContentUnavailableView {
              Label(
                showsSearch && !searchText.isEmpty ? "没有搜索结果" : "开始与 Hermes 对话",
                systemImage: showsSearch && !searchText.isEmpty ? "magnifyingglass" : "sparkles"
              )
            } description: {
              Text(
                showsSearch && !searchText.isEmpty
                  ? "搜索只在这台 Mac 的加密缓存中进行。"
                  : "消息会与 Android 实时同步。"
              )
            }
            .frame(minHeight: 260)
          } else {
            if hiddenLocalMessageCount > 0 {
              Button {
                if hasSearchQuery {
                  visibleSearchResultLimit += 160
                } else {
                  visibleMessageLimit += 160
                }
              } label: {
                Label(
                  hasSearchQuery
                    ? "加载更早的搜索结果（还有 \(hiddenLocalMessageCount) 条）"
                    : "加载更早的本地消息（还有 \(hiddenLocalMessageCount) 条）",
                  systemImage: "clock.arrow.circlepath"
                )
              }
              .buttonStyle(.borderless)
              .font(.caption)
              .foregroundStyle(.secondary)
              .padding(.bottom, 4)
            }
            ForEach(visibleMessages) { message in
              HermesMessageRow(
                message: message,
                spaceID: profile.id,
                selectionMode: selectionMode,
                selected: selectedMessageIDs.contains(message.id),
                onToggleSelection: { toggleSelection(message) },
                onBeginSelection: {
                  selectionMode = true
                  selectedMessageIDs.insert(message.id)
                },
                onDelete: { pendingDelete = [message] }
              )
              .id(message.id)
            }
          }

          if store.typingProfiles.contains(profile.id) || store.awaitingProfiles.contains(profile.id) {
            HermesThinkingIndicator(isTyping: store.typingProfiles.contains(profile.id))
              .id("hermes-thinking")
          }
          Color.clear.frame(height: 1).id("hermes-bottom")
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 14)
      }
      .background(HermesChatBackground())
      .onAppear {
        scrollToBottom(proxy, animated: false)
        Task { @MainActor in composerFocused = true }
      }
      .onChange(of: messageScrollToken) { _, _ in
        guard !showsSearch else { return }
        scrollToBottom(proxy, animated: true)
      }
      .onChange(of: store.typingProfiles) { _, _ in
        guard !showsSearch else { return }
        scrollToBottom(proxy, animated: true)
      }
    }
  }

  private var securityBanner: some View {
    HStack(spacing: 8) {
      Image(systemName: "lock.fill")
      Text("消息和附件描述端到端加密 · Agent 大文件使用私有 R2 · 本机缓存保留 \(store.retentionDays == 0 ? "不限时间" : "\(store.retentionDays) 天")")
        .lineLimit(2)
      Spacer(minLength: 0)
    }
    .font(.caption)
    .foregroundStyle(.secondary)
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
    .background(.ultraThinMaterial, in: Capsule())
    .frame(maxWidth: 620)
  }

  @ViewBuilder
  private func composer(_ profile: HermesChatProfile) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      if !selectedFiles.isEmpty {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 8) {
            ForEach(selectedFiles, id: \.self) { url in
              HStack(spacing: 6) {
                Image(
                  systemName: HermesChatAttachmentPolicy.systemImage(
                    filename: url.lastPathComponent,
                    contentType: HermesChatAttachmentPolicy.contentType(for: url)
                  )
                )
                Text(url.lastPathComponent)
                  .lineLimit(1)
                Button {
                  selectedFiles.removeAll { $0 == url }
                } label: {
                  Image(systemName: "xmark.circle.fill")
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help("移除此附件")
              }
              .font(.caption)
              .padding(.horizontal, 10)
              .padding(.vertical, 7)
              .background(Color.accentColor.opacity(0.1), in: Capsule())
            }
          }
        }
        Text("附件会和文字一起发送；单个文件不超过 10 MiB，一条消息最多 8 个。")
          .font(.caption2)
          .foregroundStyle(.secondary)
      }

      if !HermesCommandCatalog.suggestions(for: draft).isEmpty {
        HermesInlineCommandSuggestions(
          commands: HermesCommandCatalog.suggestions(for: draft),
          onSelect: insert
        )
      }

      HStack(alignment: .bottom, spacing: 9) {
        Button {
          showsFileImporter = true
        } label: {
          Image(systemName: "paperclip")
            .font(.system(size: 16, weight: .semibold))
            .frame(width: 34, height: 34)
        }
        .buttonStyle(.bordered)
        .buttonBorderShape(.roundedRectangle(radius: 10))
        .disabled(store.isSending)
        .help("添加图片、音视频、文档或压缩包")

        Button {
          showsCommands = true
        } label: {
          HermesCommandGlyph()
            .frame(width: 34, height: 34)
        }
        .buttonStyle(.bordered)
        .buttonBorderShape(.roundedRectangle(radius: 10))
        .disabled(store.isSending)
        .help("打开 Hermes 指令面板")

        ZStack(alignment: .topLeading) {
          if draft.isEmpty {
            Text("给 \(profile.label) 发消息")
              .foregroundStyle(.tertiary)
              .padding(.horizontal, 7)
              .padding(.vertical, 8)
              .allowsHitTesting(false)
          }
          TextEditor(text: $draft)
            .font(.body)
            .scrollContentBackground(.hidden)
            .focused($composerFocused)
            .padding(.horizontal, 2)
            .frame(height: composerHeight)
            .onChange(of: draft) { _, value in
              Task { await store.sendTyping(active: !value.isEmpty) }
            }
        }
        .padding(.horizontal, 4)
        .background(
          Color(nsColor: .textBackgroundColor),
          in: RoundedRectangle(cornerRadius: 11)
        )
        .overlay {
          RoundedRectangle(cornerRadius: 11)
            .stroke(composerFocused ? Color.accentColor : Color.secondary.opacity(0.25), lineWidth: 1)
        }

        Button {
          send()
        } label: {
          if store.isSending {
            ProgressView()
              .controlSize(.small)
              .frame(width: 44, height: 34)
          } else {
            Label("发送", systemImage: "paperplane.fill")
              .frame(minWidth: 58, minHeight: 34)
          }
        }
        .buttonStyle(.borderedProminent)
        .buttonBorderShape(.roundedRectangle(radius: 10))
        .disabled(
          store.isSending
            || (draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
              && selectedFiles.isEmpty)
        )
        .keyboardShortcut(.return, modifiers: .command)
        .help("发送（⌘↩）")
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 11)
    .background(Color(nsColor: .windowBackgroundColor))
  }

  private func unconfigured(_ profile: HermesChatProfile) -> some View {
    ContentUnavailableView {
      Label("需要聊天密钥", systemImage: "key.horizontal")
    } description: {
      Text("在这台 Mac 上为“\(profile.label)”粘贴与 Android 相同的聊天密钥，即可同步历史消息。")
    } actions: {
      Button("配置聊天密钥") { showsSettings = true }
        .buttonStyle(.borderedProminent)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private var connectionColor: Color {
    switch store.connectionState {
    case .connected: .green
    case .connecting: .orange
    case .idle, .disconnected: .red
    }
  }

  private func connectionLabel(_ spaceID: String) -> String {
    guard store.isConfigured(spaceID: spaceID) else { return "未配置聊天密钥" }
    if store.typingProfiles.contains(spaceID) { return "Hermes 正在输入…" }
    if store.awaitingProfiles.contains(spaceID) { return "Hermes 正在思考…" }
    switch store.connectionState {
    case .idle: return "WebSocket 尚未连接"
    case .connecting: return "WebSocket 正在连接…"
    case .connected: return "WebSocket 已连接 · 端到端加密"
    case .disconnected: return "WebSocket 已断开，正在重试"
    }
  }

  private var messageScrollToken: String {
    guard let last = messages.last else { return "empty" }
    return "\(messages.count)|\(last.id)|\(last.sequence)|\(last.text.count)|\(last.finalUpdate)"
  }

  private var composerHeight: CGFloat {
    let explicitLines = max(1, draft.components(separatedBy: "\n").count)
    let wrappedLines = max(0, draft.count / 72)
    return min(96, max(36, CGFloat(explicitLines + wrappedLines) * 20 + 12))
  }

  private func scrollToBottom(_ proxy: ScrollViewProxy, animated: Bool) {
    let action = { proxy.scrollTo("hermes-bottom", anchor: .bottom) }
    if animated {
      withAnimation(.easeOut(duration: 0.2), action)
    } else {
      action()
    }
  }

  private func handleFileSelection(_ result: Result<[URL], Error>) {
    switch result {
    case .success(let urls):
      var accepted = selectedFiles
      for url in urls where !accepted.contains(url) {
        guard HermesChatAttachmentPolicy.kind(filename: url.lastPathComponent) != nil else {
          continue
        }
        accepted.append(url)
        if accepted.count == 8 { break }
      }
      selectedFiles = accepted
      composerFocused = true
    case .failure:
      break
    }
  }

  private func insert(_ command: HermesCommand) {
    draft = command.invocation + (command.arguments.hasPrefix("<") ? " " : "")
    composerFocused = true
  }

  private func send() {
    let text = draft
    let files = selectedFiles
    Task {
      if await store.send(text: text, fileURLs: files) {
        draft = ""
        selectedFiles = []
        composerFocused = true
      }
    }
  }

  private func toggleSelection(_ message: HermesChatMessage) {
    if selectedMessageIDs.contains(message.id) {
      selectedMessageIDs.remove(message.id)
    } else {
      selectedMessageIDs.insert(message.id)
    }
  }

  private var deleteDialogTitle: String {
    pendingDelete.count > 1 ? "删除这 \(pendingDelete.count) 条消息？" : "删除这条消息？"
  }

  private func deletePendingMessages() {
    guard let spaceID = profile?.id else { return }
    let targets = pendingDelete
    pendingDelete = []
    Task {
      if await store.deleteMessages(targets, spaceID: spaceID) {
        selectedMessageIDs.subtract(targets.map(\.id))
        if selectedMessageIDs.isEmpty { selectionMode = false }
      }
    }
  }
}

private struct HermesThinkingIndicator: View {
  let isTyping: Bool

  var body: some View {
    HStack {
      HStack(spacing: 8) {
        ProgressView()
          .controlSize(.small)
        Text(isTyping ? "Hermes 正在输入…" : "Hermes 正在思考…")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      .padding(.horizontal, 13)
      .padding(.vertical, 9)
      .background(.regularMaterial, in: Capsule())
      Spacer()
    }
    .frame(maxWidth: 760)
  }
}

private struct HermesInlineCommandSuggestions: View {
  let commands: [HermesCommand]
  let onSelect: (HermesCommand) -> Void

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 7) {
        ForEach(commands) { command in
          Button {
            onSelect(command)
          } label: {
            HStack(spacing: 6) {
              Text(command.invocation)
                .font(.callout.monospaced().weight(.semibold))
              Text(command.description)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            }
          }
          .buttonStyle(.bordered)
          .buttonBorderShape(.capsule)
        }
      }
    }
    .transition(.move(edge: .bottom).combined(with: .opacity))
  }
}

private struct HermesCommandGlyph: View {
  var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: 7)
        .fill(Color.accentColor.opacity(0.16))
      Image(systemName: "terminal.fill")
        .font(.system(size: 17, weight: .semibold))
        .foregroundStyle(Color.accentColor)
      Image(systemName: "sparkle")
        .font(.system(size: 7, weight: .bold))
        .foregroundStyle(Color.accentColor)
        .offset(x: 10, y: -9)
    }
    .accessibilityElement()
    .accessibilityLabel("Hermes 指令")
  }
}

private struct HermesCommandPalette: View {
  @Environment(\.dismiss) private var dismiss
  @State private var query = ""
  let onSelect: (HermesCommand) -> Void

  private var commands: [HermesCommand] { HermesCommandCatalog.search(query) }

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 12) {
        HermesCommandGlyph()
          .frame(width: 36, height: 36)
        VStack(alignment: .leading, spacing: 2) {
          Text("Hermes 指令")
            .font(.title3.bold())
          Text("与 Android 使用同一份指令能力清单")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        Spacer()
        Link(destination: HermesCommandCatalog.officialReference) {
          Label("官方文档", systemImage: "arrow.up.right.square")
        }
        Button("完成") { dismiss() }
          .keyboardShortcut(.cancelAction)
      }
      .padding(16)

      HStack(spacing: 9) {
        Image(systemName: "magnifyingglass")
          .foregroundStyle(.secondary)
        TextField("搜索指令或用途", text: $query)
          .textFieldStyle(.plain)
        if !query.isEmpty {
          Button {
            query = ""
          } label: {
            Image(systemName: "xmark.circle.fill")
          }
          .buttonStyle(.plain)
          .foregroundStyle(.secondary)
        }
      }
      .padding(.horizontal, 12)
      .frame(height: 38)
      .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
      .padding(.horizontal, 16)
      .padding(.bottom, 12)

      Divider()

      if commands.isEmpty {
        ContentUnavailableView.search(text: query)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        List {
          ForEach(HermesCommandCatalog.categories, id: \.self) { category in
            let matches = commands.filter { $0.category == category }
            if !matches.isEmpty {
              Section(category) {
                ForEach(matches) { command in
                  Button {
                    onSelect(command)
                  } label: {
                    HStack(alignment: .top, spacing: 12) {
                      Text(command.invocation)
                        .font(.body.monospaced().weight(.semibold))
                        .foregroundStyle(command.caution ? Color.orange : Color.accentColor)
                        .frame(width: 122, alignment: .leading)
                      VStack(alignment: .leading, spacing: 3) {
                        Text(command.description)
                          .foregroundStyle(.primary)
                        if !command.arguments.isEmpty {
                          Text(command.usage)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                        }
                      }
                      Spacer(minLength: 8)
                      if command.caution {
                        Image(systemName: "exclamationmark.triangle.fill")
                          .foregroundStyle(.orange)
                          .help("此指令可能中断任务或修改状态")
                      }
                    }
                    .contentShape(Rectangle())
                    .padding(.vertical, 4)
                  }
                  .buttonStyle(.plain)
                }
              }
            }
          }
        }
        .listStyle(.inset)
      }
    }
    .frame(width: 660, height: 620)
  }
}

private struct HermesProfileSettingsSheet: View {
  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject private var store: HermesChatStore
  @State private var selectedID: String?
  @State private var keyInput = ""
  @State private var keyVisible = false
  @State private var confirmsRemoveKey = false
  @State private var confirmsCloudCleanup = false
  @State private var isWorking = false

  init(initialProfileID: String?) {
    _selectedID = State(initialValue: initialProfileID)
  }

  private var profile: HermesChatProfile? {
    store.profiles.first { $0.id == selectedID } ?? store.profiles.first
  }

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        VStack(alignment: .leading, spacing: 2) {
          Text("Hermes 聊天设置")
            .font(.title2.bold())
          Text("密钥保存在这台 Mac 的钥匙串，不会写入偏好设置或同步到服务器。")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        Spacer()
        Button("完成") { dismiss() }
          .keyboardShortcut(.defaultAction)
      }
      .padding(18)

      Divider()

      HSplitView {
        List(store.profiles, selection: $selectedID) { profile in
          HStack(spacing: 10) {
            HermesAvatar(label: profile.label, size: 34)
            VStack(alignment: .leading, spacing: 2) {
              Text(profile.label)
                .lineLimit(1)
              Label(
                store.isConfigured(spaceID: profile.id) ? "已配置" : "未配置",
                systemImage: store.isConfigured(spaceID: profile.id) ? "checkmark.circle.fill" : "key"
              )
              .font(.caption2)
              .foregroundStyle(store.isConfigured(spaceID: profile.id) ? .green : .orange)
            }
          }
          .tag(profile.id)
          .padding(.vertical, 4)
        }
        .frame(minWidth: 210, idealWidth: 230)

        ScrollView {
          VStack(alignment: .leading, spacing: 20) {
            if let profile {
              profileKeySection(profile)
              Divider()
              localCacheSection
              Divider()
              cloudCleanupSection(profile)
            } else {
              ContentUnavailableView("暂无 profile", systemImage: "message")
            }
          }
          .padding(22)
          .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(minWidth: 470)
      }
    }
    .frame(width: 760, height: 590)
    .onAppear {
      if selectedID == nil { selectedID = store.profiles.first?.id }
    }
    .onChange(of: selectedID) { _, _ in
      keyInput = ""
      keyVisible = false
    }
    .confirmationDialog("移除这台 Mac 上的聊天密钥？", isPresented: $confirmsRemoveKey) {
      Button("移除密钥与本地缓存", role: .destructive) { removeKey() }
      Button("取消", role: .cancel) {}
    } message: {
      Text("Cloudflare 上的加密消息不会被删除；重新填入同一密钥后可以再次同步。")
    }
    .confirmationDialog("清空这个 profile 的云端聊天？", isPresented: $confirmsCloudCleanup) {
      Button("永久清空消息与附件", role: .destructive) { purgeCloud() }
      Button("取消", role: .cancel) {}
    } message: {
      Text("Android、Mac 和 Cloudflare 上的这段聊天历史都会被清除，无法撤销。")
    }
  }

  private func profileKeySection(_ profile: HermesChatProfile) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Label(profile.label, systemImage: "key.horizontal.fill")
        .font(.headline)
      Text("Space ID：\(profile.id)")
        .font(.caption.monospaced())
        .foregroundStyle(.secondary)

      if store.isConfigured(spaceID: profile.id) {
        Label("聊天密钥已安全保存在钥匙串", systemImage: "checkmark.shield.fill")
          .foregroundStyle(.green)
        HStack {
          Button("替换密钥…") { keyVisible = true }
          Button("移除此 Mac 的密钥", role: .destructive) {
            confirmsRemoveKey = true
          }
          .disabled(isWorking)
        }
      }

      if !store.isConfigured(spaceID: profile.id) || keyVisible {
        SecureField("粘贴 32 字节 Base64URL 聊天密钥", text: $keyInput)
          .textFieldStyle(.roundedBorder)
          .privacySensitive()
        HStack {
          Button(store.isConfigured(spaceID: profile.id) ? "保存新密钥" : "保存密钥") {
            saveKey(profile)
          }
          .buttonStyle(.borderedProminent)
          .disabled(keyInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isWorking)
          if keyVisible {
            Button("取消") {
              keyInput = ""
              keyVisible = false
            }
          }
          if isWorking { ProgressView().controlSize(.small) }
        }
      }
    }
  }

  private var localCacheSection: some View {
    VStack(alignment: .leading, spacing: 12) {
      Label("本机缓存", systemImage: "internaldrive")
        .font(.headline)
      Text("消息历史和下载缓存按 profile 隔离；聊天历史文件继续使用聊天密钥加密。")
        .font(.callout)
        .foregroundStyle(.secondary)
      Picker("保留时间", selection: Binding(
        get: { store.retentionDays },
        set: { days in Task { await store.setRetentionDays(days) } }
      )) {
        Text("7 天").tag(7)
        Text("30 天").tag(30)
        Text("90 天").tag(90)
        Text("不限时间").tag(0)
      }
      .pickerStyle(.segmented)
    }
  }

  private func cloudCleanupSection(_ profile: HermesChatProfile) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Label("云端数据", systemImage: "cloud")
        .font(.headline)
      Text("Cloudflare Durable Object 保存加密消息，R2 保存加密附件与 Agent 私有大文件。只清理当前 profile，不影响其他助手。")
        .font(.callout)
        .foregroundStyle(.secondary)
      Button("清空“\(profile.label)”的云端消息与附件…", role: .destructive) {
        confirmsCloudCleanup = true
      }
      .disabled(isWorking || !store.isConfigured(spaceID: profile.id))
    }
  }

  private func saveKey(_ profile: HermesChatProfile) {
    isWorking = true
    let key = keyInput
    Task {
      if await store.saveKey(key, spaceID: profile.id) {
        keyInput = ""
        keyVisible = false
      }
      isWorking = false
    }
  }

  private func removeKey() {
    guard let profile else { return }
    isWorking = true
    Task {
      await store.removeKey(spaceID: profile.id)
      isWorking = false
    }
  }

  private func purgeCloud() {
    guard let profile else { return }
    isWorking = true
    Task {
      _ = await store.purgeProfile(spaceID: profile.id)
      isWorking = false
    }
  }
}

private struct HermesAvatar: View {
  let label: String
  let size: CGFloat

  var body: some View {
    ZStack {
      LinearGradient(
        colors: [Color.indigo, Color.accentColor],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
      )
      Image(systemName: "sparkles")
        .font(.system(size: size * 0.38, weight: .bold))
        .foregroundStyle(.white)
    }
    .frame(width: size, height: size)
    .clipShape(RoundedRectangle(cornerRadius: size * 0.3, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: size * 0.3, style: .continuous)
        .stroke(.white.opacity(0.28), lineWidth: 1)
    }
    .accessibilityLabel(label)
  }
}

private struct HermesChatBackground: View {
  var body: some View {
    ZStack {
      Color(nsColor: .textBackgroundColor)
      LinearGradient(
        colors: [Color.accentColor.opacity(0.045), Color.indigo.opacity(0.025), .clear],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
      )
      Canvas { context, size in
        let color = Color.secondary.opacity(0.045)
        for row in 0...Int(size.height / 90) {
          for column in 0...Int(size.width / 120) {
            let x = CGFloat(column) * 120 + (row.isMultiple(of: 2) ? 24 : 72)
            let y = CGFloat(row) * 90 + 30
            context.stroke(
              Path(ellipseIn: CGRect(x: x, y: y, width: 18, height: 18)),
              with: .color(color),
              lineWidth: 1
            )
          }
        }
      }
      .allowsHitTesting(false)
    }
  }
}

enum HermesChatFormat {
  private static let timeFormatter: DateFormatter = {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "zh_CN")
    formatter.dateFormat = "HH:mm"
    return formatter
  }()

  private static let fullFormatter: DateFormatter = {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "zh_CN")
    formatter.dateFormat = "yyyy-MM-dd HH:mm"
    return formatter
  }()

  static func shortTime(_ milliseconds: Int64) -> String {
    timeFormatter.string(from: Date(timeIntervalSince1970: Double(milliseconds) / 1_000))
  }

  static func fullTime(_ milliseconds: Int64) -> String {
    fullFormatter.string(from: Date(timeIntervalSince1970: Double(milliseconds) / 1_000))
  }
}

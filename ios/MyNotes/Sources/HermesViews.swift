import SwiftUI
import NotesCore

struct MobileDraft {
  var text = ""
  var files: [URL] = []
}

/// Keep destination registration outside the lazy list and the route in the app model.
struct HermesNavigationView: View {
  @EnvironmentObject private var model: MobileModel
  @EnvironmentObject private var chat: HermesChatStore

  var body: some View {
    NavigationStack(path: $model.chatPath) {
      VStack(spacing: 0) { ConversationsView() }
        .navigationDestination(for: MobileChatRoute.self) { route in
          if let profile = chat.profiles.first(where: { $0.id == route.id }) {
            ChatView(profile: profile).id(route.id)
          } else {
            ContentUnavailableView {
              Label("会话暂不可用", systemImage: "bubble.left.and.exclamationmark.bubble.right")
            } description: {
              Text("会话配置可能已更新，请返回列表刷新后重试。")
            } actions: {
              Button("返回会话列表") { model.chatPath = [] }
            }
            .navigationTitle("Hermes")
            .background(MobileTheme.canvas)
          }
        }
    }
  }
}

struct ConversationsView: View {
  @EnvironmentObject private var chat: HermesChatStore
  @State private var keyProfile: HermesChatProfile?
  var body: some View {
    List {
      Section {
        HStack {
          Circle().fill(chat.connectionState == .connected ? .green : .orange).frame(width: 8, height: 8)
          Text(connectionLabel).font(.subheadline).foregroundStyle(.secondary)
          Spacer()
          if chat.isRefreshing { ProgressView() }
        }
      }
      ForEach(chat.profiles) { profile in
        NavigationLink(value: MobileChatRoute(id: profile.id)) {
          HStack(spacing: 14) {
            Image(systemName: "bubble.left.and.bubble.right").font(.title3)
              .foregroundStyle(MobileTheme.accent)
              .frame(width: 44, height: 44)
              .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 12))
              .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 6) {
              HStack(alignment: .firstTextBaseline) {
                Text(profile.label).font(.headline).foregroundStyle(.primary)
                Spacer(minLength: 8)
                if let last = chat.lastMessage(spaceID: profile.id) {
                  Text(Date(timeIntervalSince1970: Double(last.sentAt) / 1000), style: .time)
                    .font(.caption).foregroundStyle(.secondary)
                }
              }
              Text(previewText(for: profile))
                .font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
            }
            Spacer(minLength: 0)
            if chat.unreadCount(spaceID: profile.id) > 0 {
              Text("\(chat.unreadCount(spaceID: profile.id))").font(.caption.bold()).padding(7)
                .foregroundStyle(.primary).background(Color(uiColor: .tertiarySystemFill), in: Capsule())
                .accessibilityLabel("\(chat.unreadCount(spaceID: profile.id)) 条未读消息")
            }
          }.padding(.vertical, 5)
        }.accessibilityIdentifier("profile.\(profile.id)")
          .contextMenu { Button("配置密钥", systemImage: "key") { keyProfile = profile } }
          .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button("密钥", systemImage: "key") { keyProfile = profile }.tint(MobileTheme.accent)
          }
      }
    }
    .listStyle(.insetGrouped)
    .navigationTitle("Hermes")
    .overlay { if chat.profiles.isEmpty && !chat.isRefreshing { ContentUnavailableView("暂无会话", systemImage: "bubble.left.and.bubble.right", description: Text("下拉刷新，从服务器加载已配置的 Hermes profiles。")) } }
    .refreshable { await chat.refreshProfiles(); await chat.resumeTransport() }
    .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("重新连接", systemImage: "arrow.clockwise") { Task { await chat.resumeTransport() } } } }
    .sheet(item: $keyProfile) { profile in ProfileKeyView(profile: profile) }
  }
  private func previewText(for profile: HermesChatProfile) -> String {
    guard chat.isConfigured(spaceID: profile.id) else { return "点击配置聊天密钥" }
    guard let message = chat.lastMessage(spaceID: profile.id) else { return "开始聊天" }
    let description = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
    if !description.isEmpty { return description }
    guard let attachment = message.attachments.first else { return "加密消息" }
    let name = attachment.name.trimmingCharacters(in: .whitespacesAndNewlines)
    let label = name.isEmpty ? "未命名附件" : name
    let count = message.attachments.count
    return count > 1 ? "附件：\(label) 等 \(count) 个附件" : "附件：\(label)"
  }
  private var connectionLabel: String {
    switch chat.connectionState {
    case .connected: "已连接 · 双向加密"
    case .connecting: "正在连接…"
    case .disconnected: "连接中断，正在重试"
    case .idle: "配置密钥后连接"
    }
  }
}

struct ProfileKeyView: View {
  @EnvironmentObject private var chat: HermesChatStore
  @Environment(\.dismiss) private var dismiss
  let profile: HermesChatProfile
  @State private var key = ""
  @State private var busy = false
  @State private var removing = false
  var body: some View {
    NavigationStack {
      Form {
        Section(profile.label) {
          SecureField("HERMES_CF_CHAT_KEY", text: $key)
            .textInputAutocapitalization(.never).autocorrectionDisabled()
          Text("输入与安卓端、NAS 对应 profile 相同的 32 字节 Base64 密钥。密钥仅保存在本机钥匙串。")
            .font(.footnote).foregroundStyle(.secondary)
          Button("保存并连接") {
            busy = true
            Task {
              defer { busy = false }
              if await chat.saveKey(key, spaceID: profile.id) { key = ""; dismiss() }
            }
          }.disabled(key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busy)
        }
        if chat.isConfigured(spaceID: profile.id) {
          Section { Button("移除本机密钥", role: .destructive) { removing = true } }
        }
      }.navigationTitle("聊天密钥").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { key = ""; dismiss() } } }
        .alert("移除密钥？", isPresented: $removing) {
          Button("取消", role: .cancel) {}
          Button("移除", role: .destructive) { Task { await chat.removeKey(spaceID: profile.id); dismiss() } }
        } message: { Text("同时清除此 profile 的本机聊天缓存。云端消息保留，可以重新输入密钥恢复。") }
        .mobileErrors()
    }
  }
}

private struct ChatView: View {
  @EnvironmentObject private var chat: HermesChatStore
  @EnvironmentObject private var model: MobileModel
  let profile: HermesChatProfile
  @State private var search = ""
  @State private var limit = 40
  @State private var configuring = false
  @State private var commands = false
  @State private var deleting = false
  @State private var selecting = false
  @State private var selected: Set<String> = []
  @State private var nearBottom = true
  @State private var preview: MobileFile?
  @State private var previewURL: URL?
  @State private var openingID: String?
  @State private var openingTask: Task<Void, Never>?
  @State private var thumbnails = MobileThumbnailCache()

  private var draft: MobileDraft { model.chatDrafts[profile.id] ?? MobileDraft() }
  private var allMessages: [HermesChatMessage] {
    #if DEBUG
    if model.isPreview && ProcessInfo.processInfo.arguments.contains("--preview-chat-style") {
      return MobileChatStyleFixture.messages
    }
    if model.isPreview && ProcessInfo.processInfo.arguments.contains("--preview-long-history") {
      return MobileLongHistoryFixture.messages
    }
    if model.isPreview && ProcessInfo.processInfo.arguments.contains("--preview-attachments") {
      return MobileAttachmentFixtures.messages(spaceID: profile.id)
    }
    #endif
    return chat.messages(spaceID: profile.id)
  }
  private var matchingMessages: [HermesChatMessage] {
    search.isEmpty ? allMessages : allMessages.filter { $0.text.localizedCaseInsensitiveContains(search) || $0.attachments.contains { $0.name.localizedCaseInsensitiveContains(search) } }
  }
  private var visibleCount: Int {
    HermesChatMessageWindow.visibleCount(in: matchingMessages, limit: limit)
  }
  private var messages: [HermesChatMessage] { Array(matchingMessages.suffix(visibleCount)) }

  var body: some View {
    VStack(spacing: 0) {
      if !chat.isConfigured(spaceID: profile.id) {
        ContentUnavailableView {
          Label("配置聊天密钥", systemImage: "key")
        } description: { Text("此设备尚未配置 \(profile.label) 的加密密钥。") }
        actions: { Button("输入密钥") { configuring = true }.buttonStyle(.borderedProminent) }
      } else {
        timeline
        if chat.typingProfiles.contains(profile.id) || chat.awaitingProfiles.contains(profile.id) {
          HStack { ProgressView().controlSize(.small); Text(chat.typingProfiles.contains(profile.id) ? "Hermes 正在输入…" : "等待 Hermes 回复…").font(.caption); Spacer() }.padding(.horizontal).padding(.vertical, 6)
        }
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background {
      LinearGradient(colors: [MobileChatStyle.wallpaperTop, MobileChatStyle.wallpaperBottom],
        startPoint: .topLeading, endPoint: .bottomTrailing).ignoresSafeArea()
    }
    .tint(MobileChatStyle.accent)
    .safeAreaInset(edge: .bottom, spacing: 0) {
      if chat.isConfigured(spaceID: profile.id) {
        if selecting { selectionBar } else { composer }
      }
    }
    .navigationTitle(profile.label).navigationBarTitleDisplayMode(.inline)
    .searchable(text: $search, prompt: "搜索本机聊天记录")
    .onChange(of: search) { _, _ in limit = 40 }
    .toolbar {
      ToolbarItem(placement: .principal) {
        VStack(spacing: 2) {
          Text(profile.label).font(.headline).lineLimit(1)
          Text(chat.connectionState == .connected ? "端到端加密" : "正在连接…")
            .font(.caption2).foregroundStyle(.secondary)
        }
      }
      ToolbarItem(placement: .topBarTrailing) {
        Menu {
          Button("聊天密钥", systemImage: "key") { configuring = true }
          Button("命令面板", systemImage: "command") { commands = true }
          Menu("补同步历史") {
            ForEach(HermesChatStore.refreshLookbackOptions, id: \.self) { days in
              Button("最近 \(days) 天") { Task { await chat.refreshRecentMessages(days: days, spaceID: profile.id) } }
            }
          }
          Button(selecting ? "取消选择" : "选择消息", systemImage: "checkmark.circle") { selecting.toggle(); selected = [] }
          Button("重新连接", systemImage: "arrow.clockwise") { Task { await chat.resumeTransport() } }
        } label: { Image(systemName: "ellipsis.circle").accessibilityLabel("会话操作") }
      }
    }
    .sheet(isPresented: $configuring) { ProfileKeyView(profile: profile) }
    .sheet(isPresented: $commands) { CommandPicker { command in updateText(command.invocation + (command.arguments.isEmpty ? "" : " ")); commands = false } }
    .sheet(item: $preview, onDismiss: { if let url = previewURL { MobileFiles.remove(url) }; previewURL = nil }) { file in FilePreview(url: file.url) }
    .onDisappear { openingTask?.cancel() }
    .alert("删除所选消息？", isPresented: $deleting) {
      Button("取消", role: .cancel) {}
      Button("删除", role: .destructive) {
        let targets = allMessages.filter { selected.contains($0.id) }
        Task { if await chat.deleteMessages(targets, spaceID: profile.id) { selected = []; selecting = false } }
      }
    } message: { Text("消息和附件将从云端删除，并影响其他设备。") }
  }

  private var timeline: some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 8) {
          if matchingMessages.count > visibleCount {
            Button("加载更早的消息（还有 \(matchingMessages.count - visibleCount) 条）") { limit += 40 }
              .frame(maxWidth: .infinity).padding(.vertical, 8)
          }
          if chat.isRefreshingMessages { ProgressView("正在补同步…").frame(maxWidth: .infinity) }
          ForEach(messages) { message in
            HStack(alignment: .top, spacing: 8) {
              if selecting {
                Button {
                  if selected.contains(message.id) { selected.remove(message.id) }
                  else if selected.count < 100 { selected.insert(message.id) }
                } label: { Image(systemName: selected.contains(message.id) ? "checkmark.circle.fill" : "circle") }
                  .disabled(message.sequence <= 0).accessibilityLabel("选择消息")
              }
              messageBubble(message)
            }.id(message.id)
          }
          Color.clear.frame(height: 1).id("bottom")
            .onAppear { nearBottom = true }.onDisappear { nearBottom = false }
        }.padding(.horizontal, 10).padding(.vertical, 12)
      }
      .scrollDismissesKeyboard(.interactively)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .overlay {
        if matchingMessages.isEmpty {
          if chat.isRefreshing || chat.isRefreshingMessages {
            ProgressView("正在加载聊天…")
          } else if !search.isEmpty {
            ContentUnavailableView.search(text: search)
          } else {
            ContentUnavailableView("还没有消息", systemImage: "bubble.left.and.bubble.right",
              description: Text("从下面发送消息，开始与 \(profile.label) 对话。"))
          }
        }
      }
      .task(id: profile.id) {
        // Resolve the new destination's layout before scrolling; never reuse another
        // conversation's default bottom anchor / lazy-layout offset.
        await Task.yield()
        guard !Task.isCancelled else { return }
        proxy.scrollTo(messages.last?.id ?? "bottom", anchor: .bottom)
      }
      .overlay(alignment: .bottomTrailing) {
        if !nearBottom { Button { proxy.scrollTo(messages.last?.id ?? "bottom", anchor: .bottom) } label: {
          Image(systemName: "arrow.down").font(.system(size: 18, weight: .semibold))
            .frame(width: 44, height: 44).background(MobileChatStyle.incoming, in: Circle())
            .shadow(color: .black.opacity(0.12), radius: 4, y: 2)
        }.accessibilityLabel("最新消息").padding(12) }
      }
      .onChange(of: allMessages.count) { _, _ in if nearBottom && search.isEmpty { proxy.scrollTo(messages.last?.id ?? "bottom", anchor: .bottom) } }
    }
  }

  private func messageBubble(_ message: HermesChatMessage) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      if !message.text.isEmpty { MessageMarkdown(text: message.text).equatable() }
      ForEach(message.attachments) { attachment in
        MobileChatAttachment(descriptor: attachment, isOpening: openingID == attachment.id,
          loadThumbnail: { try await thumbnail(attachment) },
          open: { openingTask = Task { await open(attachment) } })
          .disabled(openingID != nil)
      }
      if let interaction = message.interaction {
        TimelineView(.periodic(from: .now, by: 1)) { context in
          VStack(alignment: .leading, spacing: 8) {
            if let status = interaction.status { Text(status).font(.caption).foregroundStyle(.secondary) }
            ForEach(interaction.options) { option in
              Button { Task { await chat.chooseInteractionOption(message: message, option: option, spaceID: profile.id) } } label: {
                HStack { Text(option.label); if option.selected { Image(systemName: "checkmark") } }
                  .frame(maxWidth: .infinity)
              }.buttonStyle(.bordered)
                .disabled(option.disabled || !interaction.isPending(at: Int64(context.date.timeIntervalSince1970 * 1000)) || chat.connectionState != .connected)
            }
          }
        }
      }
      Text(Date(timeIntervalSince1970: Double(message.sentAt) / 1000), style: .time)
        .font(.caption2).foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
    .padding(.horizontal, 12).padding(.top, 10).padding(.bottom, 7)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(message.isAgent ? MobileChatStyle.incoming : MobileChatStyle.outgoing,
      in: UnevenRoundedRectangle(topLeadingRadius: 16,
        bottomLeadingRadius: message.isAgent ? 5 : 16,
        bottomTrailingRadius: message.isAgent ? 16 : 5, topTrailingRadius: 16))
    .shadow(color: .black.opacity(0.05), radius: 1, y: 1)
    .padding(message.isAgent ? .trailing : .leading, 32)
    .contextMenu {
      Button("复制文字", systemImage: "doc.on.doc") { UIPasteboard.general.setItems([["public.utf8-plain-text": message.text]], options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(120)]) }
      ShareLink(item: message.text) { Label("分享文字", systemImage: "square.and.arrow.up") }
      Button("删除消息", systemImage: "trash", role: .destructive) { selected = [message.id]; deleting = true }.disabled(message.sequence <= 0)
    }
  }

  private var composer: some View {
    VStack(alignment: .leading, spacing: 8) {
      if !draft.files.isEmpty {
        ScrollView(.horizontal) {
          HStack {
            ForEach(draft.files, id: \.self) { url in
              Button { var value = draft; value.files.removeAll { $0 == url }; model.chatDrafts[profile.id] = value; MobileFiles.remove(url) } label: {
                Label(url.lastPathComponent, systemImage: "xmark.circle.fill").font(.caption).lineLimit(1)
              }.buttonStyle(.bordered).disabled(chat.isSending)
            }
          }
        }
      }
      if draft.text.hasPrefix("/") {
        ScrollView(.horizontal) {
          HStack {
            ForEach(HermesCommandCatalog.suggestions(for: draft.text)) { command in
              Button(command.usage) { updateText(command.invocation + (command.arguments.isEmpty ? "" : " ")) }.buttonStyle(.bordered).font(.caption)
            }
          }
        }
      }
      HStack(alignment: .bottom, spacing: 6) {
        MediaPickerMenu(includeFiles: true, onCapture: { addFiles([$0.url]) }, onFiles: addFiles, symbol: "paperclip")
          .frame(minWidth: 44, minHeight: 44).disabled(chat.isSending)
        TextField("输入消息或 /命令", text: Binding(get: { draft.text }, set: updateText), axis: .vertical)
          .lineLimit(1...6).padding(.horizontal, 14).padding(.vertical, 11)
          .background(MobileChatStyle.input, in: RoundedRectangle(cornerRadius: 23))
          .overlay { RoundedRectangle(cornerRadius: 20).stroke(Color(uiColor: .separator).opacity(0.35), lineWidth: 0.5) }
          .disabled(chat.isSending).accessibilityIdentifier("chat.composer")
        Button {
          let sentDraft = draft
          Task {
            if await chat.send(text: sentDraft.text, fileURLs: sentDraft.files, spaceID: profile.id) {
              model.chatDrafts[profile.id] = MobileDraft()
              sentDraft.files.forEach(MobileFiles.remove)
              nearBottom = true
            }
          }
        } label: {
          if chat.isSending { ProgressView() } else { Image(systemName: "arrow.up.circle.fill").font(.system(size: 38, weight: .medium)) }
        }.frame(minWidth: 44, minHeight: 44).disabled(chat.isSending || chat.connectionState != .connected || (draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && draft.files.isEmpty))
          .accessibilityLabel("发送消息").accessibilityIdentifier("chat.send")
      }
      if chat.connectionState != .connected { Text("等待连接，草稿会保留在本次运行中").font(.caption).foregroundStyle(.secondary) }
    }.padding(.horizontal, 8).padding(.vertical, 6).background(.ultraThinMaterial)
  }
  private var selectionBar: some View {
    HStack {
      Text("已选 \(selected.count) / 100 条")
      Spacer()
      Button("删除", role: .destructive) { deleting = true }.disabled(selected.isEmpty)
      Button("完成") { selecting = false; selected = [] }
    }.padding().background(.bar)
  }
  private func updateText(_ text: String) {
    var value = draft; value.text = text; model.chatDrafts[profile.id] = value
  }
  private func addFiles(_ urls: [URL]) {
    guard draft.files.count + urls.count <= 8 else { urls.forEach(MobileFiles.remove); model.error = "一条消息最多发送 8 个附件。"; return }
    var value = draft; value.files += urls; model.chatDrafts[profile.id] = value
  }
  private func open(_ descriptor: HermesChatAttachmentDescriptor) async {
    guard openingID == nil else { return }
    openingID = descriptor.id
    defer { openingID = nil }
    do {
      let source = try await attachmentFile(descriptor)
      defer { if !descriptor.isPrivateR2 { try? FileManager.default.removeItem(at: source) } }
      try Task.checkCancellation()
      // QL may keep a file alive while sharing; isolate previews from the encrypted cache.
      let url = try await Task.detached {
        try MobileFiles.copyPreview(source, name: descriptor.name)
      }.value
      guard !Task.isCancelled, model.chatPath.last?.id == profile.id else { MobileFiles.remove(url); return }
      previewURL = url; preview = MobileFile(url: url)
    } catch is CancellationError { }
    catch { if !Task.isCancelled { model.error = error.localizedDescription } }
  }

  private func attachmentFile(_ descriptor: HermesChatAttachmentDescriptor) async throws -> URL {
    #if DEBUG
    if model.isPreview { return try MobileAttachmentFixtures.file(descriptor) }
    #endif
    return try await chat.attachmentFile(descriptor, spaceID: profile.id)
  }

  private func thumbnail(_ descriptor: HermesChatAttachmentDescriptor) async throws -> CGImage? {
    let key = "\(profile.id)/\(descriptor.id)/\(descriptor.sha256 ?? descriptor.nonce ?? "")"
    if let image = await thumbnails.cached(key: key) { return image }
    try Task.checkCancellation()
    #if DEBUG
    if model.isPreview {
      return await thumbnails.image(data: try MobileAttachmentFixtures.data(descriptor), key: key)
    }
    #endif
    if descriptor.isPrivateR2 {
      let url = try await chat.attachmentFile(descriptor, spaceID: profile.id)
      try Task.checkCancellation()
      return await thumbnails.image(at: url, key: key)
    }
    let data = try await chat.attachmentData(descriptor, spaceID: profile.id)
    try Task.checkCancellation()
    return await thumbnails.image(data: data, key: key)
  }
}

private struct CommandPicker: View {
  let choose: (HermesCommand) -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var query = ""
  var body: some View {
    NavigationStack {
      List(HermesCommandCatalog.search(query)) { command in
        Button { choose(command) } label: {
          VStack(alignment: .leading, spacing: 5) {
            Text(command.usage).font(.system(.body, design: .monospaced)).foregroundStyle(MobileTheme.accent)
            Text(command.description).font(.caption).foregroundStyle(Color.secondary)
            if command.caution { Text("此命令可能修改远端状态").font(.caption2).foregroundStyle(.orange) }
          }
        }.buttonStyle(.plain)
      }.searchable(text: $query, prompt: "搜索命令").navigationTitle("命令面板").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
    }
  }
}

struct MobileMarkdownBlock: Equatable {
  enum Kind: Equatable { case text, heading(Int), code }
  let kind: Kind
  let text: String

  static func parse(_ markdown: String) -> [MobileMarkdownBlock] {
    var blocks: [MobileMarkdownBlock] = []
    var lines: [String] = []
    var code = false
    func flush() {
      if !lines.isEmpty {
        let joined = lines.joined(separator: "\n")
        let text = code ? joined : joined.trimmingCharacters(in: .newlines)
        if !text.isEmpty { blocks.append(MobileMarkdownBlock(kind: code ? .code : .text, text: text)) }
        lines = []
      }
    }
    for line in markdown.components(separatedBy: "\n") {
      if line.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
        flush(); code.toggle(); continue
      }
      if code { lines.append(line); continue }
      let level = line.prefix(while: { $0 == "#" }).count
      if (1...6).contains(level), line.dropFirst(level).first == " " {
        flush()
        blocks.append(MobileMarkdownBlock(kind: .heading(level), text: String(line.dropFirst(level + 1))))
      } else if line.hasPrefix("- ") || line.hasPrefix("* ") {
        lines.append("• " + line.dropFirst(2))
      } else { lines.append(line) }
    }
    flush()
    return blocks
  }
}

struct MessageMarkdown: View, Equatable {
  let text: String
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      ForEach(Array(MobileMarkdownBlock.parse(text).enumerated()), id: \.offset) { _, block in
        switch block.kind {
        case .code:
          VStack(alignment: .leading) {
            HStack {
              Text("代码").font(.caption.weight(.semibold)).foregroundStyle(MobileChatStyle.codeAccent)
              Spacer()
              Button { UIPasteboard.general.setItems([["public.utf8-plain-text": block.text]], options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(120)]) } label: {
                Image(systemName: "doc.on.doc").frame(minWidth: 44, minHeight: 44)
              }.accessibilityLabel("复制代码").foregroundStyle(MobileChatStyle.codeAccent)
            }
            ScrollView(.horizontal) { Text(block.text).font(.system(.footnote, design: .monospaced)).textSelection(.enabled) }
          }.padding(.horizontal, 10).padding(.bottom, 10)
            .background(MobileChatStyle.code, in: RoundedRectangle(cornerRadius: 7))
            .overlay(alignment: .leading) {
              UnevenRoundedRectangle(topLeadingRadius: 3, bottomLeadingRadius: 3)
                .fill(MobileChatStyle.codeAccent).frame(width: 3)
            }
        case .heading(let level):
          Text(inline(block.text)).font(level == 1 ? .title3.bold() : .headline).textSelection(.enabled)
        case .text:
          Text(inline(block.text)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
        }
      }
    }
  }
  private func inline(_ value: String) -> AttributedString {
    (try? AttributedString(markdown: value, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(value)
  }
}

#if DEBUG
private enum MobileLongHistoryFixture {
  static let messages: [HermesChatMessage] = {
    let report = (0..<120).map { line in
      "## 分析项目 \(line)\n\n这是用于离线复现长消息布局的合成报告。包含**重点**、任务说明和多段正文。\n\n```text\n检查记录 \(line)\n```\n"
    }.joined()
    var result: [HermesChatMessage] = []
    for index in 0..<200 {
      let sequence = Int64(index + 1)
      let newest = ProcessInfo.processInfo.arguments.contains("--preview-long-latest")
        ? report + "\n## 长历史最新消息可见" : "长历史最新消息可见"
      let text: String = index == 199 ? newest : report
      let message = HermesChatMessage(id: "load-\(index)", sender: "agent", sentAt: sequence,
        sequence: sequence, text: text)
      result.append(message)
    }
    return result
  }()
}
#endif

#if DEBUG
private enum MobileChatStyleFixture {
  static let messages: [HermesChatMessage] = [
    HermesChatMessage(id: "style-1", sender: "client", sentAt: 1_793_250_000_000,
      sequence: 1, text: "帮我整理一下今天的工作安排。"),
    HermesChatMessage(id: "style-2", sender: "agent", sentAt: 1_793_250_060_000,
      sequence: 2, text: "## 今天的安排\n\n先把最重要的事情做好，给临时任务留一点空间。\n\n- 上午：检查服务运行情况\n- 下午：完成项目更新\n- 晚上：整理笔记与待办"),
    HermesChatMessage(id: "style-3", sender: "client", sentAt: 1_793_250_120_000,
      sequence: 3, text: "查看服务状态用什么命令？"),
    HermesChatMessage(id: "style-4", sender: "agent", sentAt: 1_793_250_180_000,
      sequence: 4, text: "可以先查看运行状态：\n\n```bash\nhermes status\n```\n\n如果有异常，把结果发给我，我们一起排查。")
  ]
}
#endif

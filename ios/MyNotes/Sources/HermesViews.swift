import SwiftUI
import NotesCore

struct MobileDraft {
  var text = ""
  var files: [URL] = []
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
        NavigationLink(value: profile) {
          HStack(spacing: 14) {
            Image(systemName: "sparkles").font(.title2).foregroundStyle(.indigo)
              .frame(width: 44, height: 44).background(.indigo.opacity(0.1), in: RoundedRectangle(cornerRadius: 14))
            VStack(alignment: .leading, spacing: 6) {
              Text(profile.label).font(.headline)
              Text(chat.isConfigured(spaceID: profile.id) ? (chat.lastMessage(spaceID: profile.id)?.text ?? "开始聊天") : "点击配置聊天密钥")
                .font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
            }
            Spacer(minLength: 0)
            if chat.unreadCount(spaceID: profile.id) > 0 {
              Text("\(chat.unreadCount(spaceID: profile.id))").font(.caption.bold()).padding(7)
                .foregroundStyle(.white).background(.indigo, in: Capsule())
            }
          }.padding(.vertical, 5)
        }.accessibilityIdentifier("profile.\(profile.id)")
          .contextMenu { Button("配置密钥", systemImage: "key") { keyProfile = profile } }
      }
    }
    .navigationTitle("Hermes")
    .overlay { if chat.profiles.isEmpty && !chat.isRefreshing { ContentUnavailableView("暂无会话", systemImage: "bubble.left.and.bubble.right", description: Text("下拉刷新，从服务器加载已配置的 Hermes profiles。")) } }
    .refreshable { await chat.refreshProfiles(); await chat.resumeTransport() }
    .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("重新连接", systemImage: "arrow.clockwise") { Task { await chat.resumeTransport() } } } }
    .navigationDestination(for: HermesChatProfile.self) { profile in ChatView(profile: profile).id(profile.id) }
    .sheet(item: $keyProfile) { profile in ProfileKeyView(profile: profile) }
    .onAppear { chat.selectProfile(nil) }
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

  private var draft: MobileDraft { model.chatDrafts[profile.id] ?? MobileDraft() }
  private var allMessages: [HermesChatMessage] { chat.messages(spaceID: profile.id) }
  private var matchingMessages: [HermesChatMessage] {
    search.isEmpty ? allMessages : allMessages.filter { $0.text.localizedCaseInsensitiveContains(search) || $0.attachments.contains { $0.name.localizedCaseInsensitiveContains(search) } }
  }
  private var messages: [HermesChatMessage] { Array(matchingMessages.suffix(limit)) }

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
        if selecting { selectionBar } else { composer }
      }
    }
    .navigationTitle(profile.label).navigationBarTitleDisplayMode(.inline)
    .searchable(text: $search, prompt: "搜索本机聊天记录")
    .onChange(of: search) { _, _ in limit = 40 }
    .toolbar {
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
    .alert("删除所选消息？", isPresented: $deleting) {
      Button("取消", role: .cancel) {}
      Button("删除", role: .destructive) {
        let targets = allMessages.filter { selected.contains($0.id) }
        Task { if await chat.deleteMessages(targets, spaceID: profile.id) { selected = []; selecting = false } }
      }
    } message: { Text("消息和附件将从云端删除，并影响其他设备。") }
    .onAppear { model.enterChat(profile.id) }
    .onDisappear { model.leaveChat(profile.id) }
  }

  private var timeline: some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 18) {
          if matchingMessages.count > limit {
            Button("加载更早的消息（还有 \(matchingMessages.count - limit) 条）") { limit += 40 }
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
        }.padding()
      }
      .scrollDismissesKeyboard(.interactively)
      .defaultScrollAnchor(.bottom)
      .overlay(alignment: .bottomTrailing) {
        if !nearBottom { Button("最新消息", systemImage: "arrow.down") { proxy.scrollTo("bottom", anchor: .bottom) }.buttonStyle(.borderedProminent).padding() }
      }
      .onChange(of: allMessages.count) { _, _ in if nearBottom && search.isEmpty { proxy.scrollTo("bottom", anchor: .bottom) } }
    }
  }

  private func messageBubble(_ message: HermesChatMessage) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        Text(message.isAgent ? "Hermes" : "你").font(.caption.bold()).foregroundStyle(.secondary)
        Spacer()
        Text(Date(timeIntervalSince1970: Double(message.sentAt) / 1000), style: .time).font(.caption2).foregroundStyle(.secondary)
      }
      if !message.text.isEmpty { MessageMarkdown(text: message.text) }
      ForEach(message.attachments) { attachment in
        Button { Task { await open(attachment) } } label: {
          HStack {
            Image(systemName: attachment.contentType.hasPrefix("image/") ? "photo" : attachment.contentType.hasPrefix("audio/") ? "waveform" : attachment.contentType.hasPrefix("video/") ? "play.rectangle" : "doc")
            VStack(alignment: .leading) {
              Text(attachment.name).lineLimit(2)
              Text(ByteCountFormatter.string(fromByteCount: Int64(attachment.plaintextBytes), countStyle: .file)).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if openingID == attachment.id { ProgressView() } else { Image(systemName: "arrow.down.circle") }
          }.padding(10).background(.background.opacity(0.7), in: RoundedRectangle(cornerRadius: 10))
        }.buttonStyle(.plain).disabled(openingID != nil)
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
    }
    .padding(14).background(message.isAgent ? Color(.secondarySystemGroupedBackground) : Color.indigo.opacity(0.09), in: RoundedRectangle(cornerRadius: 16))
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
      HStack(alignment: .bottom, spacing: 12) {
        MediaPickerMenu(includeFiles: true, onCapture: { addFiles([$0.url]) }, onFiles: addFiles).disabled(chat.isSending)
        TextField("消息或 /命令", text: Binding(get: { draft.text }, set: updateText), axis: .vertical)
          .lineLimit(1...6).padding(10).background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
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
          if chat.isSending { ProgressView() } else { Image(systemName: "arrow.up.circle.fill").font(.largeTitle) }
        }.disabled(chat.isSending || chat.connectionState != .connected || (draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && draft.files.isEmpty))
          .accessibilityLabel("发送消息").accessibilityIdentifier("chat.send")
      }
      if chat.connectionState != .connected { Text("等待连接，草稿会保留在本次运行中").font(.caption).foregroundStyle(.secondary) }
    }.padding(.horizontal).padding(.vertical, 10).background(.bar)
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
    openingID = descriptor.id
    defer { openingID = nil }
    do {
      let source = try await chat.attachmentFile(descriptor, spaceID: profile.id)
      // QL may keep a file alive while sharing; isolate previews from the encrypted cache.
      let url = try await Task.detached {
        try MobileFiles.copyPreview(source, name: descriptor.name)
      }.value
      previewURL = url; preview = MobileFile(url: url)
      if !descriptor.isPrivateR2 { try? FileManager.default.removeItem(at: source) }
    } catch { model.error = error.localizedDescription }
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
            Text(command.usage).font(.system(.body, design: .monospaced)).foregroundStyle(.indigo)
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
        blocks.append(MobileMarkdownBlock(kind: code ? .code : .text, text: lines.joined(separator: "\n")))
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

struct MessageMarkdown: View {
  let text: String
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      ForEach(Array(MobileMarkdownBlock.parse(text).enumerated()), id: \.offset) { _, block in
        switch block.kind {
        case .code:
          VStack(alignment: .leading) {
            HStack {
              Text("代码").font(.caption).foregroundStyle(.secondary)
              Spacer()
              Button("复制") { UIPasteboard.general.setItems([["public.utf8-plain-text": block.text]], options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(120)]) }.font(.caption)
            }
            ScrollView(.horizontal) { Text(block.text).font(.system(.footnote, design: .monospaced)).textSelection(.enabled) }
          }.padding(10).background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 8))
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

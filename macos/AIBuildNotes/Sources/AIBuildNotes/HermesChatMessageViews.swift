import AppKit
import AVKit
import NotesCore
import SwiftUI
import UniformTypeIdentifiers

struct HermesMessageRow: View {
  @EnvironmentObject private var store: HermesChatStore
  let message: HermesChatMessage
  let spaceID: String
  let selectionMode: Bool
  let selected: Bool
  let onToggleSelection: () -> Void
  let onBeginSelection: () -> Void
  let onDelete: () -> Void

  private var isClient: Bool { !message.isAgent }

  var body: some View {
    HStack(alignment: .bottom, spacing: 9) {
      if selectionMode {
        Button(action: onToggleSelection) {
          Image(systemName: selected ? "checkmark.circle.fill" : "circle")
            .font(.title3)
            .foregroundStyle(selected ? Color.accentColor : .secondary)
        }
        .buttonStyle(.plain)
        .help(selected ? "取消选择" : "选择消息")
      }

      if isClient { Spacer(minLength: 54) }

      VStack(alignment: .leading, spacing: 9) {
        if !message.text.isEmpty {
          HermesMarkdownMessage(text: message.text, isClient: isClient)
        }

        if !message.attachments.isEmpty {
          VStack(alignment: .leading, spacing: 8) {
            ForEach(message.attachments) { attachment in
              HermesChatAttachmentView(
                descriptor: attachment,
                spaceID: spaceID,
                isClient: isClient
              )
            }
          }
        }

        if let interaction = message.interaction {
          HermesInteractionView(message: message, interaction: interaction)
        }

        HStack(spacing: 6) {
          if message.sequence == 0 {
            Image(systemName: "clock")
              .help("正在同步到服务器")
          } else if isClient {
            Image(systemName: "checkmark.circle")
              .help("已同步")
          }
          Text(HermesChatFormat.fullTime(message.sentAt))
            .monospacedDigit()
        }
        .font(.caption2)
        .foregroundStyle(isClient ? Color.white.opacity(0.76) : Color.secondary.opacity(0.72))
      }
      .padding(.horizontal, 13)
      .padding(.vertical, 10)
      .background(bubbleColor, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
      .overlay {
        RoundedRectangle(cornerRadius: 15, style: .continuous)
          .stroke(borderColor, lineWidth: selected ? 2 : 0.7)
      }
      .contentShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
      .onTapGesture {
        if selectionMode { onToggleSelection() }
      }
      .contextMenu { messageMenu }

      if !isClient { Spacer(minLength: 54) }
    }
    .frame(maxWidth: .infinity)
    .accessibilityElement(children: .contain)
  }

  private var bubbleColor: Color {
    isClient ? Color.accentColor : Color(nsColor: .controlBackgroundColor)
  }

  private var borderColor: Color {
    if selected { return Color.accentColor }
    return isClient ? Color.white.opacity(0.12) : Color.secondary.opacity(0.16)
  }

  @ViewBuilder
  private var messageMenu: some View {
    if !message.text.isEmpty {
      Button("复制文字", systemImage: "doc.on.doc") {
        HermesDesktopActions.copy(message.text)
      }
      Button("分享文字…", systemImage: "square.and.arrow.up") {
        HermesDesktopActions.share(items: [message.text])
      }
      Button("保存为文本…", systemImage: "square.and.arrow.down") {
        HermesDesktopActions.saveText(
          message.text,
          suggestedName: "Hermes-\(HermesChatFormat.shortTime(message.sentAt).replacingOccurrences(of: ":", with: "-"))"
        )
      }
      Divider()
    }
    Button("选择多条消息", systemImage: "checklist") { onBeginSelection() }
    Button("删除消息…", systemImage: "trash", role: .destructive) { onDelete() }
      .disabled(message.sequence == 0)
  }
}

private struct HermesInteractionView: View {
  @EnvironmentObject private var store: HermesChatStore
  @State private var currentMilliseconds = Int64(Date().timeIntervalSince1970 * 1_000)
  let message: HermesChatMessage
  let interaction: HermesChatInteraction

  private var pending: Bool {
    interaction.isPending(at: currentMilliseconds)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      if let stage = interaction.stage, !stage.isEmpty {
        Text(stage)
          .font(.caption.weight(.semibold))
          .foregroundStyle(.secondary)
      }
      ForEach(optionRows.indices, id: \.self) { index in
        let row = optionRows[index]
        HStack(spacing: 7) {
          ForEach(row) { option in
            Button {
              Task { await store.chooseInteractionOption(message: message, option: option) }
            } label: {
              HStack(spacing: 6) {
                Image(systemName: option.selected ? "checkmark" : "circle.fill")
                  .font(option.selected ? .caption : .system(size: 4))
                  .opacity(option.selected ? 1 : 0)
                Text(option.label)
                  .lineLimit(2)
                  .multilineTextAlignment(.center)
              }
              .frame(maxWidth: .infinity, minHeight: 26)
            }
            .buttonStyle(.bordered)
            .tint(option.style == "danger" ? .red : .accentColor)
            .disabled(!pending || option.disabled)
          }
        }
      }
      if !pending {
        Text(statusText)
          .font(.caption2)
          .foregroundStyle(.secondary)
      } else if let pageInfo = interaction.pageInfo, !pageInfo.isEmpty {
        Text(pageInfo)
          .font(.caption2.monospacedDigit())
          .foregroundStyle(.secondary)
      }
    }
    .padding(.top, 2)
    .task(id: interaction) {
      await refreshAtExpiry()
    }
  }

  private var statusText: String {
    if let status = interaction.status, !status.isEmpty { return status }
    if interaction.isExpired(at: currentMilliseconds) { return "此操作已过期，请重新发送指令。" }
    return "此操作已经完成"
  }

  @MainActor
  private func refreshAtExpiry() async {
    currentMilliseconds = Int64(Date().timeIntervalSince1970 * 1_000)
    guard interaction.state == "pending", interaction.expiresAt > currentMilliseconds else {
      return
    }
    let delay = interaction.expiresAt - currentMilliseconds
    do {
      try await Task.sleep(for: .milliseconds(delay))
    } catch {
      return
    }
    currentMilliseconds = Int64(Date().timeIntervalSince1970 * 1_000)
  }

  private var optionRows: [[HermesChatInteractionOption]] {
    var rows: [[HermesChatInteractionOption]] = []
    var current: [HermesChatInteractionOption] = []
    for option in interaction.options {
      if option.wide {
        if !current.isEmpty {
          rows.append(current)
          current = []
        }
        rows.append([option])
      } else {
        current.append(option)
        if current.count == 2 {
          rows.append(current)
          current = []
        }
      }
    }
    if !current.isEmpty { rows.append(current) }
    return rows
  }
}

private struct HermesMarkdownMessage: View {
  let text: String
  let isClient: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 9) {
      ForEach(HermesMarkdownParser.parse(text)) { segment in
        switch segment.kind {
        case .markdown(let source):
          HermesMarkdownText(source: source, isClient: isClient)
        case .code(let language, let code):
          HermesCodeBlock(language: language, code: code, isClient: isClient)
        }
      }
    }
  }
}

private struct HermesMarkdownText: View {
  let source: String
  let isClient: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      ForEach(HermesMarkdownBlockParser.parse(source)) { block in
        switch block.kind {
        case .paragraph(let value):
          inlineText(value)
        case .heading(let level, let value):
          inlineText(value)
            .font(headingFont(level))
            .padding(.top, level <= 2 ? 2 : 0)
        case .unordered(let value):
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("•")
              .fontWeight(.bold)
            inlineText(value)
          }
          .padding(.leading, 4)
        case .ordered(let marker, let value):
          HStack(alignment: .firstTextBaseline, spacing: 7) {
            Text("\(marker).")
              .font(.body.monospacedDigit())
              .frame(minWidth: 20, alignment: .trailing)
            inlineText(value)
          }
        case .quote(let value):
          HStack(alignment: .top, spacing: 9) {
            RoundedRectangle(cornerRadius: 1.5)
              .fill(isClient ? Color.white.opacity(0.7) : Color.accentColor)
              .frame(width: 3)
            inlineText(value)
              .foregroundStyle(isClient ? Color.white.opacity(0.86) : Color.secondary)
          }
          .padding(.vertical, 2)
        case .divider:
          Divider()
            .overlay(isClient ? Color.white.opacity(0.28) : Color.secondary.opacity(0.22))
            .padding(.vertical, 2)
        }
      }
    }
  }

  private func inlineText(_ value: String) -> Text {
    if let attributed = try? AttributedString(
      markdown: value,
      options: AttributedString.MarkdownParsingOptions(
        interpretedSyntax: .inlineOnlyPreservingWhitespace,
        failurePolicy: .returnPartiallyParsedIfPossible
      )
    ) {
      return Text(attributed)
        .foregroundColor(isClient ? .white : .primary)
    }
    return Text(value)
      .foregroundColor(isClient ? .white : .primary)
  }

  private func headingFont(_ level: Int) -> Font {
    switch level {
    case 1: .title2.bold()
    case 2: .title3.bold()
    case 3: .headline
    default: .body.bold()
    }
  }
}

private enum HermesMarkdownBlockParser {
  struct Block: Identifiable {
    enum Kind {
      case paragraph(String)
      case heading(level: Int, text: String)
      case unordered(String)
      case ordered(marker: String, text: String)
      case quote(String)
      case divider
    }

    let id: Int
    let kind: Kind
  }

  static func parse(_ source: String) -> [Block] {
    var blocks: [Block] = []
    var paragraph: [String] = []
    var identifier = 0

    func append(_ kind: Block.Kind) {
      blocks.append(Block(id: identifier, kind: kind))
      identifier += 1
    }

    func flushParagraph() {
      guard !paragraph.isEmpty else { return }
      append(.paragraph(paragraph.joined(separator: "\n")))
      paragraph = []
    }

    for rawLine in source.components(separatedBy: "\n") {
      let line = rawLine.trimmingCharacters(in: .whitespaces)
      if line.isEmpty {
        flushParagraph()
        continue
      }
      if let heading = heading(line) {
        flushParagraph()
        append(.heading(level: heading.level, text: heading.text))
      } else if let item = unordered(line) {
        flushParagraph()
        append(.unordered(item))
      } else if let item = ordered(line) {
        flushParagraph()
        append(.ordered(marker: item.marker, text: item.text))
      } else if line.hasPrefix("> ") {
        flushParagraph()
        append(.quote(String(line.dropFirst(2))))
      } else if ["---", "***", "___"].contains(line) {
        flushParagraph()
        append(.divider)
      } else {
        paragraph.append(rawLine)
      }
    }
    flushParagraph()
    return blocks.isEmpty ? [Block(id: 0, kind: .paragraph(source))] : blocks
  }

  private static func heading(_ line: String) -> (level: Int, text: String)? {
    let hashes = line.prefix { $0 == "#" }
    guard (1...6).contains(hashes.count), line.dropFirst(hashes.count).hasPrefix(" ") else {
      return nil
    }
    return (hashes.count, String(line.dropFirst(hashes.count + 1)))
  }

  private static func unordered(_ line: String) -> String? {
    for prefix in ["- ", "* ", "+ "] where line.hasPrefix(prefix) {
      return String(line.dropFirst(2))
    }
    return nil
  }

  private static func ordered(_ line: String) -> (marker: String, text: String)? {
    guard let dot = line.firstIndex(of: ".") else { return nil }
    let marker = String(line[..<dot])
    let afterDot = line[line.index(after: dot)...]
    guard !marker.isEmpty, marker.allSatisfy(\.isNumber), afterDot.hasPrefix(" ") else {
      return nil
    }
    return (marker, String(afterDot.dropFirst()))
  }
}

private struct HermesCodeBlock: View {
  let language: String
  let code: String
  let isClient: Bool

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 8) {
        Text(language.isEmpty ? "代码" : language)
          .font(.caption.monospaced().weight(.semibold))
        Spacer()
        Button {
          HermesDesktopActions.copy(code)
        } label: {
          Label("复制", systemImage: "doc.on.doc")
            .font(.caption)
        }
        .buttonStyle(.plain)
        .help("复制代码块")
      }
      .foregroundStyle(isClient ? Color.white.opacity(0.82) : Color.secondary)
      .padding(.horizontal, 10)
      .frame(height: 30)
      .background(isClient ? Color.black.opacity(0.16) : Color.secondary.opacity(0.10))

      ScrollView(.horizontal, showsIndicators: true) {
        Text(code)
          .font(.system(.callout, design: .monospaced))
          .foregroundStyle(isClient ? Color.white : Color.primary)
          .textSelection(.enabled)
          .padding(10)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      .background(isClient ? Color.black.opacity(0.25) : Color(nsColor: .textBackgroundColor))
    }
    .clipShape(RoundedRectangle(cornerRadius: 9))
    .overlay {
      RoundedRectangle(cornerRadius: 9)
        .stroke(isClient ? Color.white.opacity(0.18) : Color.secondary.opacity(0.18))
    }
  }
}

private enum HermesMarkdownParser {
  struct Segment: Identifiable {
    enum Kind {
      case markdown(String)
      case code(language: String, code: String)
    }

    let id: Int
    let kind: Kind
  }

  static func parse(_ source: String) -> [Segment] {
    var result: [Segment] = []
    var remainder = source[...]
    var identifier = 0

    while let opening = remainder.range(of: "```") {
      let before = String(remainder[..<opening.lowerBound])
      if !before.isEmpty {
        result.append(Segment(id: identifier, kind: .markdown(before)))
        identifier += 1
      }

      let afterFence = remainder[opening.upperBound...]
      guard let firstNewline = afterFence.firstIndex(of: "\n") else {
        result.append(
          Segment(id: identifier, kind: .markdown(String(remainder[opening.lowerBound...])))
        )
        return result
      }
      let language = String(afterFence[..<firstNewline]).trimmingCharacters(in: .whitespaces)
      let codeStart = afterFence.index(after: firstNewline)
      guard let closing = afterFence[codeStart...].range(of: "```") else {
        result.append(
          Segment(id: identifier, kind: .markdown(String(remainder[opening.lowerBound...])))
        )
        return result
      }
      var code = String(afterFence[codeStart..<closing.lowerBound])
      if code.last == "\n" { code.removeLast() }
      result.append(Segment(id: identifier, kind: .code(language: language, code: code)))
      identifier += 1
      remainder = afterFence[closing.upperBound...]
    }

    if !remainder.isEmpty {
      result.append(Segment(id: identifier, kind: .markdown(String(remainder))))
    }
    return result.isEmpty ? [Segment(id: 0, kind: .markdown(source))] : result
  }
}

private struct HermesChatAttachmentView: View {
  @EnvironmentObject private var store: HermesChatStore
  let descriptor: HermesChatAttachmentDescriptor
  let spaceID: String
  let isClient: Bool

  @State private var imageURL: URL?
  @State private var isLoading = false
  @State private var localError: String?
  @State private var preview: HermesAttachmentPreview?

  private var kind: HermesChatAttachmentKind? {
    HermesChatAttachmentPolicy.kind(
      filename: descriptor.name,
      contentType: descriptor.contentType
    )
  }

  var body: some View {
    Button(action: openAttachment) {
      VStack(alignment: .leading, spacing: 8) {
        if kind == .image, let imageURL, let image = NSImage(contentsOf: imageURL) {
          Image(nsImage: image)
            .resizable()
            .scaledToFit()
            .frame(maxWidth: 420, maxHeight: 300)
            .clipShape(RoundedRectangle(cornerRadius: 9))
        }

        HStack(spacing: 10) {
          ZStack {
            RoundedRectangle(cornerRadius: 9)
              .fill(isClient ? Color.white.opacity(0.16) : Color.accentColor.opacity(0.12))
            if isLoading {
              ProgressView().controlSize(.small)
            } else {
              Image(
                systemName: HermesChatAttachmentPolicy.systemImage(
                  filename: descriptor.name,
                  contentType: descriptor.contentType
                )
              )
              .font(.title3)
              .foregroundStyle(isClient ? Color.white : Color.accentColor)
            }
          }
          .frame(width: 38, height: 38)

          VStack(alignment: .leading, spacing: 3) {
            Text(descriptor.name)
              .font(.callout.weight(.medium))
              .foregroundStyle(isClient ? Color.white : Color.primary)
              .lineLimit(2)
            Text(attachmentSubtitle)
              .font(.caption2)
              .foregroundStyle(isClient ? Color.white.opacity(0.72) : Color.secondary)
          }
          Spacer(minLength: 8)
          Image(systemName: actionIcon)
            .foregroundStyle(isClient ? Color.white.opacity(0.82) : Color.accentColor)
        }
      }
      .padding(9)
      .background(
        isClient ? Color.black.opacity(0.12) : Color.accentColor.opacity(0.055),
        in: RoundedRectangle(cornerRadius: 11)
      )
    }
    .buttonStyle(.plain)
    .help(actionHelp)
    .contextMenu {
      Button("打开", systemImage: "arrow.up.forward.app") { openAttachment() }
      Button("保存到 Mac…", systemImage: "square.and.arrow.down") { saveAttachment() }
      Button("分享…", systemImage: "square.and.arrow.up") { shareAttachment() }
    }
    .task(id: descriptor.id) {
      if kind == .image { await loadImagePreview() }
    }
    .sheet(item: $preview) { preview in
      switch preview.kind {
      case .image(let url):
        HermesImagePreview(
          descriptor: descriptor,
          url: url,
          onSave: saveAttachment,
          onShare: shareAttachment
        )
      case .media(let url, let audioOnly):
        HermesMediaPreview(
          descriptor: descriptor,
          url: url,
          audioOnly: audioOnly,
          onSave: saveAttachment,
          onShare: shareAttachment
        )
      }
    }
    .alert(
      "附件操作失败",
      isPresented: Binding(
        get: { localError != nil },
        set: { if !$0 { localError = nil } }
      )
    ) {
      Button("知道了") { localError = nil }
    } message: {
      Text(localError ?? "")
    }
  }

  private var attachmentSubtitle: String {
    let size = ByteCountFormatter.string(
      fromByteCount: Int64(descriptor.plaintextBytes),
      countStyle: .file
    )
    switch kind {
    case .image: return "图片 · \(size) · 点击放大"
    case .audio: return "音频 · \(size) · 点击播放"
    case .video: return "视频 · \(size) · 点击播放"
    case .document: return "文档 · \(size) · 点击打开"
    case .office: return "Office · \(size) · 点击打开"
    case .archive: return "压缩包 · \(size) · 点击打开"
    case .package: return "文件 · \(size) · 点击打开"
    case nil: return size
    }
  }

  private var actionIcon: String {
    switch kind {
    case .image: "arrow.up.left.and.arrow.down.right"
    case .audio, .video: "play.circle.fill"
    default: "arrow.down.circle"
    }
  }

  private var actionHelp: String {
    switch kind {
    case .image: "放大图片"
    case .audio, .video: "播放附件"
    default: "打开附件"
    }
  }

  private func openAttachment() {
    Task {
      do {
        switch kind {
        case .image:
          let url = try await materialize()
          imageURL = url
          preview = HermesAttachmentPreview(kind: .image(url))
        case .audio, .video:
          let url = try await materialize()
          preview = HermesAttachmentPreview(kind: .media(url, audioOnly: kind == .audio))
        default:
          let url = try await materialize()
          NSWorkspace.shared.open(url)
        }
      } catch {
        localError = error.localizedDescription
      }
    }
  }

  private func loadImagePreview() async {
    do {
      imageURL = try await materialize()
    } catch {
      // Keep the file card available; an explicit open/save will surface the error.
    }
  }

  private func saveAttachment() {
    Task {
      do {
        let url = try await materialize()
        HermesDesktopActions.saveFile(url, suggestedName: descriptor.name)
      } catch {
        localError = error.localizedDescription
      }
    }
  }

  private func shareAttachment() {
    Task {
      do {
        let url = try await materialize()
        HermesDesktopActions.share(items: [url])
      } catch {
        localError = error.localizedDescription
      }
    }
  }

  private func materialize() async throws -> URL {
    isLoading = true
    defer { isLoading = false }
    return try await store.attachmentFile(descriptor, spaceID: spaceID)
  }
}

private struct HermesAttachmentPreview: Identifiable {
  enum Kind {
    case image(URL)
    case media(URL, audioOnly: Bool)
  }

  let id = UUID()
  let kind: Kind
}

private struct HermesImagePreview: View {
  @Environment(\.dismiss) private var dismiss
  let descriptor: HermesChatAttachmentDescriptor
  let url: URL
  let onSave: () -> Void
  let onShare: () -> Void
  @State private var scale: CGFloat = 1

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 10) {
        Text(descriptor.name)
          .font(.headline)
          .lineLimit(1)
        Spacer()
        Button("分享", systemImage: "square.and.arrow.up", action: onShare)
        Button("保存", systemImage: "square.and.arrow.down", action: onSave)
        Divider().frame(height: 20)
        Button("关闭") { dismiss() }
          .keyboardShortcut(.cancelAction)
      }
      .padding(.horizontal, 16)
      .frame(height: 52)
      Divider()

      if let image = NSImage(contentsOf: url) {
        GeometryReader { geometry in
          let viewportSize = geometry.size
          let fittedSize = fittedImageSize(imageSize: image.size, in: viewportSize)
          let zoomedSize = CGSize(
            width: fittedSize.width * scale,
            height: fittedSize.height * scale
          )

          ScrollView([.horizontal, .vertical]) {
            Image(nsImage: image)
              .resizable()
              .aspectRatio(contentMode: .fit)
              .frame(width: zoomedSize.width, height: zoomedSize.height)
              .padding(24)
              .frame(
                minWidth: viewportSize.width,
                minHeight: viewportSize.height,
                alignment: .center
              )
          }
          .background(Color.black.opacity(0.94))
        }
      } else {
        ContentUnavailableView("无法预览图片", systemImage: "photo.badge.exclamationmark")
      }

      HStack(spacing: 10) {
        Button {
          scale = max(0.5, scale / 1.25)
        } label: {
          Image(systemName: "minus.magnifyingglass")
        }
        Slider(value: $scale, in: 0.5...4)
          .frame(width: 180)
        Text("\(Int(scale * 100))%")
          .font(.caption.monospacedDigit())
          .frame(width: 46, alignment: .trailing)
        Button {
          scale = min(4, scale * 1.25)
        } label: {
          Image(systemName: "plus.magnifyingglass")
        }
        Button("适合窗口") { scale = 1 }
      }
      .padding(12)
    }
    .frame(minWidth: 760, minHeight: 600)
  }

  private func fittedImageSize(imageSize: CGSize, in viewportSize: CGSize) -> CGSize {
    let availableSize = CGSize(
      width: max(1, viewportSize.width - 48),
      height: max(1, viewportSize.height - 48)
    )
    guard imageSize.width > 0, imageSize.height > 0 else { return availableSize }

    let widthScale = availableSize.width / imageSize.width
    let heightScale = availableSize.height / imageSize.height
    let fitScale = min(widthScale, heightScale)
    return CGSize(
      width: imageSize.width * fitScale,
      height: imageSize.height * fitScale
    )
  }
}

private struct HermesMediaPreview: View {
  @Environment(\.dismiss) private var dismiss
  let descriptor: HermesChatAttachmentDescriptor
  let url: URL
  let audioOnly: Bool
  let onSave: () -> Void
  let onShare: () -> Void
  @StateObject private var playback: HermesMediaPlaybackController

  init(
    descriptor: HermesChatAttachmentDescriptor,
    url: URL,
    audioOnly: Bool,
    onSave: @escaping () -> Void,
    onShare: @escaping () -> Void
  ) {
    self.descriptor = descriptor
    self.url = url
    self.audioOnly = audioOnly
    self.onSave = onSave
    self.onShare = onShare
    _playback = StateObject(wrappedValue: HermesMediaPlaybackController(url: url))
  }

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 10) {
        Text(descriptor.name)
          .font(.headline)
          .lineLimit(1)
        Spacer()
        Button("分享", systemImage: "square.and.arrow.up", action: onShare)
        Button("保存", systemImage: "square.and.arrow.down", action: onSave)
        Divider().frame(height: 20)
        Button("关闭") { dismiss() }
          .keyboardShortcut(.cancelAction)
      }
      .padding(.horizontal, 16)
      .frame(height: 52)
      Divider()

      ZStack {
        Color.black.opacity(0.94)
        HermesAVPlayerView(player: playback.player)
        if audioOnly {
          VStack(spacing: 18) {
            Image(systemName: "waveform.circle.fill")
              .font(.system(size: 92))
              .foregroundStyle(Color.accentColor)
            Text("音频")
              .font(.title2.bold())
              .foregroundStyle(.white)
          }
          .padding(.bottom, 64)
          .allowsHitTesting(false)
        }
      }
    }
    .frame(minWidth: 720, minHeight: audioOnly ? 420 : 560)
    .onAppear { playback.play() }
    .onDisappear { playback.stop() }
  }
}

@MainActor
private final class HermesMediaPlaybackController: ObservableObject {
  let player: AVPlayer

  init(url: URL) {
    player = AVPlayer(url: url)
  }

  func play() {
    player.play()
  }

  func stop() {
    player.pause()
    player.replaceCurrentItem(with: nil)
  }
}

/// Uses AppKit's stable player view directly. This avoids loading the
/// `_AVKit_SwiftUI` representable that aborts while constructing its generic
/// view metadata on macOS 26.5.x.
private struct HermesAVPlayerView: NSViewRepresentable {
  let player: AVPlayer

  func makeNSView(context: Context) -> AVPlayerView {
    let view = AVPlayerView(frame: .zero)
    view.controlsStyle = .floating
    view.videoGravity = .resizeAspect
    view.player = player
    return view
  }

  func updateNSView(_ view: AVPlayerView, context: Context) {
    if view.player !== player {
      view.player = player
    }
  }

  static func dismantleNSView(_ view: AVPlayerView, coordinator: ()) {
    view.player?.pause()
    view.player = nil
  }
}

@MainActor
enum HermesDesktopActions {
  static func copy(_ text: String) {
    let pasteboard = NSPasteboard.general
    pasteboard.clearContents()
    pasteboard.setString(text, forType: .string)
  }

  static func share(items: [Any]) {
    guard !items.isEmpty, let view = NSApp.keyWindow?.contentView else { return }
    let picker = NSSharingServicePicker(items: items)
    picker.show(relativeTo: view.bounds, of: view, preferredEdge: .minY)
  }

  static func saveText(_ text: String, suggestedName: String) {
    saveData(Data(text.utf8), suggestedName: "\(suggestedName).txt")
  }

  static func saveData(_ data: Data, suggestedName: String) {
    let panel = NSSavePanel()
    panel.nameFieldStringValue = URL(fileURLWithPath: suggestedName).lastPathComponent
    panel.canCreateDirectories = true
    guard panel.runModal() == .OK, let url = panel.url else { return }
    do {
      try data.write(to: url, options: .atomic)
    } catch {
      NSAlert(error: error).runModal()
    }
  }

  static func saveFile(_ source: URL, suggestedName: String) {
    let panel = NSSavePanel()
    panel.nameFieldStringValue = URL(fileURLWithPath: suggestedName).lastPathComponent
    panel.canCreateDirectories = true
    guard panel.runModal() == .OK, let destination = panel.url else { return }
    do {
      try? FileManager.default.removeItem(at: destination)
      try FileManager.default.copyItem(at: source, to: destination)
    } catch {
      NSAlert(error: error).runModal()
    }
  }
}

enum HermesTemporaryAttachmentFiles {
  private static let maximumAge: TimeInterval = 24 * 60 * 60

  static func cleanupExpired(now: Date = Date()) {
    let manager = FileManager.default
    let root = manager.temporaryDirectory
      .appendingPathComponent("MyNotes-Hermes", isDirectory: true)
    guard let enumerator = manager.enumerator(
      at: root,
      includingPropertiesForKeys: [.contentModificationDateKey, .isRegularFileKey],
      options: [.skipsHiddenFiles]
    ) else { return }
    let cutoff = now.addingTimeInterval(-maximumAge)
    for case let url as URL in enumerator {
      guard let values = try? url.resourceValues(forKeys: [
        .contentModificationDateKey,
        .isRegularFileKey,
      ]),
        values.isRegularFile == true,
        let modified = values.contentModificationDate,
        modified < cutoff
      else { continue }
      try? manager.removeItem(at: url)
    }
  }

  static func write(
    _ data: Data,
    descriptor: HermesChatAttachmentDescriptor,
    spaceID: String
  ) throws -> URL {
    cleanupExpired()
    let base = FileManager.default.temporaryDirectory
      .appendingPathComponent("MyNotes-Hermes", isDirectory: true)
      .appendingPathComponent(spaceID, isDirectory: true)
    try FileManager.default.createDirectory(
      at: base,
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700]
    )
    let filename = URL(fileURLWithPath: descriptor.name).lastPathComponent
    let url = base.appendingPathComponent("\(descriptor.id)-\(filename)", isDirectory: false)
    try data.write(to: url, options: [.atomic])
    try? FileManager.default.setAttributes(
      [.posixPermissions: 0o600],
      ofItemAtPath: url.path
    )
    return url
  }
}

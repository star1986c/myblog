import SwiftUI
import ImageIO
import NotesCore

/// Owned by a conversation view; bounded, memory-only and never shared between profiles.
actor MobileThumbnailCache {
  private let images = NSCache<NSString, CGImage>()
  init() {
    images.countLimit = 40
    images.totalCostLimit = 24 * 1024 * 1024
  }
  func cached(key: String) -> CGImage? { images.object(forKey: key as NSString) }
  func image(data: Data, key: String) -> CGImage? {
    decode(CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary), key: key)
  }
  func image(at url: URL, key: String) -> CGImage? {
    decode(CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary), key: key)
  }
  private func decode(_ source: CGImageSource?, key: String) -> CGImage? {
    if let image = cached(key: key) { return image }
    guard let source, let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceShouldCacheImmediately: true,
      kCGImageSourceThumbnailMaxPixelSize: 840,
    ] as CFDictionary) else { return nil }
    images.setObject(image, forKey: key as NSString, cost: image.bytesPerRow * image.height)
    return image
  }
}

struct MobileChatAttachment: View {
  let descriptor: HermesChatAttachmentDescriptor
  let isOpening: Bool
  let loadThumbnail: @MainActor () async throws -> CGImage?
  let open: () -> Void
  @State private var thumbnail: CGImage?
  @State private var loading = false
  private var isImage: Bool {
    HermesChatAttachmentPolicy.kind(filename: descriptor.name, contentType: descriptor.contentType) == .image
  }

  var body: some View {
    Button(action: open) {
      VStack(alignment: .leading, spacing: 8) {
        if isImage {
          if let thumbnail {
            Image(decorative: thumbnail, scale: 2).resizable().scaledToFit()
              .frame(maxWidth: .infinity, maxHeight: 220)
              .clipShape(RoundedRectangle(cornerRadius: 10))
              .accessibilityLabel("图片预览：\(descriptor.name)")
              .accessibilityIdentifier("attachment.thumbnail.\(descriptor.id)")
          } else {
            HStack {
              if loading { ProgressView() }
              Text(loading ? "正在加载图片…" : "轻点查看图片").font(.caption).foregroundStyle(.secondary)
            }.frame(maxWidth: .infinity, minHeight: 100)
          }
        }
        HStack {
          Image(systemName: HermesChatAttachmentPolicy.systemImage(filename: descriptor.name, contentType: descriptor.contentType))
          VStack(alignment: .leading) {
            Text(descriptor.name).lineLimit(2)
            Text(ByteCountFormatter.string(fromByteCount: Int64(descriptor.plaintextBytes), countStyle: .file))
              .font(.caption).foregroundStyle(.secondary)
          }
          Spacer()
          if isOpening { ProgressView() } else { Image(systemName: "arrow.up.forward.square") }
        }
      }.padding(10).background(.background.opacity(0.7), in: RoundedRectangle(cornerRadius: 10))
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("attachment.open.\(descriptor.id)")
    .accessibilityValue(thumbnail == nil ? "" : "图片预览已加载")
    .task(id: descriptor) {
      thumbnail = nil
      guard isImage else { return }
      loading = true
      defer { loading = false }
      do {
        let image = try await loadThumbnail()
        guard !Task.isCancelled else { return }
        thumbnail = image
      } catch { /* Keep the original attachment available for an explicit retry/open. */ }
    }
  }
}

#if DEBUG
/// Synthetic media used only by --preview-attachments; no production account or network.
@MainActor
enum MobileAttachmentFixtures {
  static let photo = HermesChatAttachmentDescriptor(id: "preview-photo", name: "照片.png", contentType: "image/png", plaintextBytes: 1024)
  static let document = HermesChatAttachmentDescriptor(id: "preview-document", name: "说明.txt", contentType: "text/plain", plaintextBytes: 64)
  static let received = HermesChatAttachmentDescriptor(id: "preview-received", name: "收到的图片.png", contentType: "application/octet-stream", plaintextBytes: 1024)
  static func messages(spaceID: String) -> [HermesChatMessage] {
    spaceID == "primary" ? [
      HermesChatMessage(id: "preview-media", sender: "client", sentAt: 1_787_100_000_000, sequence: 1,
        text: "图片和文件预览测试", attachments: [photo, document])
    ] : [HermesChatMessage(id: "preview-received-media", sender: "agent", sentAt: 1_787_100_000_000, sequence: 1,
        text: "收到的图片", attachments: [received])]
  }
  static func data(_ descriptor: HermesChatAttachmentDescriptor) throws -> Data {
    if descriptor == document { return Data("附件预览后应能返回聊天。".utf8) }
    guard descriptor == photo || descriptor == received else { throw MediaError.message("未知演示附件。") }
    let image = UIGraphicsImageRenderer(size: CGSize(width: 720, height: 400)).image { context in
      UIColor.systemTeal.setFill(); context.fill(CGRect(x: 0, y: 0, width: 720, height: 400))
      UIColor.systemYellow.setFill(); context.cgContext.fillEllipse(in: CGRect(x: 480, y: 40, width: 110, height: 110))
      UIColor.systemIndigo.setFill(); context.fill(CGRect(x: 0, y: 270, width: 720, height: 130))
    }
    return image.pngData()!
  }
  static func file(_ descriptor: HermesChatAttachmentDescriptor) throws -> URL {
    try MobileFiles.write(data(descriptor), name: descriptor.name)
  }
}
#endif

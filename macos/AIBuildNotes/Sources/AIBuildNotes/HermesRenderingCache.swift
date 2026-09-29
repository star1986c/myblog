import Foundation
import ImageIO

/// Memory-only, bounded caches: no plaintext messages are written to disk.
@MainActor
final class HermesRenderCache<Value> {
  private final class Entry: NSObject {
    let value: Value
    init(_ value: Value) { self.value = value }
  }

  private let entries = NSCache<NSString, Entry>()

  init() {
    entries.countLimit = 512
    entries.totalCostLimit = 8 * 1024 * 1024
  }

  func value(for source: String, make: () -> Value) -> Value {
    let key = source as NSString
    if let entry = entries.object(forKey: key) { return entry.value }
    let value = make()
    entries.setObject(Entry(value), forKey: key, cost: source.utf8.count * 4)
    return value
  }
}

@MainActor
enum HermesInlineMarkdownCache {
  private static let cache = HermesRenderCache<AttributedString>()

  static func value(for source: String) -> AttributedString {
    cache.value(for: source) {
      (try? AttributedString(
        markdown: source,
        options: .init(
          interpretedSyntax: .inlineOnlyPreservingWhitespace,
          failurePolicy: .returnPartiallyParsedIfPossible
        )
      )) ?? AttributedString(source)
    }
  }
}

/// ImageIO decodes a display-sized image on this actor, away from the main actor.
/// Opening or saving an attachment still uses its original file.
actor HermesThumbnailCache {
  static let shared = HermesThumbnailCache()
  private let images = NSCache<NSURL, CGImage>()

  init() {
    images.countLimit = 64
    images.totalCostLimit = 32 * 1024 * 1024
  }

  func image(at url: URL) -> CGImage? {
    if let image = images.object(forKey: url as NSURL) { return image }
    guard let source = CGImageSourceCreateWithURL(
      url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary
    ), let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceShouldCacheImmediately: true,
      kCGImageSourceThumbnailMaxPixelSize: 840,
    ] as CFDictionary) else { return nil }
    images.setObject(image, forKey: url as NSURL, cost: image.bytesPerRow * image.height)
    return image
  }
}

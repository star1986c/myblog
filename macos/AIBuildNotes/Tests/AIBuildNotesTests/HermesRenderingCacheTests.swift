import AppKit
import ImageIO
import Testing
import UniformTypeIdentifiers

@testable import AIBuildNotes

struct HermesRenderingCacheTests {
  @Test @MainActor
  func reusesUnchangedTextButReparsesStreamingUpdates() {
    let cache = HermesRenderCache<String>()
    var parses = 0
    func render(_ source: String) -> String {
      cache.value(for: source) { parses += 1; return source.uppercased() }
    }
    #expect(render("first") == "FIRST")
    #expect(render("first") == "FIRST")
    #expect(parses == 1)
    #expect(render("first second") == "FIRST SECOND")
    #expect(parses == 2)
  }

  @Test @MainActor
  func cachedMarkdownPreservesStylesLinksAndLineBreaks() {
    let source = "**bold**\n[link](https://example.com) `code`"
    let value = HermesInlineMarkdownCache.value(for: source)
    #expect(String(value.characters) == "bold\nlink code")
    #expect(value.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
    #expect(value.runs.contains { $0.link == URL(string: "https://example.com") })
    #expect(value.runs.contains { $0.inlinePresentationIntent?.contains(.code) == true })
    #expect(HermesInlineMarkdownCache.value(for: source) == value)
  }

  @Test
  func largeImagesAreDownsampledAndReusedWithoutChangingTheFile() async throws {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".png")
    defer { try? FileManager.default.removeItem(at: url) }
    let cache = HermesThumbnailCache()
    #expect(await cache.image(at: url) == nil)
    let context = try #require(CGContext(
      data: nil, width: 2400, height: 1200, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ))
    let original = try #require(context.makeImage())
    let destination = try #require(CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil))
    CGImageDestinationAddImage(destination, original, nil)
    #expect(CGImageDestinationFinalize(destination))
    let thumbnail = try #require(await cache.image(at: url))
    #expect(thumbnail.width == 840)
    #expect(thumbnail.height == 420)
    let reused = try #require(await cache.image(at: url))
    #expect(reused === thumbnail)
    let source = try #require(CGImageSourceCreateWithURL(url as CFURL, nil))
    let unchanged = try #require(CGImageSourceCreateImageAtIndex(source, 0, nil))
    #expect(unchanged.width == 2400)
    #expect(unchanged.height == 1200)
  }

}

import XCTest
import UIKit
import NotesCore
@testable import MyNotes

@MainActor
final class MobileFilesTests: XCTestCase {
  func testMarkdownKeepsCodeLiteralAndHandlesIncompleteStreamingFence() {
    let blocks = MobileMarkdownBlock.parse("## Heading\n- item\n```swift\n# literal\nlet value = 1")
    XCTAssertEqual(blocks, [MobileMarkdownBlock(kind: .heading(2), text: "Heading"), MobileMarkdownBlock(kind: .text, text: "• item"), MobileMarkdownBlock(kind: .code, text: "# literal\nlet value = 1")])
    XCTAssertEqual(MobileMarkdownBlock.parse("before\n```\nbody\n```\nafter").map(\.text), ["before", "body", "after"])
  }

  func testPhotoNormalizesOrientationAndFitsUploadBudget() throws {
    let image = UIGraphicsImageRenderer(size: CGSize(width: 3000, height: 1000)).image { context in
      UIColor.systemIndigo.setFill(); context.fill(CGRect(x: 0, y: 0, width: 3000, height: 1000))
    }
    let media = try MobileFiles.photo(image)
    defer { MobileFiles.remove(media.url) }
    XCTAssertEqual(media.contentType, "image/jpeg")
    XCTAssertEqual(media.width, 2560)
    XCTAssertLessThanOrEqual(try Data(contentsOf: media.url).count, AttachmentCrypto.maxPlaintextBytes)
    XCTAssertNotNil(UIImage(contentsOfFile: media.url.path))
  }

  func testRejectsUnsupportedAndOversizedImportsAndSanitizesExportName() throws {
    let bad = try MobileFiles.write(Data([1]), name: "payload.exe")
    defer { MobileFiles.remove(bad) }
    XCTAssertThrowsError(try MobileFiles.importFile(bad))
    let large = try MobileFiles.write(Data(repeating: 0, count: HermesChatCrypto.maximumAttachmentBytes + 1), name: "large.pdf")
    defer { MobileFiles.remove(large) }
    XCTAssertThrowsError(try MobileFiles.importFile(large))
    let safe = try MobileFiles.write(Data([2]), name: "../../document.pdf")
    defer { MobileFiles.remove(safe) }
    XCTAssertEqual(safe.lastPathComponent, "document.pdf")
    XCTAssertTrue(safe.path.hasPrefix(MobileFiles.root.path + "/"))
    let copy = try MobileFiles.importFile(safe)
    defer { MobileFiles.remove(copy) }
    XCTAssertEqual(try Data(contentsOf: copy), Data([2]))
  }
}

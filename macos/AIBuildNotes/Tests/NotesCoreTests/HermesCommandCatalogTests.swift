import Foundation
import Testing

@testable import NotesCore

@Test("macOS exposes the same Hermes command names as Android")
func hermesCommandCatalogMatchesAndroidBaseline() {
  let expected = [
    "help", "commands", "status", "model", "sessions", "stop", "new", "reset",
    "retry", "undo", "title", "resume", "compress", "branch", "background", "queue",
    "steer", "agents", "context", "personality", "fast", "reasoning", "footer",
    "codex-runtime", "goal", "subgoal", "heartbeat", "suggestions", "curator",
    "blueprint", "usage", "whoami", "insights", "egress", "diff", "rollback",
    "reload-mcp", "reload-skills", "platform", "debug", "update", "restart", "approve",
    "deny", "yolo",
  ]

  #expect(HermesCommandCatalog.all.map(\.name) == expected)
  #expect(HermesCommandCatalog.featured.map(\.name).contains("reset"))
  #expect(HermesCommandCatalog.suggestions(for: "/res").first?.name == "reset")
  #expect(HermesCommandCatalog.suggestions(for: "普通消息").isEmpty)
}

@Test("macOS supports the complete Android Hermes attachment extension baseline")
func hermesAttachmentPolicyMatchesAndroidBaseline() {
  let supported = Set(
    HermesChatAttachmentPolicy.supportedExtensions.values.flatMap { $0 }
  )
  let expectedSource = [
    "png jpg jpeg gif webp bmp tif tiff svg",
    "mp3 wav ogg m4a opus flac aac",
    "mp4 mov webm mkv avi",
    "pdf txt md csv json xml html yaml yml log",
    "doc docx xls xlsx ppt pptx odt ods odp",
    "zip rar 7z tar gz bz2 epub apk ipa",
  ].joined(separator: " ")
  let expected = Set(expectedSource.split(separator: " ").map(String.init))

  #expect(supported == expected)
  #expect(HermesChatAttachmentPolicy.kind(filename: "report.xlsx") == .office)
  #expect(HermesChatAttachmentPolicy.kind(filename: "camera.mp4") == .video)
  #expect(HermesChatAttachmentPolicy.kind(filename: "unsafe.exe") == nil)
}

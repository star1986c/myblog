import Testing

@testable import NotesCore

@Test("Search matches both note titles and bodies")
func searchesTitleAndBody() {
  let envelope = EncryptedNoteEnvelope(
    id: "note_12345678",
    folderId: "folder_12345678",
    version: 1,
    ciphertext: "ciphertext",
    nonce: "nonce"
  )
  let document = NoteDocument(
    envelope: envelope,
    content: NoteContent(title: "服务器配置", content: "SwiftUI client notes")
  )

  #expect(document.matches(search: "服务器"))
  #expect(document.matches(search: "swiftui"))
  #expect(!document.matches(search: "待办"))
  #expect(document.belongs(to: "folder_12345678"))
  #expect(!document.belongs(to: nil))
}

@Test("Empty titles normalize without changing body whitespace")
func normalizesEmptyTitle() {
  let content = NoteContent(title: "  ", content: "  secret\n").normalized()
  #expect(content.title == "无标题笔记")
  #expect(content.content == "  secret\n")
}

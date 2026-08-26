import AppKit
import SwiftUI
import Testing

@testable import AIBuildNotes

@Suite("Hermes message editor", .serialized)
@MainActor
struct HermesMessageEditorTests {
  @Test("Return and keypad Enter submit without inserting a newline", arguments: [UInt16(36), 76])
  func returnSubmits(keyCode: UInt16) throws {
    let editor = makeEditor("hello")
    var submissions = 0
    editor.onSubmit = { submissions += 1 }

    editor.keyDown(with: try returnEvent(keyCode: keyCode))

    #expect(submissions == 1)
    #expect(editor.string == "hello")
  }

  @Test("Command Return remains a send shortcut")
  func commandReturnSubmits() throws {
    let editor = makeEditor("hello")
    var submissions = 0
    editor.onSubmit = { submissions += 1 }

    editor.keyDown(with: try returnEvent(modifiers: .command))

    #expect(submissions == 1)
    #expect(editor.string == "hello")
  }

  @Test("Shift Return inserts a newline at the selection without submitting")
  func shiftReturnInsertsNewline() throws {
    let editor = makeEditor("first middle last")
    editor.setSelectedRange(NSRange(location: 6, length: 6))
    var submissions = 0
    editor.onSubmit = { submissions += 1 }

    editor.keyDown(with: try returnEvent(modifiers: .shift))

    #expect(submissions == 0)
    #expect(editor.string == "first \n last")
  }

  @Test("Option Return keeps native multiline editing")
  func optionReturnInsertsNewline() throws {
    let editor = makeEditor("first")
    var submissions = 0
    editor.onSubmit = { submissions += 1 }

    editor.keyDown(with: try returnEvent(modifiers: .option))

    #expect(submissions == 0)
    #expect(editor.string == "first\n")
  }

  @Test("Return used for marked text never submits a message")
  func markedTextDoesNotSubmit() throws {
    let editor = makeEditor("")
    editor.setMarkedText(
      "nihao",
      selectedRange: NSRange(location: 5, length: 0),
      replacementRange: NSRange(location: NSNotFound, length: 0)
    )
    #expect(editor.hasMarkedText())
    var submissions = 0
    editor.onSubmit = { submissions += 1 }

    editor.keyDown(with: try returnEvent())

    #expect(submissions == 0)
  }

  @Test("Holding Return does not submit repeatedly")
  func repeatedReturnDoesNotSubmit() throws {
    let editor = makeEditor("hello")
    var submissions = 0
    editor.onSubmit = { submissions += 1 }

    editor.keyDown(with: try returnEvent(isARepeat: true))

    #expect(submissions == 0)
    #expect(editor.string == "hello")
  }

  @Test("Pasted multiline text is preserved without submitting")
  func multilineInsertionDoesNotSubmit() {
    let editor = makeEditor("")
    var submissions = 0
    editor.onSubmit = { submissions += 1 }

    editor.insertText("first\nsecond", replacementRange: NSRange(location: 0, length: 0))

    #expect(submissions == 0)
    #expect(editor.string == "first\nsecond")
  }

  @Test("Binding updates do not discard uncommitted IME text")
  func bindingUpdatePreservesMarkedText() {
    let editor = makeEditor("before")
    editor.setMarkedText(
      "nihao",
      selectedRange: NSRange(location: 5, length: 0),
      replacementRange: NSRange(location: NSNotFound, length: 0)
    )

    editor.synchronizeText("before")

    #expect(editor.hasMarkedText())
    #expect(editor.string == "beforenihao")
  }

  @Test("Unchanged binding updates preserve normal typing undo")
  func unchangedBindingPreservesUndo() throws {
    let editor = makeEditor("")
    editor.insertText("hello", replacementRange: NSRange(location: 0, length: 0))
    editor.breakUndoCoalescing()

    editor.synchronizeText("hello")
    let undoManager = try #require(editor.undoManager)
    #expect(undoManager.canUndo)
    let undoItem = NSMenuItem(title: "Undo", action: #selector(editor.undo(_:)), keyEquivalent: "z")
    let redoItem = NSMenuItem(title: "Redo", action: #selector(editor.redo(_:)), keyEquivalent: "Z")
    #expect(editor.validateMenuItem(undoItem))
    #expect(!editor.validateMenuItem(redoItem))
    editor.undo(nil)

    #expect(editor.string.isEmpty)
    #expect(!editor.validateMenuItem(undoItem))
    #expect(editor.validateMenuItem(redoItem))
    editor.redo(nil)
    #expect(editor.string == "hello")
  }

  @Test("Clearing a sent draft or inserting a command removes stale undo ranges", arguments: ["", "/status"])
  func changedBindingClearsUndo(replacement: String) throws {
    let editor = makeEditor("")
    editor.insertText("hello", replacementRange: NSRange(location: 0, length: 0))
    editor.breakUndoCoalescing()
    let undoManager = try #require(editor.undoManager)
    #expect(undoManager.canUndo)

    editor.synchronizeText(replacement)

    #expect(editor.string == replacement)
    #expect(!undoManager.canUndo)
    #expect(editor.selectedRange().location == (replacement as NSString).length)
  }

  @Test("Removing one composer clears its undo actions without affecting another editor")
  func removingComposerClearsOnlyItsOwnUndo() throws {
    let editor = makeEditor("")
    let otherEditor = makeEditor("")
    editor.insertText("first", replacementRange: NSRange(location: 0, length: 0))
    otherEditor.insertText("second", replacementRange: NSRange(location: 0, length: 0))
    editor.breakUndoCoalescing()
    otherEditor.breakUndoCoalescing()
    let undoManager = try #require(editor.undoManager)
    let otherUndoManager = try #require(otherEditor.undoManager)
    #expect(undoManager.canUndo)
    let scrollView = NSScrollView()
    scrollView.documentView = editor
    let coordinator = HermesMessageEditor(
      text: .constant("first"), isFocused: .constant(false), onSubmit: {}
    ).makeCoordinator()

    HermesMessageEditor.dismantleNSView(scrollView, coordinator: coordinator)

    #expect(!undoManager.canUndo)
    #expect(otherUndoManager.canUndo)
    otherUndoManager.undo()
    #expect(otherEditor.string.isEmpty)
  }

  private func makeEditor(_ text: String) -> HermesMessageTextView {
    _ = NSApplication.shared
    let editor = HermesMessageTextView(frame: NSRect(x: 0, y: 0, width: 400, height: 100))
    editor.isRichText = false
    editor.allowsUndo = true
    editor.string = text
    editor.setSelectedRange(NSRange(location: (text as NSString).length, length: 0))
    return editor
  }

  private func returnEvent(
    keyCode: UInt16 = 36,
    modifiers: NSEvent.ModifierFlags = [],
    isARepeat: Bool = false
  ) throws -> NSEvent {
    try #require(
      NSEvent.keyEvent(
        with: .keyDown,
        location: .zero,
        modifierFlags: modifiers,
        timestamp: 0,
        windowNumber: 0,
        context: nil,
        characters: keyCode == 76 ? "\u{3}" : "\r",
        charactersIgnoringModifiers: keyCode == 76 ? "\u{3}" : "\r",
        isARepeat: isARepeat,
        keyCode: keyCode
      )
    )
  }
}

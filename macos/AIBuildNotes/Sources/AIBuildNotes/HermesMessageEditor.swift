import AppKit
import SwiftUI

struct HermesMessageEditor: NSViewRepresentable {
  @Binding var text: String
  @Binding var isFocused: Bool
  var onSubmit: () -> Void

  func makeCoordinator() -> Coordinator {
    Coordinator(self)
  }

  func makeNSView(context: Context) -> NSScrollView {
    let scrollView = NSScrollView()
    scrollView.drawsBackground = false
    scrollView.hasVerticalScroller = true
    scrollView.autohidesScrollers = true

    let editor = HermesMessageTextView()
    editor.isRichText = false
    editor.importsGraphics = false
    editor.allowsUndo = true
    editor.drawsBackground = false
    editor.font = .preferredFont(forTextStyle: .body)
    editor.textColor = .textColor
    editor.textContainerInset = NSSize(width: 0, height: 8)
    editor.isVerticallyResizable = true
    editor.isHorizontallyResizable = false
    editor.autoresizingMask = [.width]
    editor.textContainer?.widthTracksTextView = true
    editor.textContainer?.containerSize = NSSize(
      width: 0, height: CGFloat.greatestFiniteMagnitude
    )
    editor.string = text
    editor.delegate = context.coordinator
    editor.onSubmit = onSubmit
    editor.onFocusChange = { [weak coordinator = context.coordinator, weak editor] in
      // AppKit can change focus during a SwiftUI update. Publish it on the next turn.
      Task { @MainActor in
        guard let coordinator, let editor, let window = editor.window else { return }
        coordinator.parent.isFocused = window.firstResponder === editor
      }
    }
    scrollView.documentView = editor
    return scrollView
  }

  func updateNSView(_ scrollView: NSScrollView, context: Context) {
    guard let editor = scrollView.documentView as? HermesMessageTextView else { return }
    context.coordinator.parent = self
    editor.onSubmit = onSubmit
    editor.synchronizeText(text)

    guard context.coordinator.requestedFocus != isFocused else { return }
    context.coordinator.requestedFocus = isFocused
    Task { @MainActor [weak coordinator = context.coordinator, weak editor] in
      guard let coordinator, let editor, let window = editor.window else { return }
      if coordinator.parent.isFocused {
        if window.firstResponder !== editor { window.makeFirstResponder(editor) }
      } else if window.firstResponder === editor {
        window.makeFirstResponder(nil)
      }
    }
  }

  static func dismantleNSView(_ scrollView: NSScrollView, coordinator: Coordinator) {
    guard let editor = scrollView.documentView as? HermesMessageTextView else { return }
    editor.breakUndoCoalescing()
    editor.undoManager?.removeAllActions()
    editor.delegate = nil
    editor.onSubmit = nil
    editor.onFocusChange = nil
  }

  @MainActor
  final class Coordinator: NSObject, NSTextViewDelegate {
    var parent: HermesMessageEditor
    var requestedFocus = false

    init(_ parent: HermesMessageEditor) {
      self.parent = parent
    }

    func textDidChange(_ notification: Notification) {
      guard let editor = notification.object as? NSTextView else { return }
      parent.text = editor.string
    }
  }
}

final class HermesMessageTextView: NSTextView {
  var onSubmit: (() -> Void)?
  var onFocusChange: (() -> Void)?
  private let textUndoManager = UndoManager()

  override var undoManager: UndoManager? { textUndoManager }

  @objc func undo(_ sender: Any?) {
    breakUndoCoalescing()
    if textUndoManager.canUndo { textUndoManager.undo() }
  }

  @objc func redo(_ sender: Any?) {
    if textUndoManager.canRedo { textUndoManager.redo() }
  }

  override func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
    if menuItem.action == #selector(undo(_:)) { return textUndoManager.canUndo }
    if menuItem.action == #selector(redo(_:)) { return textUndoManager.canRedo }
    return super.validateMenuItem(menuItem)
  }

  func synchronizeText(_ text: String) {
    // Marked text is not yet committed to the binding; unrelated redraws must leave it alone.
    guard !hasMarkedText(), string != text else { return }
    // Sent drafts and inserted commands must not leave undo ranges for the previous string.
    breakUndoCoalescing()
    textUndoManager.removeAllActions()
    string = text
    setSelectedRange(NSRange(location: (text as NSString).length, length: 0))
  }

  override func keyDown(with event: NSEvent) {
    let modifiers = event.modifierFlags.intersection([.shift, .control, .option, .command])
    let isReturn = event.keyCode == 36 || event.keyCode == 76
    if isReturn, !hasMarkedText(), modifiers.isEmpty || modifiers == .command {
      // A held Return must not repeatedly send; IME confirmation stays with AppKit.
      if !event.isARepeat { onSubmit?() }
      return
    }
    super.keyDown(with: event)
  }

  override func becomeFirstResponder() -> Bool {
    let accepted = super.becomeFirstResponder()
    if accepted { onFocusChange?() }
    return accepted
  }

  override func resignFirstResponder() -> Bool {
    let accepted = super.resignFirstResponder()
    if accepted { onFocusChange?() }
    return accepted
  }
}

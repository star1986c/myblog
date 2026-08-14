import NotesCore
import SwiftUI

@main
struct AIBuildNotesApp: App {
  #if DEBUG
    @StateObject private var store = NotesStore.preview()
  #else
    @StateObject private var store = NotesStore()
  #endif

  var body: some Scene {
    WindowGroup("My Notes") {
      RootView()
        .environmentObject(store)
        .frame(minWidth: 820, minHeight: 560)
        .task { await store.start() }
    }
    .defaultSize(width: 1160, height: 760)
    .commands {
      CommandGroup(replacing: .newItem) {
        Button("新建笔记") {
          Task { await store.createNote() }
        }
        .keyboardShortcut("n", modifiers: .command)
        .disabled(store.user == nil || store.location.isTrash)
      }
      CommandGroup(replacing: .saveItem) {
        Button("保存笔记") {
          Task { await store.saveSelected() }
        }
        .keyboardShortcut("s", modifiers: .command)
        .disabled(
          store.user == nil
            || store.location.isTrash
            || store.selectedDocument == nil
            || store.saveState == .saving
        )
      }

      CommandGroup(after: .sidebar) {
        Button("刷新笔记") {
          Task { await store.refresh() }
        }
        .keyboardShortcut("r", modifiers: .command)
        .disabled(store.user == nil)
      }
    }
  }
}

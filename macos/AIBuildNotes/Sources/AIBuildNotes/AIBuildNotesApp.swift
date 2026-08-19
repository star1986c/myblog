import NotesCore
import SwiftUI

@main
struct AIBuildNotesApp: App {
  @Environment(\.scenePhase) private var scenePhase
  @StateObject private var store: NotesStore
  @StateObject private var hermesStore: HermesChatStore
  @StateObject private var cloudflareBillingStore: CloudflareBillingStore

  init() {
    #if DEBUG
      _store = StateObject(wrappedValue: NotesStore.preview())
      _hermesStore = StateObject(wrappedValue: HermesChatStore.preview())
      _cloudflareBillingStore = StateObject(wrappedValue: CloudflareBillingStore.preview())
    #else
      let api = NotesAPIClient()
      _store = StateObject(wrappedValue: NotesStore(api: api))
      _hermesStore = StateObject(wrappedValue: HermesChatStore(api: api))
      _cloudflareBillingStore = StateObject(wrappedValue: CloudflareBillingStore())
    #endif
  }

  var body: some Scene {
    WindowGroup("My Notes") {
      RootView()
        .environmentObject(store)
        .environmentObject(hermesStore)
        .environmentObject(cloudflareBillingStore)
        .frame(minWidth: 820, minHeight: 560)
        .task { await store.start() }
        .task(id: store.user?.username) {
          if store.user == nil { await hermesStore.stop() }
          else {
            await hermesStore.start()
            await cloudflareBillingStore.start()
          }
        }
        .onChange(of: scenePhase) { _, phase in
          hermesStore.setApplicationActive(phase == .active)
          if phase == .active {
            Task { await cloudflareBillingStore.refreshIfNeeded() }
          }
        }
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

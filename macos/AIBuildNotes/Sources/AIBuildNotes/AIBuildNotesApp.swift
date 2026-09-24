import AppKit
import Combine
import NotesCore
import SwiftUI

@main
struct AIBuildNotesApp: App {
  @NSApplicationDelegateAdaptor(MyNotesApplicationDelegate.self) private var appDelegate
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
    WindowGroup("My Notes", id: "main") {
      MyNotesMainWindow()
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

private struct MyNotesMainWindow: View {
  @Environment(\.openWindow) private var openWindow
  @EnvironmentObject private var hermesStore: HermesChatStore

  var body: some View {
    RootView()
      .onAppear {
        HermesDockBadgeObserver.shared.observe(hermesStore)
        MyNotesWindowRestorer.shared.register { [openWindow] in
          openWindow(id: "main")
        }
      }
  }
}

private final class MyNotesApplicationDelegate: NSObject, NSApplicationDelegate {
  func applicationShouldHandleReopen(
    _ sender: NSApplication,
    hasVisibleWindows flag: Bool
  ) -> Bool {
    !MyNotesWindowRestorer.shared.restoreWindowIfNeeded()
  }
}

@MainActor
private final class MyNotesWindowRestorer {
  static let shared = MyNotesWindowRestorer()

  private var openWindow: (() -> Void)?
  private var activationSubscription: AnyCancellable?
  private var openingWindow = false

  func register(openWindow: @escaping () -> Void) {
    self.openWindow = openWindow
    openingWindow = false
    if activationSubscription == nil {
      activationSubscription = NotificationCenter.default.publisher(
        for: NSApplication.didBecomeActiveNotification,
        object: NSApp
      ).sink { [weak self] _ in
        self?.restoreWindowIfNeeded()
      }
    }
  }

  @discardableResult
  func restoreWindowIfNeeded() -> Bool {
    guard NSApp.isActive else { return false }
    let mainWindows = NSApp.windows.filter {
      $0.canBecomeMain && $0.frame.width >= 820 && $0.frame.height >= 560
    }
    if mainWindows.contains(where: { $0.isVisible && !$0.isMiniaturized }) {
      return true
    }
    if let window = mainWindows.first {
      NSApp.unhide(nil)
      if window.isMiniaturized { window.deminiaturize(nil) }
      window.makeKeyAndOrderFront(nil)
      return true
    }
    guard !openingWindow, let openWindow else { return false }
    openingWindow = true
    openWindow()
    Task { @MainActor in
      try? await Task.sleep(for: .seconds(2))
      openingWindow = false
    }
    return true
  }
}

@MainActor
private final class HermesDockBadgeObserver {
  static let shared = HermesDockBadgeObserver()

  private var observedStore: ObjectIdentifier?
  private var subscription: AnyCancellable?

  func observe(_ store: HermesChatStore) {
    guard observedStore != ObjectIdentifier(store) else { return }
    observedStore = ObjectIdentifier(store)
    subscription = store.$unreadByProfile.sink { counts in
      let unread = counts.values.reduce(0, +)
      NSApp.dockTile.badgeLabel = unread == 0 ? nil : (unread > 99 ? "99+" : "\(unread)")
    }
  }
}

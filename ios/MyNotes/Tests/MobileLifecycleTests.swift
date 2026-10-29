import XCTest
import UIKit
import NotesCore
@testable import MyNotes

@MainActor
final class MobileLifecycleTests: XCTestCase {
  func testBarkLinkReturnsToListAndPreservesDrafts() {
    let model = MobileModel()
    model.chatPath = [MobileChatRoute(id: "primary")]
    model.tab = 2
    model.chatDrafts["primary"] = MobileDraft(text: "未发送草稿")
    for _ in 0..<2 { model.openURL(URL(string: "mynotes://hermes")!) }
    XCTAssertEqual(model.tab, 0)
    XCTAssertTrue(model.chatPath.isEmpty)
    XCTAssertNil(model.chat.selectedProfileID)
    XCTAssertEqual(model.chatDrafts["primary"]?.text, "未发送草稿")
  }

  func testInvalidBarkLinksDoNotChangeNavigation() {
    let model = MobileModel()
    model.chatPath = [MobileChatRoute(id: "primary")]
    model.tab = 1
    for link in ["https://hermes", "mynotes://other", "mynotes://hermes/send",
                 "mynotes://hermes?command=approve", "mynotes://hermes#message",
                 "mynotes://user@hermes", "mynotes://hermes:123", "mynotes:hermes"] {
      model.openURL(URL(string: link)!)
      XCTAssertEqual(model.tab, 1, link)
      XCTAssertEqual(model.chatPath.last?.id, "primary", link)
    }
  }

  func testBarkColdStartAndLockRemainEnforced() async {
    let defaults = preferences()
    defaults.set(true, forKey: "ios.app-lock")
    let model = MobileModel(defaults: defaults, authenticate: { false })
    model.tab = 2
    model.openURL(URL(string: "mynotes://hermes")!)
    await model.start()
    XCTAssertTrue(model.locked)
    XCTAssertEqual(model.tab, 0)
    await model.unlock()
    XCTAssertTrue(model.locked)
    XCTAssertNil(model.chat.selectedProfileID)
  }

  func testBarkLinkDoesNotCreateLoginSession() async {
    let model = MobileModel()
    await model.notes.logout()
    model.openURL(URL(string: "mynotes://hermes")!)
    XCTAssertNil(model.notes.user)
    XCTAssertEqual(model.tab, 0)
    XCTAssertTrue(model.chatPath.isEmpty)
  }

  func testFinalReplyReplayAfterColdReloadKeepsOneCompleteBubble() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let crypto = try HermesChatCrypto(encodedKey: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")
    let history = try HermesChatHistoryStore(spaceID: "primary", crypto: crypto, directory: root)
    let final = HermesChatMessage(id: "final", sender: "agent", sentAt: 1000, sequence: 22,
      text: "完整回复", replaceSequence: 21, finalUpdate: true)
    _ = await history.recordBatch([final, final])
    let reopened = try HermesChatHistoryStore(spaceID: "primary", crypto: crypto, directory: root)
    let original = HermesChatMessage(id: "original", sender: "agent", sentAt: 999, sequence: 21,
      text: "正在回复")
    let snapshot = await reopened.recordBatch([final, original, final])
    XCTAssertEqual(snapshot.messages.count, 1)
    XCTAssertEqual(snapshot.messages.first?.id, "original")
    XCTAssertEqual(snapshot.messages.first?.text, "完整回复")
    XCTAssertEqual(snapshot.lastSequence, 22)
  }

  func testLateMicrophonePermissionDoesNotStartCancelledRecording() async {
    var permission: CheckedContinuation<Bool, Never>?
    var requests = 0
    let recorder = AudioRecorder(requestPermission: {
      requests += 1
      return await withCheckedContinuation { permission = $0 }
    })
    let pending = Task { await recorder.start() }
    while permission == nil { await Task.yield() }
    XCTAssertTrue(recorder.isStarting)
    await recorder.start() // A double tap must not create another pending permission request.
    XCTAssertEqual(requests, 1)
    recorder.cancel()
    permission?.resume(returning: true)
    await pending.value
    XCTAssertFalse(recorder.recording)
    XCTAssertFalse(recorder.isStarting)
    XCTAssertNil(recorder.result)
    XCTAssertNil(recorder.error)
  }

  func testBackgroundExpirationAndNormalCompletionEndAssertionExactlyOnce() {
    var expiration: (@MainActor () -> Void)?
    var ended: [UIBackgroundTaskIdentifier] = []
    var begins = 0
    let id = UIBackgroundTaskIdentifier(rawValue: 42)
    let lease = MobileBackgroundLease(begin: { callback in
      begins += 1
      expiration = callback
      return id
    }, end: { ended.append($0) })
    lease.begin()
    lease.begin()
    XCTAssertEqual(begins, 1)
    expiration?()
    lease.end()
    XCTAssertEqual(ended, [id])
  }

  func testStaleEditorCannotWriteIntoAnotherSelectedNote() {
    let store = NotesStore.preview()
    XCTAssertTrue(MobileNoteSelection.open("preview_0001", in: store))
    XCTAssertTrue(MobileNoteSelection.open("preview_0002", in: store))
    let original = store.selectedDocument?.content.content
    XCTAssertFalse(MobileNoteSelection.edit("preview_0001", in: store) { store.updateSelectedContent("wrong note") })
    XCTAssertEqual(store.selectedDocument?.content.content, original)
    XCTAssertTrue(MobileNoteSelection.edit("preview_0002", in: store) { store.updateSelectedContent("correct note") })
    XCTAssertEqual(store.selectedDocument?.content.content, "correct note")
    XCTAssertFalse(MobileNoteSelection.open("missing", in: store))
    XCTAssertEqual(store.selectedID, "preview_0002")
  }

  func testNavigationPathControlsSelectionAcrossTabAndBackgroundChanges() {
    let model = MobileModel()
    model.chatPath = [MobileChatRoute(id: "primary")]
    XCTAssertEqual(model.chat.selectedProfileID, "primary")
    model.tab = 1
    XCTAssertNil(model.chat.selectedProfileID)
    XCTAssertEqual(model.chatPath.last?.id, "primary")
    model.tab = 0
    XCTAssertEqual(model.chat.selectedProfileID, "primary")
    model.transition(to: .inactive)
    model.transition(to: .background)
    XCTAssertNil(model.chat.selectedProfileID)
    model.transition(to: .active)
    XCTAssertEqual(model.chat.selectedProfileID, "primary")
    model.chatPath = [MobileChatRoute(id: "personal")]
    XCTAssertEqual(model.chat.selectedProfileID, "personal")
    model.chatPath = []
    XCTAssertNil(model.chat.selectedProfileID)
  }

  private func preferences() -> UserDefaults {
    let name = "mobile-lifecycle-tests-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: name)!
    addTeardownBlock { defaults.removePersistentDomain(forName: name) }
    return defaults
  }

  func testThreeMinuteGraceUsesTimeAwayAndRestoresRoute() async {
    let defaults = preferences()
    defaults.set(true, forKey: "ios.app-lock")
    var instant = ContinuousClock.now
    let model = MobileModel(defaults: defaults, now: { instant }, authenticate: { true })
    XCTAssertTrue(model.locked) // Cold launch still authenticates.
    XCTAssertEqual(model.lockDelay, .threeMinutes)
    await model.unlock()
    model.chatPath = [MobileChatRoute(id: "primary")]
    instant = instant.advanced(by: .seconds(600)) // Time spent using the app is not the grace window.
    model.transition(to: .background)
    instant = instant.advanced(by: .seconds(179))
    model.transition(to: .active)
    XCTAssertFalse(model.locked)
    XCTAssertEqual(model.chat.selectedProfileID, "primary")
    model.transition(to: .background)
    instant = instant.advanced(by: .seconds(180))
    model.transition(to: .active)
    XCTAssertTrue(model.locked)
    XCTAssertEqual(model.chatPath.last?.id, "primary")
    XCTAssertNil(model.chat.selectedProfileID)
    await model.unlock()
    XCTAssertEqual(model.chat.selectedProfileID, "primary")
  }

  func testFiveMinuteGracePersistsAndInactiveDoesNotStartTimer() async {
    let defaults = preferences()
    defaults.set(true, forKey: "ios.app-lock")
    var instant = ContinuousClock.now
    let model = MobileModel(defaults: defaults, now: { instant }, authenticate: { true })
    await model.unlock()
    model.setLockDelay(.fiveMinutes)
    XCTAssertEqual(defaults.integer(forKey: "ios.app-lock-delay"), 300)
    model.transition(to: .inactive) // Face ID, a permission dialog, or Control Center.
    instant = instant.advanced(by: .seconds(400))
    model.transition(to: .active)
    XCTAssertFalse(model.locked)
    model.transition(to: .background)
    instant = instant.advanced(by: .seconds(299))
    model.transition(to: .background) // Repeated callbacks must not extend the grace.
    model.transition(to: .active)
    XCTAssertFalse(model.locked)
    model.transition(to: .background)
    instant = instant.advanced(by: .seconds(300))
    model.transition(to: .active)
    XCTAssertTrue(model.locked)
    let restarted = MobileModel(defaults: defaults, authenticate: { true })
    XCTAssertEqual(restarted.lockDelay, .fiveMinutes)
    XCTAssertTrue(restarted.locked)
  }

  func testImmediateLockAndDisabledLock() async {
    let model = MobileModel(defaults: preferences(), authenticate: { true })
    model.setLockDelay(.immediately)
    model.transition(to: .background)
    model.transition(to: .active)
    XCTAssertFalse(model.locked)
    await model.setAppLock(true)
    model.transition(to: .background)
    XCTAssertTrue(model.locked)
  }

  func testCancelledAuthenticationDoesNotUnlockOrClearRoute() async {
    let defaults = preferences()
    defaults.set(true, forKey: "ios.app-lock")
    let model = MobileModel(defaults: defaults, authenticate: { false })
    model.chatPath = [MobileChatRoute(id: "personal")]
    await model.unlock()
    XCTAssertTrue(model.locked)
    XCTAssertEqual(model.chatPath.last?.id, "personal")
    XCTAssertFalse(model.isAuthenticating)
  }

  func testAppearanceAndInvalidSavedGrace() {
    let defaults = preferences()
    defaults.set(-100, forKey: "ios.app-lock-delay")
    let model = MobileModel(defaults: defaults)
    XCTAssertEqual(model.lockDelay, .threeMinutes)
    model.setAppearance(.dark)
    XCTAssertEqual(MobileModel(defaults: defaults).appearance, .dark)
  }

  func testAuthenticationCannotBeDuplicatedOrUnlockInBackground() async {
    let defaults = preferences()
    defaults.set(true, forKey: "ios.app-lock")
    var pending: CheckedContinuation<Bool, Never>?
    var attempts = 0
    let model = MobileModel(defaults: defaults, authenticate: {
      attempts += 1
      return await withCheckedContinuation { pending = $0 }
    })
    let task = Task { await model.unlock() }
    while pending == nil { await Task.yield() }
    await model.unlock()
    XCTAssertEqual(attempts, 1)
    model.transition(to: .background)
    pending?.resume(returning: true)
    await task.value
    XCTAssertTrue(model.locked)
    XCTAssertFalse(model.isAuthenticating)
    model.transition(to: .active)
    XCTAssertTrue(model.locked)
  }
}

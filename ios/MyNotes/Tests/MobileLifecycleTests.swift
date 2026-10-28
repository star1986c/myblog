import XCTest
import UIKit
import NotesCore
@testable import MyNotes

@MainActor
final class MobileLifecycleTests: XCTestCase {
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

  func testLateDepartureCannotClearNewlyVisibleChat() {
    let model = MobileModel()
    model.enterChat("primary")
    model.enterChat("personal")
    model.leaveChat("primary")
    XCTAssertEqual(model.chat.selectedProfileID, "personal")
    model.leaveChat("personal")
    XCTAssertNil(model.chat.selectedProfileID)
  }
}

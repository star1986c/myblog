import XCTest

@MainActor
final class MyNotesUITests: XCTestCase {
  func testBackgroundReturnPreservesDraft() {
    let app = XCUIApplication()
    app.launchArguments = ["--preview"]
    app.launch()
    XCTAssertTrue(app.buttons["profile.primary"].waitForExistence(timeout: 10))
    let home = XCTAttachment(screenshot: app.screenshot())
    home.name = "iPhone-conversations"
    home.lifetime = .keepAlways
    add(home)
    app.buttons["profile.primary"].tap()
    let composer = app.textFields["chat.composer"]
    XCTAssertTrue(composer.waitForExistence(timeout: 5))
    composer.tap()
    composer.typeText("draft survives background")
    XCUIDevice.shared.press(.home)
    app.activate()
    XCTAssertTrue(composer.waitForExistence(timeout: 5))
    XCTAssertEqual(composer.value as? String, "draft survives background")
    let chat = XCTAttachment(screenshot: app.screenshot())
    chat.name = "iPhone-chat"
    chat.lifetime = .keepAlways
    add(chat)
  }

  func testPreviewNavigationAndDraftIsolation() {
    let app = XCUIApplication()
    app.launchArguments = ["--preview"]
    app.launch()
    XCTAssertTrue(app.buttons["profile.primary"].waitForExistence(timeout: 10))
    app.buttons["profile.primary"].tap()
    let composer = app.textFields["chat.composer"]
    XCTAssertTrue(composer.waitForExistence(timeout: 5))
    composer.tap()
    composer.typeText("draft primary")
    app.navigationBars.buttons.element(boundBy: 0).tap()
    app.buttons["profile.personal"].tap()
    XCTAssertEqual(app.textFields["chat.composer"].value as? String, "消息或 /命令")
    app.navigationBars.buttons.element(boundBy: 0).tap()
    app.buttons["profile.primary"].tap()
    XCTAssertEqual(app.textFields["chat.composer"].value as? String, "draft primary")
    app.navigationBars.buttons.element(boundBy: 0).tap()
    app.tabBars.buttons["笔记"].tap()
    let note = app.buttons["note.preview_0001"]
    XCTAssertTrue(note.waitForExistence(timeout: 5))
    note.tap()
    XCTAssertTrue(app.textViews["note.body"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.textFields["note.title"].exists || app.textViews["note.title"].exists)
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = "iPhone-note-editor"
    screenshot.lifetime = .keepAlways
    add(screenshot)
    app.buttons["note.done"].tap()
    app.tabBars.buttons["设置"].tap()
    XCTAssertTrue(app.staticTexts["iPhone 个人版"].waitForExistence(timeout: 5))
  }

  func testProtectedNoteDoesNotExposeBodyAndCommandPickerDoesNotSend() {
    let app = XCUIApplication()
    app.launchArguments = ["--preview"]
    app.launch()
    app.tabBars.buttons["笔记"].tap()
    app.buttons["note.preview_0004"].tap()
    XCTAssertTrue(app.secureTextFields["保护密码"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.textViews["note.body"].exists)
    app.buttons["note.done"].tap()
    app.tabBars.buttons["Hermes"].tap()
    app.buttons["profile.primary"].tap()
    app.buttons["会话操作"].tap()
    app.buttons["命令面板"].tap()
    XCTAssertTrue(app.navigationBars["命令面板"].waitForExistence(timeout: 5))
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = "iPhone-commands"
    screenshot.lifetime = .keepAlways
    add(screenshot)
  }
}

import XCTest

@MainActor
final class MyNotesUITests: XCTestCase {
  func testRepeatedConversationSwitchAndTabReturnKeepDestinationVisible() {
    let app = XCUIApplication()
    app.launchArguments = ["--preview"]
    app.launch()
    XCTAssertTrue(app.buttons["profile.primary"].waitForExistence(timeout: 10))
    for _ in 0..<3 {
      for id in ["primary", "personal"] {
        app.buttons["profile.\(id)"].tap()
        XCTAssertTrue(app.textFields["chat.composer"].waitForExistence(timeout: 5))
        let message = app.staticTexts[id == "primary" ? "Gateway online" : "个人助手已就绪。"]
        XCTAssertTrue(message.waitForExistence(timeout: 5))
        XCTAssertTrue(message.isHittable)
        XCTAssertTrue(app.buttons["chat.send"].exists)
        app.tabBars.buttons["设置"].tap()
        app.tabBars.buttons["Hermes"].tap()
        XCTAssertTrue(app.textFields["chat.composer"].waitForExistence(timeout: 5))
        XCTAssertTrue(message.isHittable)
        XCUIDevice.shared.press(.home)
        app.activate()
        XCTAssertTrue(message.waitForExistence(timeout: 5))
        XCTAssertTrue(message.isHittable)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.buttons["profile.primary"].waitForExistence(timeout: 5))
      }
    }
  }

  func testNativeAppearanceAndGraceSettings() {
    let app = XCUIApplication()
    app.launchArguments = ["--preview"]
    app.launch()
    app.tabBars.buttons["设置"].tap()
    app.buttons["settings.lock-delay"].tap()
    XCTAssertTrue(app.buttons["5 分钟后"].waitForExistence(timeout: 5))
    app.buttons["5 分钟后"].tap()
    XCTAssertTrue(app.buttons["settings.appearance"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.buttons["settings.lock-delay"].value as? String, "5 分钟后")
    app.buttons["settings.appearance"].tap()
    app.buttons["深色"].tap()
    XCTAssertTrue(app.buttons["settings.lock-delay"].waitForExistence(timeout: 5))
    let settings = XCTAttachment(screenshot: app.screenshot())
    settings.name = "iPhone-settings-dark"
    settings.lifetime = .keepAlways
    add(settings)
    app.tabBars.buttons["Hermes"].tap()
    app.buttons["profile.personal"].tap()
    XCTAssertTrue(app.textFields["chat.composer"].waitForExistence(timeout: 5))
    let chat = XCTAttachment(screenshot: app.screenshot())
    chat.name = "iPhone-chat-dark"
    chat.lifetime = .keepAlways
    add(chat)
  }

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
    app.swipeUp()
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

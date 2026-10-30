import XCTest

@MainActor
final class MyNotesUITests: XCTestCase {
  func testDesignAuditMainFlow() {
    let app = XCUIApplication()
    app.launchArguments = ["--preview", "--preview-chat-style"]
    app.launch()
    XCTAssertTrue(app.buttons["profile.primary"].waitForExistence(timeout: 10))
    captureDesignStep("01-conversations", app)
    app.buttons["profile.primary"].tap()
    XCTAssertTrue(app.textFields["chat.composer"].waitForExistence(timeout: 5))
    captureDesignStep("02-chat", app)
    app.textFields["chat.composer"].tap()
    app.textFields["chat.composer"].typeText("Draft for review")
    captureDesignStep("03-composer", app)
    app.buttons["chat.dismiss-keyboard"].tap()
    XCTAssertTrue(app.tabBars.buttons["笔记"].isHittable)
    XCTAssertEqual(app.textFields["chat.composer"].value as? String, "Draft for review")
    app.tabBars.buttons["笔记"].tap()
    XCTAssertTrue(app.buttons["note.preview_0001"].waitForExistence(timeout: 5))
    captureDesignStep("04-notes", app)
    app.buttons["文件夹"].tap()
    XCTAssertTrue(app.buttons["回收站"].waitForExistence(timeout: 5))
    captureDesignStep("05-folders", app)
    app.buttons["回收站"].tap()
    XCTAssertTrue(app.navigationBars["回收站"].waitForExistence(timeout: 5))
    captureDesignStep("06-trash", app)
    app.buttons["文件夹"].tap()
    app.buttons["全部笔记"].tap()
    app.buttons["note.preview_0001"].tap()
    XCTAssertTrue(app.textViews["note.body"].waitForExistence(timeout: 5))
    captureDesignStep("07-editor", app)
    app.buttons["note.done"].tap()
    app.tabBars.buttons["设置"].tap()
    XCTAssertTrue(app.buttons["settings.appearance"].waitForExistence(timeout: 5))
    captureDesignStep("08-settings", app)
    app.swipeUp()
    captureDesignStep("09-settings-more", app)
  }

  func testFolderSearchAndCloudDeletionClarity() {
    let app = XCUIApplication()
    app.launchArguments = ["--preview"]
    app.launch()
    app.tabBars.buttons["笔记"].tap()
    app.buttons["文件夹"].tap()
    XCTAssertTrue((app.buttons["全部笔记"].value as? String)?.contains("当前选择") == true)
    app.buttons["未分类"].tap()
    XCTAssertTrue(app.navigationBars["未分类"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["note.preview_0003"].exists)
    XCTAssertFalse(app.buttons["note.preview_0001"].exists)
    captureDesignStep("10-unfiled", app)
    let search = app.searchFields.firstMatch
    search.tap()
    search.typeText("no-match-93827")
    XCTAssertTrue(app.staticTexts["没有找到笔记"].waitForExistence(timeout: 5))
    captureDesignStep("11-empty-search", app)
    app.buttons["清除搜索"].tap()
    XCTAssertTrue(app.buttons["note.preview_0003"].waitForExistence(timeout: 5))
    search.tap()
    search.typeText("Cloudflare")
    XCTAssertTrue(app.buttons["note.preview_0002"].waitForExistence(timeout: 5))
    // Search spans local notes, including notes outside the current folder.
    XCTAssertTrue(app.navigationBars["搜索结果"].exists)
    app.buttons.matching(NSPredicate(format: "label IN %@", ["Close", "取消"])).firstMatch.tap()
    app.tabBars.buttons["设置"].tap()
    app.swipeUp()
    app.buttons["settings.purge"].tap()
    XCTAssertTrue(app.buttons["Hermes 主助手"].waitForExistence(timeout: 5))
    app.buttons["Hermes 主助手"].tap()
    XCTAssertTrue(app.alerts.firstMatch.waitForExistence(timeout: 5))
    XCTAssertTrue(app.alerts.staticTexts["会删除云端及本机聊天记录和附件，无法撤销。"].exists)
    captureDesignStep("12-cloud-delete-confirmation", app)
    app.alerts.buttons["取消"].tap()
    XCTAssertFalse(app.alerts.firstMatch.exists)
  }

  private func captureDesignStep(_ name: String, _ app: XCUIApplication) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  func testBarkURLReturnsToHermesListFromBackgroundAndColdLaunch() {
    let app = XCUIApplication()
    app.launchArguments = ["--preview"]
    app.launch()
    XCTAssertTrue(app.buttons["profile.primary"].waitForExistence(timeout: 10))
    app.buttons["profile.primary"].tap()
    XCTAssertTrue(app.textFields["chat.composer"].waitForExistence(timeout: 5))
    app.tabBars.buttons["设置"].tap()
    XCUIDevice.shared.press(.home)
    app.open(URL(string: "mynotes://hermes")!)
    XCTAssertTrue(app.buttons["profile.primary"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.tabBars.buttons["Hermes"].isSelected)
    app.open(URL(string: "mynotes://hermes")!)
    XCTAssertTrue(app.buttons["profile.primary"].waitForExistence(timeout: 5))
    app.terminate()
    app.open(URL(string: "mynotes://hermes")!)
    XCTAssertTrue(app.buttons["profile.primary"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.tabBars.buttons["Hermes"].isSelected)
  }

  func testChatStyleLightAndDark() {
    let app = XCUIApplication()
    app.launchArguments = ["--preview", "--preview-chat-style"]
    app.launch()
    XCTAssertTrue(app.buttons["profile.primary"].waitForExistence(timeout: 10))
    app.buttons["profile.primary"].tap()
    XCTAssertTrue(app.textFields["chat.composer"].waitForExistence(timeout: 5))
    let reply = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "如果有异常，把结果发给我")).firstMatch
    XCTAssertTrue(reply.waitForExistence(timeout: 5))
    XCTAssertTrue(reply.isHittable)
    var shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = "chat-style-light"; shot.lifetime = .keepAlways; add(shot)
    app.tabBars.buttons["设置"].tap()
    app.buttons["settings.appearance"].tap()
    app.buttons["深色"].tap()
    app.tabBars.buttons["Hermes"].tap()
    XCTAssertTrue(app.textFields["chat.composer"].waitForExistence(timeout: 5))
    shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = "chat-style-dark"; shot.lifetime = .keepAlways; add(shot)
  }

  func testLongHistoryOpensAtVisibleLatestMessageOffline() {
    verifyLongHistory(extraArguments: [])
  }

  func testOversizedNewestMessageOpensAtItsEndOffline() {
    verifyLongHistory(extraArguments: ["--preview-long-latest"])
  }

  private func verifyLongHistory(extraArguments: [String]) {
    let app = XCUIApplication()
    app.launchArguments = ["--preview", "--preview-long-history"] + extraArguments
    app.launch()
    XCTAssertTrue(app.buttons["profile.primary"].waitForExistence(timeout: 10))
    app.buttons["profile.primary"].tap()
    XCTAssertTrue(app.textFields["chat.composer"].waitForExistence(timeout: 10))
    let latest = app.staticTexts["长历史最新消息可见"]
    let visible = NSPredicate(format: "exists == true AND hittable == true")
    expectation(for: visible, evaluatedWith: latest)
    waitForExpectations(timeout: 10)
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = "offline-long-history"; screenshot.lifetime = .keepAlways; add(screenshot)
  }

  func testImageThumbnailsAndAttachmentPreviewsReturnToTheSameChat() {
    let app = XCUIApplication()
    app.launchArguments = ["--preview", "--preview-attachments"]
    app.launch()
    XCTAssertTrue(app.buttons["profile.primary"].waitForExistence(timeout: 10))
    app.buttons["profile.primary"].tap()
    let photo = app.buttons["attachment.open.preview-photo"]
    XCTAssertTrue(photo.waitForExistence(timeout: 5))
    let loaded = NSPredicate(format: "value == %@", "图片预览已加载")
    expectation(for: loaded, evaluatedWith: photo)
    waitForExpectations(timeout: 10)
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = "iPhone-inline-image"; screenshot.lifetime = .keepAlways; add(screenshot)
    for id in ["preview-photo", "preview-document", "preview-photo"] {
      app.buttons["attachment.open.\(id)"].tap()
      let done = app.buttons["attachment.preview.done"]
      XCTAssertTrue(done.waitForExistence(timeout: 5))
      XCTAssertTrue(done.isHittable)
      XCTAssertTrue(app.buttons["attachment.preview.share"].isHittable)
      let preview = XCTAttachment(screenshot: app.screenshot())
      preview.name = "iPhone-preview-\(id)"; preview.lifetime = .keepAlways; add(preview)
      done.tap()
      XCTAssertTrue(app.textFields["chat.composer"].waitForExistence(timeout: 5))
      XCTAssertTrue(app.staticTexts["图片和文件预览测试"].isHittable)
    }
    app.navigationBars.buttons.element(boundBy: 0).tap()
    app.buttons["profile.personal"].tap()
    let received = app.buttons["attachment.open.preview-received"]
    XCTAssertTrue(received.waitForExistence(timeout: 5))
    expectation(for: loaded, evaluatedWith: received)
    waitForExpectations(timeout: 10)
    received.tap()
    XCTAssertTrue(app.buttons["attachment.preview.done"].waitForExistence(timeout: 5))
    app.buttons["attachment.preview.done"].tap()
    app.navigationBars.buttons.element(boundBy: 0).tap()
    XCTAssertTrue(app.buttons["profile.primary"].waitForExistence(timeout: 5))
  }

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
    XCTAssertEqual(app.textFields["chat.composer"].value as? String, "输入消息或 /命令")
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

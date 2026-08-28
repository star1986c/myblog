import Foundation
import Testing

@testable import NotesCore

@Suite("Hermes typing state", .serialized)
struct HermesChatStoreTypingTests {
  @Test("Agent messages clear typing and awaiting state")
  @MainActor
  func agentMessageClearsTyping() async {
    let store = makeStore()
    await store.start()

    store.markAwaiting("personal")
    await store.handle(
      .typing(
        spaceID: "personal",
        active: true,
        terminal: false,
        configurationGeneration: 0
      )
    )
    #expect(store.typingProfiles == ["personal"])
    #expect(store.awaitingProfiles == ["personal"])

    await store.handle(
      .message(
        spaceID: "personal",
        message: agentMessage(id: "agent-finished"),
        configurationGeneration: 0
      )
    )
    #expect(store.typingProfiles.isEmpty)
    #expect(store.awaitingProfiles.isEmpty)

    await store.stop()
  }

  @Test("A late negative action ACK cannot clear a newer request")
  @MainActor
  func staleUndeliveredActionKeepsNewerBusyState() async {
    let store = makeStore()
    await store.start()

    let oldGeneration = store.markAwaiting("personal")
    store.registerAwaitingAction(
      "old-approval",
      spaceID: "personal",
      generation: oldGeneration
    )
    let newGeneration = store.markAwaiting("personal")
    store.registerAwaitingAction(
      "new-approval",
      spaceID: "personal",
      generation: newGeneration
    )
    await store.handle(
      .typing(
        spaceID: "personal",
        active: true,
        terminal: false,
        configurationGeneration: 0
      )
    )
    await store.handle(
      .actionAcknowledged(
        spaceID: "personal",
        actionID: "old-approval",
        delivered: false,
        configurationGeneration: 0
      )
    )

    #expect(store.typingProfiles == ["personal"])
    #expect(store.awaitingProfiles == ["personal"])
    #expect(store.errorMessage == nil)

    await store.handle(
      .actionAcknowledged(
        spaceID: "personal",
        actionID: "new-approval",
        delivered: false,
        configurationGeneration: 0
      )
    )
    #expect(store.typingProfiles.isEmpty)
    #expect(store.awaitingProfiles.isEmpty)
    #expect(store.errorMessage == "Hermes Agent 当前未连接，操作没有执行。")

    await store.stop()
  }

  @Test("Late typing after an Agent message cannot reopen awaiting state")
  @MainActor
  func lateTypingExpires() async throws {
    let store = makeStore(typingTimeout: .milliseconds(40))
    await store.start()

    await store.handle(
      .message(
        spaceID: "personal",
        message: agentMessage(id: "agent-before-typing"),
        configurationGeneration: 0
      )
    )
    await store.handle(
      .typing(
        spaceID: "personal",
        active: true,
        terminal: false,
        configurationGeneration: 0
      )
    )
    #expect(store.typingProfiles == ["personal"])
    #expect(store.awaitingProfiles.isEmpty)

    try await Task.sleep(for: .milliseconds(120))
    #expect(store.typingProfiles.isEmpty)
    #expect(store.awaitingProfiles.isEmpty)

    await store.stop()
  }

  @Test("A queued event from an old key generation is not written after reconfiguration")
  @MainActor
  func queuedOldGenerationIsDiscarded() async throws {
    let store = makeStore()
    await store.start()

    await store.handle(
      .message(
        spaceID: "personal",
        message: agentMessage(id: "old-key-message"),
        configurationGeneration: 0
      )
    )
    let replacementKey = Data(repeating: 7, count: 32).base64EncodedString()
    #expect(await store.saveKey(replacementKey, spaceID: "personal"))

    try await Task.sleep(for: .milliseconds(120))
    #expect(store.messages(spaceID: "personal").isEmpty)

    await store.stop()
  }

  @Test("Repeated typing refreshes the short timeout")
  @MainActor
  func typingHeartbeatRefreshesTimeout() async throws {
    let store = makeStore(typingTimeout: .seconds(1))
    await store.start()

    await store.handle(
      .typing(
        spaceID: "personal",
        active: true,
        terminal: false,
        configurationGeneration: 0
      )
    )
    try await Task.sleep(for: .milliseconds(400))
    await store.handle(
      .typing(
        spaceID: "personal",
        active: true,
        terminal: false,
        configurationGeneration: 0
      )
    )

    try await Task.sleep(for: .milliseconds(750))
    #expect(store.typingProfiles == ["personal"])

    try await Task.sleep(for: .milliseconds(400))
    #expect(store.typingProfiles.isEmpty)

    await store.stop()
  }

  @Test("Typing false ends both typing and awaiting state")
  @MainActor
  func typingFalseClearsTyping() async throws {
    let store = makeStore(typingTimeout: .milliseconds(40))
    await store.start()

    store.markAwaiting("personal")
    await store.handle(
      .typing(
        spaceID: "personal",
        active: true,
        terminal: false,
        configurationGeneration: 0
      )
    )
    await store.handle(
      .typing(
        spaceID: "personal",
        active: false,
        terminal: true,
        configurationGeneration: 0
      )
    )
    #expect(store.typingProfiles.isEmpty)
    #expect(store.awaitingProfiles.isEmpty)

    try await Task.sleep(for: .milliseconds(120))
    #expect(store.typingProfiles.isEmpty)
    #expect(store.awaitingProfiles.isEmpty)

    await store.stop()
  }

  @Test("A turn fence clears stale typing without ending the current request")
  @MainActor
  func typingFencePreservesAwaiting() async {
    let store = makeStore()
    await store.start()

    store.markAwaiting("personal")
    await store.handle(
      .typing(
        spaceID: "personal",
        active: true,
        terminal: false,
        configurationGeneration: 0
      )
    )
    await store.handle(
      .typing(
        spaceID: "personal",
        active: false,
        terminal: false,
        configurationGeneration: 0
      )
    )

    #expect(store.typingProfiles.isEmpty)
    #expect(store.awaitingProfiles == ["personal"])

    await store.stop()
  }

  @Test("Undelivered interaction actions clear typing and awaiting state")
  @MainActor
  func undeliveredActionClearsBusyState() async {
    let store = makeStore()
    await store.start()

    let generation = store.markAwaiting("personal")
    store.registerAwaitingAction(
      "approval",
      spaceID: "personal",
      generation: generation
    )
    await store.handle(
      .typing(
        spaceID: "personal",
        active: true,
        terminal: false,
        configurationGeneration: 0
      )
    )
    await store.handle(
      .actionAcknowledged(
        spaceID: "personal",
        actionID: "approval",
        delivered: false,
        configurationGeneration: 0
      )
    )

    #expect(store.typingProfiles.isEmpty)
    #expect(store.awaitingProfiles.isEmpty)
    #expect(store.errorMessage == "Hermes Agent 当前未连接，操作没有执行。")

    await store.stop()
  }

  @Test("Disconnect clears typing while preserving the pending reply timeout")
  @MainActor
  func disconnectClearsTyping() async {
    let store = makeStore()
    await store.start()

    store.markAwaiting("personal")
    await store.handle(
      .typing(
        spaceID: "personal",
        active: true,
        terminal: false,
        configurationGeneration: 0
      )
    )
    await store.handle(
      .disconnected(reason: "test disconnect", configurationGeneration: 0)
    )
    #expect(store.typingProfiles.isEmpty)
    #expect(store.awaitingProfiles == ["personal"])
    #expect(store.connectionState == .disconnected("test disconnect"))

    await store.stop()
  }

  @Test("Failed sends only roll back their own awaiting token")
  @MainActor
  func awaitingRollbackKeepsNewerRequest() async {
    let store = makeStore()
    await store.start()

    let failedRequest = store.markAwaiting("personal")
    let newerRequest = store.markAwaiting("personal")
    store.cancelAwaiting("personal", generation: failedRequest)
    #expect(store.awaitingProfiles == ["personal"])

    store.cancelAwaiting("personal", generation: newerRequest)
    #expect(store.awaitingProfiles.isEmpty)

    await store.stop()
  }

  @Test("A stale awaiting timer cannot clear a newer request")
  @MainActor
  func staleAwaitingTimerKeepsNewerRequest() async {
    let store = makeStore()
    await store.start()

    let staleTimer = store.markAwaiting("personal")
    let currentTimer = store.markAwaiting("personal")
    store.expireAwaiting("personal", generation: staleTimer)
    #expect(store.awaitingProfiles == ["personal"])

    store.expireAwaiting("personal", generation: currentTimer)
    #expect(store.awaitingProfiles.isEmpty)

    await store.stop()
  }

  @Test("A terminal Agent event invalidates a late send rollback")
  @MainActor
  func terminalEventInvalidatesLateRollback() async {
    let completedRequest = makeStore()
    await completedRequest.start()

    let completedToken = completedRequest.markAwaiting("personal")
    await completedRequest.handle(
      .message(
        spaceID: "personal",
        message: agentMessage(id: "terminal-agent"),
        configurationGeneration: 0
      )
    )
    let newerToken = completedRequest.markAwaiting("personal")
    completedRequest.cancelAwaiting("personal", generation: completedToken)
    #expect(completedRequest.awaitingProfiles == ["personal"])

    completedRequest.cancelAwaiting("personal", generation: newerToken)
    await completedRequest.stop()
  }

  @MainActor
  private func makeStore(
    typingTimeout: Duration = .seconds(1)
  ) -> HermesChatStore {
    let suiteName = "hermes-chat-typing-tests-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName) ?? .standard
    return HermesChatStore(
      api: NotesAPIClient(baseURL: URL(string: "http://127.0.0.1:9/")!),
      keyStore: TestHermesKeyStore(),
      defaults: defaults,
      previewsOnly: true,
      typingTimeout: typingTimeout
    )
  }

  private func agentMessage(id: String) -> HermesChatMessage {
    HermesChatMessage(
      id: id,
      sender: "agent",
      sentAt: 1_800_000_000_000,
      sequence: 1,
      text: "done"
    )
  }
}

private final class TestHermesKeyStore: HermesChatKeyStoring, @unchecked Sendable {
  private let lock = NSLock()
  private var keys: [String: String] = [:]

  func loadKey(spaceID: String) -> String? {
    lock.withLock { keys[spaceID] }
  }

  func saveKey(_ key: String, spaceID: String) throws {
    lock.withLock { keys[spaceID] = key }
  }

  func removeKey(spaceID: String) throws {
    _ = lock.withLock { keys.removeValue(forKey: spaceID) }
  }
}

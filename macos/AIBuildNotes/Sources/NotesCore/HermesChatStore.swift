import Combine
import Foundation

@MainActor
public final class HermesChatStore: ObservableObject {
  @Published public private(set) var profiles: [HermesChatProfile] = []
  @Published public var selectedProfileID: String?
  @Published public private(set) var connectionState: HermesChatConnectionState = .idle
  @Published public private(set) var messagesByProfile: [String: [HermesChatMessage]] = [:]
  @Published public private(set) var unreadByProfile: [String: Int] = [:]
  @Published public private(set) var typingProfiles: Set<String> = []
  @Published public private(set) var awaitingProfiles: Set<String> = []
  @Published public private(set) var configuredProfileIDs: Set<String> = []
  @Published public private(set) var isRefreshing = false
  @Published public private(set) var isSending = false
  @Published public private(set) var errorMessage: String?
  @Published public private(set) var retentionDays: Int

  private let api: NotesAPIClient
  private let keyStore: any HermesChatKeyStoring
  private let client: HermesChatClient
  private let attachmentCache: HermesChatAttachmentCache
  private let defaults: UserDefaults
  private let previewsOnly: Bool
  private var cryptos: [String: HermesChatCrypto] = [:]
  private var histories: [String: HermesChatHistoryStore] = [:]
  private var lastSequences: [String: Int64] = [:]
  private var eventTask: Task<Void, Never>?
  private var reconnectTask: Task<Void, Never>?
  private var awaitingTasks: [String: Task<Void, Never>] = [:]
  private var started = false
  private var applicationActive = true
  private var reconnectAttempt = 0
  private var configurationGeneration = 0

  public init(
    api: NotesAPIClient = NotesAPIClient(),
    keyStore: any HermesChatKeyStoring = HermesChatKeychain(),
    client: HermesChatClient = HermesChatClient(),
    attachmentCache: HermesChatAttachmentCache = HermesChatAttachmentCache(),
    defaults: UserDefaults = .standard,
    previewsOnly: Bool = false
  ) {
    self.api = api
    self.keyStore = keyStore
    self.client = client
    self.attachmentCache = attachmentCache
    self.defaults = defaults
    self.previewsOnly = previewsOnly
    let stored = defaults.object(forKey: "hermes_chat_retention_days_v1") as? Int ?? 30
    retentionDays = [0, 7, 30, 90].contains(stored) ? stored : 30
  }

  #if DEBUG
    public static func preview() -> HermesChatStore {
      let suite = UserDefaults(suiteName: "hermes-chat-preview-\(UUID().uuidString)") ?? .standard
      let store = HermesChatStore(
        api: NotesAPIClient(baseURL: URL(string: "http://127.0.0.1:9/")!),
        keyStore: PreviewHermesKeyStore(),
        defaults: suite,
        previewsOnly: true
      )
      store.profiles = [
        HermesChatProfile(id: "primary", label: "Hermes 主助手"),
        HermesChatProfile(id: "personal", label: "Hermes 个人助手"),
      ]
      store.selectedProfileID = "primary"
      store.configuredProfileIDs = ["primary", "personal"]
      store.connectionState = .connected
      store.messagesByProfile = [
        "primary": [
          HermesChatMessage(
            id: "preview-client",
            sender: "client",
            sentAt: 1_787_100_000_000,
            sequence: 1,
            text: "/status"
          ),
          HermesChatMessage(
            id: "preview-agent",
            sender: "agent",
            sentAt: 1_787_100_001_000,
            sequence: 2,
            text: "## Gateway online\n\n- WebSocket 已连接\n- Android 与 Mac 正在同步\n\n```bash\nhermes status\n```"
          ),
        ],
        "personal": [
          HermesChatMessage(
            id: "preview-personal",
            sender: "agent",
            sentAt: 1_787_099_000_000,
            sequence: 1,
            text: "个人助手已就绪。"
          )
        ],
      ]
      store.unreadByProfile = ["personal": 1]
      return store
    }
  #endif

  deinit {
    eventTask?.cancel()
    reconnectTask?.cancel()
    for task in awaitingTasks.values { task.cancel() }
  }

  public var selectedProfile: HermesChatProfile? {
    guard let selectedProfileID else { return nil }
    return profiles.first { $0.id == selectedProfileID }
  }

  public var selectedMessages: [HermesChatMessage] {
    guard let selectedProfileID else { return [] }
    return messagesByProfile[selectedProfileID] ?? []
  }

  public var totalUnread: Int { unreadByProfile.values.reduce(0, +) }

  public func messages(spaceID: String) -> [HermesChatMessage] {
    messagesByProfile[spaceID] ?? []
  }

  public func unreadCount(spaceID: String) -> Int { unreadByProfile[spaceID] ?? 0 }

  public func lastMessage(spaceID: String) -> HermesChatMessage? {
    messagesByProfile[spaceID]?.last
  }

  public func isConfigured(spaceID: String) -> Bool {
    configuredProfileIDs.contains(spaceID)
  }

  public func start() async {
    if previewsOnly {
      started = true
      return
    }
    guard !started else {
      await refreshProfiles()
      return
    }
    started = true
    eventTask = Task { [weak self, client] in
      for await event in client.events {
        guard !Task.isCancelled else { return }
        await self?.handle(event)
      }
    }
    await refreshProfiles()
  }

  public func stop() async {
    started = false
    configurationGeneration += 1
    reconnectTask?.cancel()
    reconnectTask = nil
    eventTask?.cancel()
    eventTask = nil
    for task in awaitingTasks.values { task.cancel() }
    awaitingTasks = [:]
    await client.disconnect()
    connectionState = .idle
    messagesByProfile = [:]
    unreadByProfile = [:]
    typingProfiles = []
    awaitingProfiles = []
    configuredProfileIDs = []
    cryptos = [:]
    histories = [:]
    lastSequences = [:]
  }

  public func refreshProfiles() async {
    guard started, !isRefreshing else { return }
    isRefreshing = true
    defer { isRefreshing = false }
    do {
      let remote = try await api.hermesChatProfiles()
      profiles = try Self.validate(profiles: remote)
      cacheProfiles(profiles)
      errorMessage = nil
    } catch {
      let cached = cachedProfiles()
      if !cached.isEmpty {
        profiles = cached
      } else {
        errorMessage = Self.message(error)
      }
    }
    if selectedProfileID == nil || !profiles.contains(where: { $0.id == selectedProfileID }) {
      selectedProfileID = profiles.first?.id
    }
    await configureLocalProfilesAndConnect()
  }

  @discardableResult
  public func saveKey(_ encodedKey: String, spaceID: String) async -> Bool {
    do {
      _ = try HermesChatCrypto(encodedKey: encodedKey)
      try keyStore.saveKey(
        encodedKey.trimmingCharacters(in: .whitespacesAndNewlines),
        spaceID: spaceID
      )
      errorMessage = nil
      await configureLocalProfilesAndConnect()
      return true
    } catch {
      errorMessage = Self.message(error)
      return false
    }
  }

  public func removeKey(spaceID: String) async {
    do {
      if let history = histories[spaceID] { await history.removeLocalSnapshot() }
      await attachmentCache.clear(spaceID: spaceID)
      try keyStore.removeKey(spaceID: spaceID)
      configuredProfileIDs.remove(spaceID)
      cryptos.removeValue(forKey: spaceID)
      histories.removeValue(forKey: spaceID)
      lastSequences.removeValue(forKey: spaceID)
      messagesByProfile[spaceID] = []
      unreadByProfile[spaceID] = 0
      await configureLocalProfilesAndConnect()
    } catch {
      errorMessage = Self.message(error)
    }
  }

  public func selectProfile(_ spaceID: String?) {
    selectedProfileID = spaceID
    if let spaceID { unreadByProfile[spaceID] = 0 }
  }

  public func setApplicationActive(_ active: Bool) {
    applicationActive = active
    if active, let selectedProfileID { unreadByProfile[selectedProfileID] = 0 }
  }

  public func reconnect() async {
    reconnectTask?.cancel()
    reconnectTask = nil
    reconnectAttempt = 0
    await connectConfiguredProfiles()
  }

  public func send(
    text: String,
    fileURLs: [URL] = []
  ) async -> Bool {
    guard let spaceID = selectedProfileID,
      let crypto = cryptos[spaceID],
      !isSending
    else {
      errorMessage = "请先为当前 Hermes profile 配置聊天密钥。"
      return false
    }
    let normalized = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalized.isEmpty || !fileURLs.isEmpty else { return false }
    guard fileURLs.count <= 8 else {
      errorMessage = "一条消息最多发送 8 个附件。"
      return false
    }

    isSending = true
    defer { isSending = false }
    do {
      var descriptors: [HermesChatAttachmentDescriptor] = []
      for url in fileURLs {
        guard HermesChatAttachmentPolicy.kind(filename: url.lastPathComponent) != nil else {
          throw HermesChatStoreError.unsupportedAttachment(url.lastPathComponent)
        }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
        guard values.isRegularFile == true, let size = values.fileSize,
          size > 0, size <= HermesChatCrypto.maximumAttachmentBytes
        else { throw HermesChatStoreError.invalidAttachmentSize }
        let plaintext = try Data(contentsOf: url, options: [.mappedIfSafe])
        let encrypted = try crypto.encryptAttachment(
          plaintext,
          contentType: HermesChatAttachmentPolicy.contentType(for: url),
          filename: url.lastPathComponent
        )
        try await api.uploadHermesChatAttachment(
          spaceID: spaceID,
          attachmentID: encrypted.descriptor.id,
          ciphertext: encrypted.ciphertext
        )
        await attachmentCache.store(
          encrypted.ciphertext,
          for: encrypted.descriptor,
          spaceID: spaceID
        )
        descriptors.append(encrypted.descriptor)
      }

      let message = try await client.sendMessage(
        spaceID: spaceID,
        text: normalized,
        attachments: descriptors
      )
      apply(message, spaceID: spaceID, countUnread: false)
      if let history = histories[spaceID] {
        _ = await history.record(message)
      }
      markAwaiting(spaceID)
      await client.sendTyping(spaceID: spaceID, active: false)
      return true
    } catch {
      errorMessage = Self.message(error)
      return false
    }
  }

  public func sendTyping(active: Bool) async {
    guard let selectedProfileID else { return }
    await client.sendTyping(spaceID: selectedProfileID, active: active)
  }

  public func chooseInteractionOption(
    message: HermesChatMessage,
    option: HermesChatInteractionOption
  ) async {
    guard let spaceID = selectedProfileID, let interaction = message.interaction,
      interaction.state == "pending", !option.disabled
    else { return }
    do {
      _ = try await client.sendInteractionAction(
        spaceID: spaceID,
        promptID: interaction.id,
        optionID: option.id
      )
      markAwaiting(spaceID)
    } catch {
      errorMessage = Self.message(error)
    }
  }

  public func attachmentData(
    _ descriptor: HermesChatAttachmentDescriptor,
    spaceID: String
  ) async throws -> Data {
    guard !descriptor.isPrivateR2 else { throw HermesChatCryptoError.invalidAttachment }
    guard let crypto = cryptos[spaceID] else { throw HermesChatCryptoError.invalidKey }
    let ciphertext: Data
    if let cached = await attachmentCache.data(for: descriptor, spaceID: spaceID) {
      ciphertext = cached
    } else {
      ciphertext = try await api.downloadHermesChatAttachment(
        spaceID: spaceID,
        attachmentID: descriptor.id
      )
      await attachmentCache.store(ciphertext, for: descriptor, spaceID: spaceID)
    }
    return try crypto.decryptAttachment(ciphertext, descriptor: descriptor)
  }

  public func attachmentFile(
    _ descriptor: HermesChatAttachmentDescriptor,
    spaceID: String
  ) async throws -> URL {
    if !descriptor.isPrivateR2 {
      return try Self.writeTemporaryAttachment(
        try await attachmentData(descriptor, spaceID: spaceID),
        descriptor: descriptor,
        spaceID: spaceID
      )
    }
    if let cached = await attachmentCache.privateFile(for: descriptor, spaceID: spaceID) {
      return cached
    }
    let ticket = try await api.hermesChatDirectDownloadTicket(
      spaceID: spaceID,
      attachmentID: descriptor.id
    )
    guard ticket.attachmentId == descriptor.id,
      ticket.storage == HermesChatCrypto.privateAttachmentStorage,
      ticket.plaintextBytes == descriptor.plaintextBytes,
      ticket.sha256 == descriptor.sha256
    else { throw HermesChatCryptoError.invalidAttachment }
    let staging = FileManager.default.temporaryDirectory
      .appendingPathComponent("MyNotes-Hermes-Downloads", isDirectory: true)
      .appendingPathComponent(UUID().uuidString.lowercased(), isDirectory: false)
    _ = try await api.downloadHermesChatDirectAttachment(ticket: ticket, to: staging)
    return try await attachmentCache.storePrivateDownloadedFile(
      staging,
      for: descriptor,
      spaceID: spaceID
    )
  }

  public func deleteMessages(_ messages: [HermesChatMessage], spaceID: String) async -> Bool {
    let confirmed = messages.filter { $0.sequence > 0 }
    guard !confirmed.isEmpty, confirmed.count <= 100 else {
      errorMessage = "只能删除 1 到 100 条已同步消息。"
      return false
    }
    let ids = confirmed.map(\.id)
    let descriptors = confirmed.flatMap(\.attachments)
    do {
      _ = try await api.deleteHermesChatMessages(
        spaceID: spaceID,
        messageIDs: ids,
        attachmentIDs: descriptors.map(\.id)
      )
      let idSet = Set(ids)
      messagesByProfile[spaceID]?.removeAll { idSet.contains($0.id) }
      if let history = histories[spaceID] { _ = await history.deleteMessages(ids: idSet) }
      for descriptor in descriptors {
        await attachmentCache.remove(descriptor: descriptor, spaceID: spaceID)
      }
      return true
    } catch {
      errorMessage = Self.message(error)
      return false
    }
  }

  public func purgeProfile(spaceID: String) async -> Bool {
    do {
      _ = try await api.purgeHermesChat(spaceID: spaceID)
      messagesByProfile[spaceID] = []
      unreadByProfile[spaceID] = 0
      if let history = histories[spaceID] { _ = await history.clearMessages() }
      await attachmentCache.clear(spaceID: spaceID)
      return true
    } catch {
      errorMessage = Self.message(error)
      return false
    }
  }

  public func setRetentionDays(_ days: Int) async {
    guard [0, 7, 30, 90].contains(days) else { return }
    retentionDays = days
    defaults.set(days, forKey: "hermes_chat_retention_days_v1")
    for (spaceID, history) in histories {
      let snapshot = await history.loadAndCleanup(retentionDays: days)
      messagesByProfile[spaceID] = snapshot.messages
      lastSequences[spaceID] = snapshot.lastSequence
      await attachmentCache.cleanup(spaceID: spaceID, retentionDays: days)
    }
  }

  public func clearError() { errorMessage = nil }

  private func configureLocalProfilesAndConnect() async {
    configurationGeneration += 1
    let generation = configurationGeneration
    var nextCryptos: [String: HermesChatCrypto] = [:]
    var nextHistories: [String: HermesChatHistoryStore] = [:]
    var nextMessages = messagesByProfile
    var nextSequences: [String: Int64] = [:]
    var configured = Set<String>()

    for profile in profiles {
      guard let encodedKey = keyStore.loadKey(spaceID: profile.id) else {
        nextMessages[profile.id] = []
        continue
      }
      do {
        let crypto = try HermesChatCrypto(encodedKey: encodedKey)
        let history = try HermesChatHistoryStore(spaceID: profile.id, crypto: crypto)
        let snapshot = await history.loadAndCleanup(retentionDays: retentionDays)
        await attachmentCache.cleanup(spaceID: profile.id, retentionDays: retentionDays)
        guard generation == configurationGeneration else { return }
        nextCryptos[profile.id] = crypto
        nextHistories[profile.id] = history
        nextMessages[profile.id] = snapshot.messages
        nextSequences[profile.id] = snapshot.lastSequence
        configured.insert(profile.id)
      } catch {
        errorMessage = "\(profile.label)：\(Self.message(error))"
      }
    }
    guard generation == configurationGeneration else { return }
    cryptos = nextCryptos
    histories = nextHistories
    messagesByProfile = nextMessages.filter { id, _ in profiles.contains { $0.id == id } }
    lastSequences = nextSequences
    configuredProfileIDs = configured
    await connectConfiguredProfiles()
  }

  private func connectConfiguredProfiles() async {
    reconnectTask?.cancel()
    reconnectTask = nil
    guard started, !configuredProfileIDs.isEmpty else {
      await client.disconnect()
      connectionState = .idle
      return
    }
    connectionState = .connecting
    do {
      let ids = profiles.map(\.id).filter(configuredProfileIDs.contains)
      let ticket = try await api.hermesChatMultiplexTicket(spaceIDs: ids)
      let configurations = try ids.map { id in
        guard let crypto = cryptos[id] else { throw HermesChatCryptoError.invalidKey }
        return HermesChatClientProfile(
          spaceID: id,
          crypto: crypto,
          lastSequence: lastSequences[id] ?? 0
        )
      }
      await client.connect(ticket: ticket, profileConfigurations: configurations)
    } catch {
      handleDisconnect(reason: Self.message(error))
    }
  }

  private func handle(_ event: HermesChatClientEvent) async {
    guard started else { return }
    switch event {
    case .ready:
      reconnectAttempt = 0
      connectionState = .connected
    case .message(let spaceID, let message):
      lastSequences[spaceID] = max(lastSequences[spaceID] ?? 0, message.sequence)
      let countUnread = message.isAgent && message.replaceSequence == 0
        && (!applicationActive || selectedProfileID != spaceID)
      apply(message, spaceID: spaceID, countUnread: countUnread)
      if message.isAgent {
        cancelAwaiting(spaceID)
        typingProfiles.remove(spaceID)
      }
      if let history = histories[spaceID] {
        _ = await history.record(message)
      }
    case .acknowledged(let spaceID, let messageID, let sequence):
      if let index = messagesByProfile[spaceID]?.firstIndex(where: { $0.id == messageID }) {
        messagesByProfile[spaceID]?[index].sequence = sequence
      }
      lastSequences[spaceID] = max(lastSequences[spaceID] ?? 0, sequence)
      if let history = histories[spaceID] {
        _ = await history.acknowledge(messageID: messageID, sequence: sequence)
      }
    case .actionAcknowledged(_, _, let delivered):
      if !delivered { errorMessage = "Hermes Agent 当前未连接，操作没有执行。" }
    case .typing(let spaceID, let active):
      if active {
        typingProfiles.insert(spaceID)
        markAwaiting(spaceID)
      } else {
        typingProfiles.remove(spaceID)
      }
    case .profileError(_, let reason):
      errorMessage = reason
    case .disconnected(let reason):
      handleDisconnect(reason: reason)
    }
  }

  private func apply(
    _ incoming: HermesChatMessage,
    spaceID: String,
    countUnread: Bool
  ) {
    var messages = messagesByProfile[spaceID] ?? []
    if incoming.replaceSequence > 0 {
      if let index = messages.firstIndex(where: { $0.sequence == incoming.replaceSequence }) {
        messages[index].text = incoming.text
        if !incoming.attachments.isEmpty { messages[index].attachments = incoming.attachments }
        messages[index].interaction = incoming.interaction
      } else if incoming.finalUpdate {
        var standalone = incoming
        standalone.replaceSequence = 0
        standalone.finalUpdate = false
        messages.append(standalone)
      }
    } else if let index = messages.firstIndex(where: { $0.id == incoming.id }) {
      messages[index] = incoming
    } else {
      messages.append(incoming)
    }
    messages.sort {
      if $0.sentAt != $1.sentAt { return $0.sentAt < $1.sentAt }
      if $0.sequence != $1.sequence { return $0.sequence < $1.sequence }
      return $0.id < $1.id
    }
    if messages.count > 20_000 { messages.removeFirst(messages.count - 20_000) }
    messagesByProfile[spaceID] = messages
    if countUnread { unreadByProfile[spaceID, default: 0] += 1 }
  }

  private func markAwaiting(_ spaceID: String) {
    awaitingProfiles.insert(spaceID)
    awaitingTasks[spaceID]?.cancel()
    awaitingTasks[spaceID] = Task { [weak self] in
      try? await Task.sleep(for: .seconds(120))
      guard !Task.isCancelled else { return }
      await MainActor.run {
        self?.awaitingProfiles.remove(spaceID)
        self?.awaitingTasks.removeValue(forKey: spaceID)
      }
    }
  }

  private func cancelAwaiting(_ spaceID: String) {
    awaitingTasks.removeValue(forKey: spaceID)?.cancel()
    awaitingProfiles.remove(spaceID)
  }

  private func handleDisconnect(reason: String) {
    guard started else { return }
    connectionState = .disconnected(reason)
    reconnectTask?.cancel()
    let exponent = min(reconnectAttempt, 4)
    let base = min(45.0, 2.0 * pow(2.0, Double(exponent)))
    let jitter = Double.random(in: 0...(base / 4))
    reconnectAttempt += 1
    reconnectTask = Task { [weak self] in
      try? await Task.sleep(for: .seconds(base + jitter))
      guard !Task.isCancelled else { return }
      await self?.connectConfiguredProfiles()
    }
  }

  private func cacheProfiles(_ profiles: [HermesChatProfile]) {
    guard let data = try? JSONEncoder().encode(profiles) else { return }
    defaults.set(data, forKey: "hermes_chat_profiles_v1")
  }

  private func cachedProfiles() -> [HermesChatProfile] {
    guard let data = defaults.data(forKey: "hermes_chat_profiles_v1"),
      let decoded = try? JSONDecoder().decode([HermesChatProfile].self, from: data)
    else { return [] }
    return (try? Self.validate(profiles: decoded)) ?? []
  }

  private static func validate(profiles: [HermesChatProfile]) throws -> [HermesChatProfile] {
    guard !profiles.isEmpty, profiles.count <= 32 else { throw HermesChatStoreError.invalidProfiles }
    var seen = Set<String>()
    return try profiles.map { profile in
      let id = profile.id.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
      let label = profile.label.trimmingCharacters(in: .whitespacesAndNewlines)
      guard id.range(of: "^[a-z0-9][a-z0-9_-]{0,63}$", options: .regularExpression)
        == id.startIndex..<id.endIndex,
        !label.isEmpty, label.count <= 40, seen.insert(id).inserted
      else { throw HermesChatStoreError.invalidProfiles }
      return HermesChatProfile(id: id, label: label)
    }
  }

  private static func message(_ error: Error) -> String {
    if let value = (error as? LocalizedError)?.errorDescription, !value.isEmpty { return value }
    let value = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
    return value.isEmpty ? "Hermes 操作失败，请稍后重试。" : value
  }

  private static func writeTemporaryAttachment(
    _ data: Data,
    descriptor: HermesChatAttachmentDescriptor,
    spaceID: String
  ) throws -> URL {
    let base = FileManager.default.temporaryDirectory
      .appendingPathComponent("MyNotes-Hermes", isDirectory: true)
      .appendingPathComponent(spaceID, isDirectory: true)
    try FileManager.default.createDirectory(
      at: base,
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700]
    )
    let filename = URL(fileURLWithPath: descriptor.name).lastPathComponent
    let url = base.appendingPathComponent("\(descriptor.id)-\(filename)", isDirectory: false)
    try data.write(to: url, options: [.atomic])
    try? FileManager.default.setAttributes(
      [.posixPermissions: 0o600],
      ofItemAtPath: url.path
    )
    return url
  }
}

#if DEBUG
  private final class PreviewHermesKeyStore: HermesChatKeyStoring, @unchecked Sendable {
    func loadKey(spaceID: String) -> String? { nil }
    func saveKey(_ key: String, spaceID: String) throws {}
    func removeKey(spaceID: String) throws {}
  }
#endif

public enum HermesChatStoreError: LocalizedError, Sendable {
  case invalidProfiles
  case unsupportedAttachment(String)
  case invalidAttachmentSize

  public var errorDescription: String? {
    switch self {
    case .invalidProfiles: "Hermes profile 配置无效。"
    case .unsupportedAttachment(let name): "暂不支持附件“\(name)”的文件类型。"
    case .invalidAttachmentSize: "附件必须是 10 MiB 以内的普通文件。"
    }
  }
}

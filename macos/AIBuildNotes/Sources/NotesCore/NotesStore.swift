import Combine
import CryptoKit
import Foundation

@MainActor
public final class NotesStore: ObservableObject {
  @Published public private(set) var user: AdminUser?
  @Published public private(set) var activeNotes: [NoteDocument] = []
  @Published public private(set) var trashedNotes: [NoteDocument] = []
  @Published public private(set) var folders: [NoteFolder] = []
  @Published public var location: NoteLocation = .allNotes
  @Published public var selectedID: String?
  @Published public var searchQuery = ""
  @Published public private(set) var saveState: NoteSaveState = .idle
  @Published public private(set) var isWorking = false
  @Published public private(set) var errorMessage: String?
  @Published public private(set) var protectionKeyring: NoteProtectionKeyring?
  @Published public private(set) var unlockedProtectedNoteID: String?

  private let api: NotesAPIClient
  private var dataKey: SymmetricKey?
  private var protectionKey: SymmetricKey?
  private var autoSaveTasks: [String: Task<Void, Never>] = [:]
  private var dirtyNoteIDs: Set<String> = []
  private let autoSaveDelay: Duration

  public init(
    api: NotesAPIClient = NotesAPIClient(),
    autoSaveDelay: Duration = .seconds(10)
  ) {
    self.api = api
    self.autoSaveDelay = autoSaveDelay
  }

  #if DEBUG
    public static func preview() -> NotesStore {
      let store = NotesStore(
        api: NotesAPIClient(baseURL: URL(string: "http://127.0.0.1:9/")!),
        autoSaveDelay: .seconds(3_600)
      )
      store.user = AdminUser(username: "star", mustChangePassword: false)
      store.folders = [
        previewFolder(id: "folder_linux", name: "Linux"),
        previewFolder(id: "folder_logs", name: "日期记录"),
        previewFolder(id: "folder_accounts", name: "账号信息"),
      ]
      store.activeNotes = [
        previewDocument(
          id: "preview_0001",
          folderId: "folder_linux",
          title: "macOS 记事本开发记录",
          content: "整理 API、CryptoKit 加密兼容和 SwiftUI 三栏布局。",
          updatedAt: "2026-08-14T09:30:00.000Z"
        ),
        previewDocument(
          id: "preview_0002",
          folderId: "folder_logs",
          title: "Cloudflare 部署检查",
          content: "应用 D1 migration，再部署 Worker，最后验证回收站接口。",
          updatedAt: "2026-08-13T16:20:00.000Z"
        ),
        previewDocument(
          id: "preview_0003",
          folderId: nil,
          title: "搜索功能",
          content: "搜索只在解锁后的本地明文内存中执行，不上传关键词。",
          updatedAt: "2026-08-12T11:00:00.000Z"
        ),
        previewDocument(
          id: "preview_0004",
          folderId: "folder_accounts",
          title: "账号安全约定",
          content: "文件夹名称与笔记内容一样，只以密文保存到服务器。",
          updatedAt: "2026-08-10T11:00:00.000Z",
          isProtected: true
        ),
      ]
      store.trashedNotes = [
        previewDocument(
          id: "preview_trash",
          folderId: nil,
          title: "旧版本草稿",
          content: "这是一篇可以恢复的示例笔记。",
          updatedAt: "2026-08-11T08:00:00.000Z",
          deletedAt: "2026-08-14T08:00:00.000Z"
        )
      ]
      store.selectedID = store.activeNotes.first?.id
      return store
    }

    private static func previewFolder(id: String, name: String) -> NoteFolder {
      NoteFolder(
        envelope: EncryptedFolderEnvelope(
          id: id,
          version: 1,
          ciphertext: "preview",
          nonce: "preview"
        ),
        content: FolderContent(name: name)
      )
    }

    private static func previewDocument(
      id: String,
      folderId: String?,
      title: String,
      content: String,
      updatedAt: String,
      deletedAt: String? = nil,
      isProtected: Bool = false
    ) -> NoteDocument {
      NoteDocument(
        envelope: EncryptedNoteEnvelope(
          id: id,
          folderId: folderId,
          version: 1,
          ciphertext: "preview",
          nonce: "preview",
          createdAt: updatedAt,
          updatedAt: updatedAt,
          deletedAt: deletedAt,
          isLocked: isProtected
        ),
        content: NoteContent(title: title, content: content)
      )
    }
  #endif

  deinit {
    for task in autoSaveTasks.values { task.cancel() }
  }

  public var visibleNotes: [NoteDocument] {
    let scoped: [NoteDocument]
    switch location {
    case .allNotes:
      scoped = activeNotes
    case .unfiled:
      scoped = activeNotes.filter { $0.belongs(to: nil) }
    case .folder(let id):
      scoped = activeNotes.filter { $0.belongs(to: id) }
    case .trash:
      scoped = trashedNotes
    }
    return scoped.filter { $0.matches(search: searchQuery) }
  }

  public var selectedDocument: NoteDocument? {
    let source = location.isTrash ? trashedNotes : activeNotes
    return source.first { $0.id == selectedID }
  }

  public var hasProtectionPassword: Bool { protectionKeyring != nil }

  public func isUnlocked(_ document: NoteDocument) -> Bool {
    document.isProtected && unlockedProtectedNoteID == document.id && protectionKey != nil
  }

  public var locationTitle: String {
    switch location {
    case .allNotes: "全部笔记"
    case .unfiled: "未分类"
    case .folder(let id): folderName(for: id)
    case .trash: "回收站"
    }
  }

  public func folderName(for id: String?) -> String {
    guard let id else { return "未分类" }
    return folders.first(where: { $0.id == id })?.name ?? "未分类"
  }

  public func noteCount(in folderId: String?) -> Int {
    activeNotes.count { $0.folderId == folderId }
  }

  public func start() async {
    guard user == nil, !isWorking else { return }
    isWorking = true
    defer { isWorking = false }
    do {
      guard let restoredUser = try await api.restoreSession() else { return }
      user = restoredUser
      try await loadWorkspace()
    } catch {
      clearSensitiveState()
      errorMessage = friendlyMessage(error)
    }
  }

  public func login(username: String, password: String) async {
    guard !isWorking else { return }
    isWorking = true
    errorMessage = nil
    defer { isWorking = false }
    do {
      user = try await api.login(username: username, password: password)
      try await loadWorkspace()
    } catch {
      clearSensitiveState()
      errorMessage = friendlyMessage(error)
    }
  }

  public func logout() async {
    await flushPendingSaves()
    await api.logout()
    clearSensitiveState()
  }

  public func refresh() async {
    guard user != nil, !isWorking else { return }
    await flushPendingSaves()
    isWorking = true
    defer { isWorking = false }
    do {
      try await loadWorkspace()
    } catch {
      errorMessage = friendlyMessage(error)
    }
  }

  public func selectLocation(_ newLocation: NoteLocation) {
    location = newLocation
    searchQuery = ""
    selectedID = visibleNotes.first?.id
    saveState = .idle
  }

  public func updateSearchQuery(_ query: String) {
    searchQuery = query
    if let selectedID, visibleNotes.contains(where: { $0.id == selectedID }) {
      return
    }
    selectedID = visibleNotes.first?.id
  }

  public func createNote() async {
    guard !location.isTrash, let dataKey else { return }
    let id = UUID().uuidString.lowercased()
    let content = NoteContent(title: "无标题笔记", content: "")
    do {
      let payload = try NoteCrypto.encrypt(content, id: id, using: dataKey)
      var envelope = try await api.create(payload)
      if case .folder(let folderId) = location {
        let state = try await api.moveNote(
          id: id,
          folderId: folderId,
          revision: envelope.revision
        )
        apply(state, to: &envelope)
      }
      activeNotes.insert(NoteDocument(envelope: envelope, content: content), at: 0)
      selectedID = id
      searchQuery = ""
      saveState = .saved
    } catch {
      errorMessage = friendlyMessage(error)
    }
  }

  public func createFolder(name: String) async {
    guard let dataKey else { return }
    let content = FolderContent(name: name).normalized()
    guard !content.name.isEmpty else { return }
    let id = UUID().uuidString.lowercased()
    do {
      let payload = try FolderCrypto.encrypt(content, id: id, using: dataKey)
      let envelope = try await api.createFolder(payload)
      folders.append(NoteFolder(envelope: envelope, content: content))
      selectLocation(.folder(id))
    } catch {
      errorMessage = friendlyMessage(error)
    }
  }

  public func renameFolder(id: String, name: String) async {
    guard let dataKey,
      let index = folders.firstIndex(where: { $0.id == id })
    else { return }
    let content = FolderContent(name: name).normalized()
    guard !content.name.isEmpty else { return }
    do {
      let payload = try FolderCrypto.encrypt(content, id: id, using: dataKey)
      let envelope = try await api.updateFolder(
        payload,
        revision: folders[index].envelope.revision
      )
      guard let current = folders.firstIndex(where: { $0.id == id }) else { return }
      folders[current] = NoteFolder(envelope: envelope, content: content)
    } catch {
      handleMutationError(error)
    }
  }

  public func deleteFolder(id: String) async {
    guard let folder = folders.first(where: { $0.id == id }) else { return }
    await flushPendingSaves()
    do {
      try await api.deleteFolder(id: id, revision: folder.envelope.revision)
      if location == .folder(id) { location = .allNotes }
      try await loadWorkspace()
    } catch {
      handleMutationError(error)
    }
  }

  public func moveFolder(id: String, offset: Int) async {
    guard offset != 0,
      let source = folders.firstIndex(where: { $0.id == id })
    else { return }
    let destination = source + offset
    guard folders.indices.contains(destination) else { return }

    let previous = folders
    folders.swapAt(source, destination)
    do {
      let envelopes = try await api.reorderFolders(ids: folders.map(\.id))
      let contentByID = Dictionary(uniqueKeysWithValues: folders.map { ($0.id, $0.content) })
      let reordered = envelopes.compactMap { envelope in
        contentByID[envelope.id].map { NoteFolder(envelope: envelope, content: $0) }
      }
      guard reordered.count == folders.count else {
        folders = previous
        errorMessage = "服务器返回的文件夹顺序不完整，请刷新后重试。"
        return
      }
      folders = reordered
    } catch {
      folders = previous
      handleMutationError(error)
    }
  }

  public func updateSelectedTitle(_ title: String) {
    updateSelected { $0.title = title }
  }

  public func updateSelectedContent(_ content: String) {
    updateSelected { $0.content = content }
  }

  @discardableResult
  public func saveSelected() async -> Bool {
    guard !location.isTrash, let id = selectedID else { return true }
    return await save(id: id)
  }

  public func setupAndProtectSelected(password: String, confirmation: String) async throws {
    guard password == confirmation else { throw NoteUnlockError.confirmationMismatch }
    guard protectionKeyring == nil else {
      try await protectSelected(password: password)
      return
    }
    let created = try NoteProtectionCrypto.createKeyring(password: password)
    let keyring = try await api.createProtectionKeyring(created.payload)
    protectionKeyring = keyring
    try await protectSelected(using: created.key)
  }

  public func protectSelected(password: String) async throws {
    guard let keyring = protectionKeyring else { throw NoteUnlockError.notConfigured }
    let key = try NoteProtectionCrypto.unlockKeyring(keyring, password: password)
    try await protectSelected(using: key)
  }

  public func unlockSelected(password: String) throws {
    guard let id = selectedID,
      let index = activeNotes.firstIndex(where: { $0.id == id }),
      activeNotes[index].isProtected,
      let protectedContent = activeNotes[index].content.protectedContent,
      let keyring = protectionKeyring
    else { throw NoteUnlockError.notConfigured }
    let key = try NoteProtectionCrypto.unlockKeyring(keyring, password: password)
    let plaintext = try NoteProtectionCrypto.decryptBody(
      protectedContent,
      noteID: id,
      using: key
    )
    protectionKey = key
    unlockedProtectedNoteID = id
    activeNotes[index].content.content = plaintext
  }

  public func unprotectSelected() async throws {
    guard let id = selectedID,
      unlockedProtectedNoteID == id,
      let index = activeNotes.firstIndex(where: { $0.id == id })
    else { throw NoteUnlockError.incorrectPassword }
    activeNotes[index].content.protectedContent = nil
    activeNotes[index].envelope.isLocked = false
    dirtyNoteIDs.insert(id)
    guard await performSave(id: id) else { throw NotesAPIError.invalidResponse }
    protectionKey = nil
    unlockedProtectedNoteID = nil
  }

  public func relock(noteID: String? = nil) async {
    guard let unlockedID = unlockedProtectedNoteID,
      noteID == nil || noteID == unlockedID
    else { return }
    _ = await save(id: unlockedID)
    if let index = activeNotes.firstIndex(where: { $0.id == unlockedID }) {
      activeNotes[index].content.content = ""
    }
    protectionKey = nil
    unlockedProtectedNoteID = nil
  }

  public func moveSelected(to folderId: String?) async {
    guard !location.isTrash, let id = selectedID else { return }
    guard await save(id: id),
      let index = activeNotes.firstIndex(where: { $0.id == id })
    else { return }
    do {
      let state = try await api.moveNote(
        id: id,
        folderId: folderId,
        revision: activeNotes[index].envelope.revision
      )
      guard let current = activeNotes.firstIndex(where: { $0.id == id }) else { return }
      apply(state, to: &activeNotes[current].envelope)
      if !visibleNotes.contains(where: { $0.id == id }) {
        selectedID = visibleNotes.first?.id
      }
      saveState = .saved
    } catch {
      handleMutationError(error)
    }
  }

  public func moveSelectedToTrash() async {
    guard !location.isTrash,
      let id = selectedID,
      let index = activeNotes.firstIndex(where: { $0.id == id })
    else { return }
    guard await save(id: id) else { return }
    do {
      var document = activeNotes[index]
      let state = try await api.moveToTrash(id: id, revision: document.envelope.revision)
      apply(state, to: &document.envelope)
      activeNotes.remove(at: index)
      trashedNotes.insert(document, at: 0)
      selectedID = visibleNotes.first?.id
      saveState = .idle
    } catch {
      handleMutationError(error)
    }
  }

  public func restoreSelected() async {
    guard location.isTrash,
      let id = selectedID,
      let index = trashedNotes.firstIndex(where: { $0.id == id })
    else { return }
    do {
      var document = trashedNotes[index]
      let state = try await api.restore(id: id, revision: document.envelope.revision)
      apply(state, to: &document.envelope)
      trashedNotes.remove(at: index)
      activeNotes.insert(document, at: 0)
      selectedID = trashedNotes.first?.id
    } catch {
      handleMutationError(error)
    }
  }

  public func purgeSelected() async {
    guard location.isTrash,
      let id = selectedID,
      let index = trashedNotes.firstIndex(where: { $0.id == id })
    else { return }
    do {
      try await api.purge(id: id, revision: trashedNotes[index].envelope.revision)
      trashedNotes.remove(at: index)
      selectedID = trashedNotes.first?.id
    } catch {
      handleMutationError(error)
    }
  }

  public func clearError() {
    errorMessage = nil
  }

  private func loadWorkspace() async throws {
    async let rawKey = api.workspaceKey()
    async let activeEnvelopes = api.listNotes(inTrash: false)
    async let trashEnvelopes = api.listNotes(inTrash: true)
    async let folderEnvelopes = api.listFolders()
    async let remoteProtectionKeyring = api.protectionKeyring()

    let key = try NoteCrypto.importDataKey(await rawKey)
    let active = try await activeEnvelopes
    let trash = try await trashEnvelopes
    let encryptedFolders = try await folderEnvelopes
    protectionKeyring = try await remoteProtectionKeyring
    activeNotes = try active.map {
      NoteDocument(envelope: $0, content: try NoteCrypto.decrypt($0, using: key))
    }
    trashedNotes = try trash.map {
      NoteDocument(envelope: $0, content: try NoteCrypto.decrypt($0, using: key))
    }
    folders = try encryptedFolders.map {
      NoteFolder(envelope: $0, content: try FolderCrypto.decrypt($0, using: key))
    }
    dataKey = key
    protectionKey = nil
    unlockedProtectedNoteID = nil
    if case .folder(let id) = location, !folders.contains(where: { $0.id == id }) {
      location = .allNotes
    }
    selectedID = visibleNotes.first?.id
    saveState = .idle
  }

  private func updateSelected(_ mutation: (inout NoteContent) -> Void) {
    guard !location.isTrash,
      let id = selectedID,
      let index = activeNotes.firstIndex(where: { $0.id == id })
    else { return }
    if activeNotes[index].isProtected && unlockedProtectedNoteID != id { return }
    mutation(&activeNotes[index].content)
    dirtyNoteIDs.insert(id)
    saveState = .dirty
    scheduleSave(id: id)
  }

  private func scheduleSave(id: String) {
    autoSaveTasks[id]?.cancel()
    let delay = autoSaveDelay
    autoSaveTasks[id] = Task { [weak self] in
      do {
        try await Task.sleep(for: delay)
        guard !Task.isCancelled else { return }
        await self?.runScheduledSave(id: id)
      } catch {
        return
      }
    }
  }

  private func runScheduledSave(id: String) async {
    // The debounce task is the entry stored for this note. Clear the handle
    // without cancelling it, otherwise URLSession inherits a cancelled task
    // and aborts every automatic save before the request reaches the Worker.
    autoSaveTasks[id] = nil
    _ = await performSave(id: id)
  }

  @discardableResult
  private func save(id: String) async -> Bool {
    autoSaveTasks[id]?.cancel()
    autoSaveTasks[id] = nil
    guard dirtyNoteIDs.contains(id) else { return true }
    return await performSave(id: id)
  }

  @discardableResult
  private func performSave(id: String) async -> Bool {
    guard let dataKey,
      let index = activeNotes.firstIndex(where: { $0.id == id })
    else { return true }

    var snapshot = activeNotes[index].content
    let isLocked = activeNotes[index].envelope.isLocked
    if isLocked {
      guard unlockedProtectedNoteID == id, let protectionKey else { return true }
      do {
        snapshot.protectedContent = try NoteProtectionCrypto.encryptBody(
          snapshot.content,
          noteID: id,
          using: protectionKey
        )
      } catch {
        handleMutationError(error)
        return false
      }
    }
    let revision = activeNotes[index].envelope.revision
    saveState = .saving
    do {
      let payload = try NoteCrypto.encrypt(snapshot, id: id, using: dataKey)
      let envelope = try await api.update(payload, revision: revision)
      guard let currentIndex = activeNotes.firstIndex(where: { $0.id == id }) else {
        return true
      }
      activeNotes[currentIndex].envelope = envelope
      if activeNotes[currentIndex].content.title == snapshot.title
        && activeNotes[currentIndex].content.content == snapshot.content
      {
        activeNotes[currentIndex].content.protectedContent = snapshot.protectedContent
        dirtyNoteIDs.remove(id)
        saveState = .saved
      } else {
        saveState = .dirty
        scheduleSave(id: id)
      }
      return true
    } catch {
      handleMutationError(error)
      return false
    }
  }

  private func flushPendingSaves() async {
    let ids = Array(Set(autoSaveTasks.keys).union(dirtyNoteIDs))
    for id in ids { _ = await save(id: id) }
  }

  private func apply(_ state: NoteMutationState, to envelope: inout EncryptedNoteEnvelope) {
    envelope.folderId = state.folderId
    envelope.revision = state.revision
    envelope.updatedAt = state.updatedAt
    envelope.deletedAt = state.deletedAt
    if let isLocked = state.isLocked { envelope.isLocked = isLocked }
  }

  private func handleMutationError(_ error: Error) {
    if let apiError = error as? NotesAPIError, apiError.status == 409 {
      saveState = .conflict
      errorMessage = "内容已在其他设备修改。请先刷新，确认最新内容后再编辑。"
    } else {
      saveState = .failed
      errorMessage = friendlyMessage(error)
    }
  }

  private func friendlyMessage(_ error: Error) -> String {
    if let apiError = error as? NotesAPIError {
      switch apiError.status {
      case 401: return "登录已过期，请重新登录。"
      case 429: return "登录尝试过多，请稍后再试。"
      default: return apiError.localizedDescription
      }
    }
    return error.localizedDescription
  }

  private func clearSensitiveState() {
    for task in autoSaveTasks.values { task.cancel() }
    autoSaveTasks.removeAll()
    dirtyNoteIDs.removeAll()
    user = nil
    activeNotes.removeAll()
    trashedNotes.removeAll()
    folders.removeAll()
    dataKey = nil
    protectionKey = nil
    protectionKeyring = nil
    unlockedProtectedNoteID = nil
    selectedID = nil
    searchQuery = ""
    location = .allNotes
    saveState = .idle
  }

  private func protectSelected(using key: SymmetricKey) async throws {
    guard let id = selectedID,
      let index = activeNotes.firstIndex(where: { $0.id == id }),
      !activeNotes[index].isProtected
    else { return }
    activeNotes[index].content.protectedContent = try NoteProtectionCrypto.encryptBody(
      activeNotes[index].content.content,
      noteID: id,
      using: key
    )
    activeNotes[index].envelope.isLocked = true
    dirtyNoteIDs.insert(id)
    protectionKey = key
    unlockedProtectedNoteID = id
    guard await performSave(id: id) else { throw NotesAPIError.invalidResponse }
  }
}

import Combine
import CryptoKit
import Foundation

@MainActor
public final class NotesStore: ObservableObject {
  @Published public private(set) var user: AdminUser?
  @Published public private(set) var activeNotes: [NoteDocument] = []
  @Published public private(set) var trashedNotes: [NoteDocument] = []
  @Published public var section: NoteSection = .notes
  @Published public var selectedID: String?
  @Published public var searchQuery = ""
  @Published public private(set) var saveState: NoteSaveState = .idle
  @Published public private(set) var isWorking = false
  @Published public private(set) var errorMessage: String?

  private let api: NotesAPIClient
  private var dataKey: SymmetricKey?
  private var autoSaveTasks: [String: Task<Void, Never>] = [:]

  public init(api: NotesAPIClient = NotesAPIClient()) {
    self.api = api
  }

  #if DEBUG
    public static func preview() -> NotesStore {
      let store = NotesStore()
      store.user = AdminUser(username: "star", mustChangePassword: false)
      store.activeNotes = [
        previewDocument(
          id: "preview_0001",
          title: "macOS 记事本开发记录",
          content: "整理 API、CryptoKit 加密兼容和 SwiftUI 三栏布局。",
          updatedAt: "2026-08-14T09:30:00.000Z"
        ),
        previewDocument(
          id: "preview_0002",
          title: "Cloudflare 部署检查",
          content: "应用 D1 migration，再部署 Worker，最后验证回收站接口。",
          updatedAt: "2026-08-13T16:20:00.000Z"
        ),
        previewDocument(
          id: "preview_0003",
          title: "搜索功能",
          content: "搜索只在解锁后的本地明文内存中执行，不上传关键词。",
          updatedAt: "2026-08-12T11:00:00.000Z"
        ),
      ]
      store.trashedNotes = [
        previewDocument(
          id: "preview_trash",
          title: "旧版本草稿",
          content: "这是一篇可以恢复的示例笔记。",
          updatedAt: "2026-08-11T08:00:00.000Z",
          deletedAt: "2026-08-14T08:00:00.000Z"
        )
      ]
      store.selectedID = store.activeNotes.first?.id
      return store
    }

    private static func previewDocument(
      id: String,
      title: String,
      content: String,
      updatedAt: String,
      deletedAt: String? = nil
    ) -> NoteDocument {
      NoteDocument(
        envelope: EncryptedNoteEnvelope(
          id: id,
          version: 1,
          ciphertext: "preview",
          nonce: "preview",
          createdAt: updatedAt,
          updatedAt: updatedAt,
          deletedAt: deletedAt
        ),
        content: NoteContent(title: title, content: content)
      )
    }
  #endif

  deinit {
    for task in autoSaveTasks.values { task.cancel() }
  }

  public var visibleNotes: [NoteDocument] {
    let source = section == .notes ? activeNotes : trashedNotes
    return source.filter { $0.matches(search: searchQuery) }
  }

  public var selectedDocument: NoteDocument? {
    let source = section == .notes ? activeNotes : trashedNotes
    return source.first { $0.id == selectedID }
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

  public func selectSection(_ newSection: NoteSection) {
    section = newSection
    searchQuery = ""
    selectedID = (newSection == .notes ? activeNotes : trashedNotes).first?.id
    saveState = .idle
  }

  public func createNote() async {
    guard section == .notes, let dataKey else { return }
    let id = UUID().uuidString.lowercased()
    let content = NoteContent(title: "无标题笔记", content: "")
    do {
      let payload = try NoteCrypto.encrypt(content, id: id, using: dataKey)
      let envelope = try await api.create(payload)
      activeNotes.insert(NoteDocument(envelope: envelope, content: content), at: 0)
      selectedID = id
      searchQuery = ""
      saveState = .saved
    } catch {
      errorMessage = friendlyMessage(error)
    }
  }

  public func updateSelectedTitle(_ title: String) {
    updateSelected { $0.title = title }
  }

  public func updateSelectedContent(_ content: String) {
    updateSelected { $0.content = content }
  }

  public func moveSelectedToTrash() async {
    guard section == .notes,
      let id = selectedID,
      let index = activeNotes.firstIndex(where: { $0.id == id })
    else { return }
    guard await save(id: id) else { return }
    do {
      var document = activeNotes[index]
      let state = try await api.moveToTrash(
        id: id,
        revision: document.envelope.revision
      )
      apply(state, to: &document.envelope)
      activeNotes.remove(at: index)
      trashedNotes.insert(document, at: 0)
      selectedID = activeNotes.first?.id
      saveState = .idle
    } catch {
      handleMutationError(error)
    }
  }

  public func restoreSelected() async {
    guard section == .trash,
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
    guard section == .trash,
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

    let key = try NoteCrypto.importDataKey(await rawKey)
    let active = try await activeEnvelopes
    let trash = try await trashEnvelopes
    activeNotes = try active.map {
      NoteDocument(envelope: $0, content: try NoteCrypto.decrypt($0, using: key))
    }
    trashedNotes = try trash.map {
      NoteDocument(envelope: $0, content: try NoteCrypto.decrypt($0, using: key))
    }
    dataKey = key
    selectedID = (section == .notes ? activeNotes : trashedNotes).first?.id
    saveState = .idle
  }

  private func updateSelected(_ mutation: (inout NoteContent) -> Void) {
    guard section == .notes,
      let id = selectedID,
      let index = activeNotes.firstIndex(where: { $0.id == id })
    else { return }
    mutation(&activeNotes[index].content)
    saveState = .saving
    scheduleSave(id: id)
  }

  private func scheduleSave(id: String) {
    autoSaveTasks[id]?.cancel()
    autoSaveTasks[id] = Task { [weak self] in
      do {
        try await Task.sleep(for: .milliseconds(700))
        guard !Task.isCancelled else { return }
        _ = await self?.save(id: id)
      } catch {
        return
      }
    }
  }

  @discardableResult
  private func save(id: String) async -> Bool {
    autoSaveTasks[id]?.cancel()
    autoSaveTasks[id] = nil
    guard let dataKey,
      let index = activeNotes.firstIndex(where: { $0.id == id })
    else { return true }

    let snapshot = activeNotes[index].content
    let revision = activeNotes[index].envelope.revision
    saveState = .saving
    do {
      let payload = try NoteCrypto.encrypt(snapshot, id: id, using: dataKey)
      let envelope = try await api.update(payload, revision: revision)
      guard let currentIndex = activeNotes.firstIndex(where: { $0.id == id }) else {
        return true
      }
      activeNotes[currentIndex].envelope = envelope
      if activeNotes[currentIndex].content == snapshot {
        activeNotes[currentIndex].content = snapshot.normalized()
        saveState = .saved
      } else {
        scheduleSave(id: id)
      }
      return true
    } catch {
      handleMutationError(error)
      return false
    }
  }

  private func flushPendingSaves() async {
    let ids = Array(autoSaveTasks.keys)
    for id in ids { _ = await save(id: id) }
  }

  private func apply(_ state: NoteMutationState, to envelope: inout EncryptedNoteEnvelope) {
    envelope.revision = state.revision
    envelope.updatedAt = state.updatedAt
    envelope.deletedAt = state.deletedAt
  }

  private func handleMutationError(_ error: Error) {
    if let apiError = error as? NotesAPIError, apiError.status == 409 {
      saveState = .conflict
      errorMessage = "这篇笔记已在其他设备修改。请先刷新，确认最新内容后再编辑。"
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
    user = nil
    activeNotes.removeAll()
    trashedNotes.removeAll()
    dataKey = nil
    selectedID = nil
    searchQuery = ""
    section = .notes
    saveState = .idle
  }
}

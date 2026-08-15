import AppKit
import NotesCore
import SwiftUI
import UniformTypeIdentifiers

struct RootView: View {
  @EnvironmentObject private var store: NotesStore
  @State private var columnVisibility: NavigationSplitViewVisibility = .all

  var body: some View {
    Group {
      if store.user == nil {
        LoginView()
      } else {
        workspace
      }
    }
    .alert(
      "提示",
      isPresented: Binding(
        get: { store.errorMessage != nil },
        set: { if !$0 { store.clearError() } }
      )
    ) {
      Button("知道了") { store.clearError() }
    } message: {
      Text(store.errorMessage ?? "")
    }
  }

  private var workspace: some View {
    NavigationSplitView(columnVisibility: $columnVisibility) {
      SidebarView()
        .navigationSplitViewColumnWidth(min: 190, ideal: 225, max: 280)
    } content: {
      NotesListView()
        .navigationSplitViewColumnWidth(min: 300, ideal: 420, max: 640)
    } detail: {
      NoteEditorView()
    }
    .navigationSplitViewStyle(.balanced)
  }
}

private struct LoginView: View {
  @EnvironmentObject private var store: NotesStore
  @State private var username = ""
  @State private var password = ""

  var body: some View {
    ZStack {
      LinearGradient(
        colors: [Color(red: 0.95, green: 0.97, blue: 1), Color(nsColor: .windowBackgroundColor)],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
      )
      .ignoresSafeArea()

      VStack(spacing: 24) {
        Image(systemName: "note.text")
          .font(.system(size: 34, weight: .semibold))
          .foregroundStyle(.white)
          .frame(width: 68, height: 68)
          .background(Color.accentColor.gradient, in: RoundedRectangle(cornerRadius: 18))

        VStack(spacing: 8) {
          Text("My Notes").font(.title.bold())
          Text("登录后读取你的加密笔记")
            .foregroundStyle(.secondary)
        }

        VStack(spacing: 14) {
          TextField("用户名", text: $username)
            .textFieldStyle(.roundedBorder)
          SecureField("密码", text: $password)
            .textFieldStyle(.roundedBorder)
            .onSubmit { submit() }
          Button(action: submit) {
            HStack {
              if store.isWorking { ProgressView().controlSize(.small) }
              Text(store.isWorking ? "正在登录…" : "登录")
                .frame(maxWidth: .infinity)
            }
          }
          .buttonStyle(.borderedProminent)
          .controlSize(.large)
          .disabled(
            username.trimmingCharacters(in: .whitespaces).isEmpty || password.isEmpty
              || store.isWorking)
        }
        .frame(width: 320)

        Label("标题、正文和文件夹名称只以密文保存到服务器", systemImage: "lock.shield")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      .padding(44)
    }
  }

  private func submit() {
    guard !store.isWorking else { return }
    Task {
      await store.login(
        username: username.trimmingCharacters(in: .whitespacesAndNewlines),
        password: password
      )
      password = ""
    }
  }
}

private struct FolderEditorRequest: Identifiable {
  let folderID: String?
  let initialName: String

  var id: String { folderID ?? "new-folder" }
  var title: String { folderID == nil ? "新建文件夹" : "重命名文件夹" }
}

private struct SidebarView: View {
  @EnvironmentObject private var store: NotesStore
  @State private var folderEditor: FolderEditorRequest?
  @State private var folderToDelete: NoteFolder?
  @State private var showsPasswordChange = false

  var body: some View {
    VStack(spacing: 0) {
      sidebarHeader

      List(selection: locationBinding) {
        Section("笔记") {
          locationRow(
            title: "全部笔记",
            systemImage: "note.text",
            count: store.activeNotes.count,
            location: .allNotes
          )
        }

        Section {
          ForEach(store.folders) { folder in
            HStack(spacing: 8) {
              Label(folder.name, systemImage: "folder")
                .lineLimit(1)
              Spacer(minLength: 8)
              Text("\(store.noteCount(in: folder.id))")
                .font(.caption)
                .foregroundStyle(.tertiary)
            }
            .tag(NoteLocation.folder(folder.id))
            .contextMenu {
              Button("上移", systemImage: "arrow.up") {
                Task { await store.moveFolder(id: folder.id, offset: -1) }
              }
              .disabled(store.folders.first?.id == folder.id)
              Button("下移", systemImage: "arrow.down") {
                Task { await store.moveFolder(id: folder.id, offset: 1) }
              }
              .disabled(store.folders.last?.id == folder.id)
              Divider()
              Button("重命名", systemImage: "pencil") {
                folderEditor = FolderEditorRequest(
                  folderID: folder.id,
                  initialName: folder.name
                )
              }
              Divider()
              Button("删除文件夹", systemImage: "trash", role: .destructive) {
                folderToDelete = folder
              }
            }
          }
        } header: {
          HStack {
            Text("文件夹")
            Spacer()
            Button {
              folderEditor = FolderEditorRequest(folderID: nil, initialName: "")
            } label: {
              Image(systemName: "plus")
            }
            .buttonStyle(.plain)
            .help("新建文件夹")
          }
        }

        Section {
          locationRow(
            title: "回收站",
            systemImage: "trash",
            count: store.trashedNotes.count,
            location: .trash
          )
        }
      }
      .listStyle(.sidebar)

      Divider()
      sidebarFooter
    }
    .background(Color(nsColor: .controlBackgroundColor))
    .sheet(item: $folderEditor) { request in
      FolderNameSheet(request: request) { name in
        if let id = request.folderID {
          Task { await store.renameFolder(id: id, name: name) }
        } else {
          Task { await store.createFolder(name: name) }
        }
      }
    }
    .sheet(isPresented: $showsPasswordChange) {
      ChangeLoginPasswordSheet()
    }
    .confirmationDialog(
      "删除文件夹“\(folderToDelete?.name ?? "")”？",
      isPresented: Binding(
        get: { folderToDelete != nil },
        set: { if !$0 { folderToDelete = nil } }
      )
    ) {
      Button("删除文件夹", role: .destructive) {
        guard let id = folderToDelete?.id else { return }
        folderToDelete = nil
        Task { await store.deleteFolder(id: id) }
      }
      Button("取消", role: .cancel) { folderToDelete = nil }
    } message: {
      Text("文件夹中的笔记不会删除，仍可在“全部笔记”中查看。")
    }
  }

  private var sidebarHeader: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack(spacing: 10) {
        Image(systemName: "note.text")
          .font(.headline)
          .foregroundStyle(.white)
          .frame(width: 34, height: 34)
          .background(Color.accentColor.gradient, in: RoundedRectangle(cornerRadius: 9))
        VStack(alignment: .leading, spacing: 2) {
          Text("My Notes").font(.headline)
          Text(store.user?.username ?? "")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        Spacer()
      }

      Button {
        Task { await store.createNote() }
      } label: {
        Label("新建笔记", systemImage: "square.and.pencil")
          .frame(maxWidth: .infinity)
      }
      .buttonStyle(.borderedProminent)
      .controlSize(.large)
      .disabled(store.location.isTrash)
    }
    .padding(16)
  }

  private var sidebarFooter: some View {
    HStack {
      Button {
        Task { await store.refresh() }
      } label: {
        Image(systemName: "arrow.clockwise")
      }
      .help("刷新")
      .disabled(store.isWorking)

      Spacer()

      Menu {
        Button("修改登录密码", systemImage: "key") {
          showsPasswordChange = true
        }
        Divider()
        Button("退出登录", systemImage: "rectangle.portrait.and.arrow.right") {
          Task { await store.logout() }
        }
      } label: {
        Image(systemName: "person.crop.circle")
      }
      .menuStyle(.borderlessButton)
      .help("账户设置")
    }
    .padding(14)
  }

  private func locationRow(
    title: String,
    systemImage: String,
    count: Int,
    location: NoteLocation
  ) -> some View {
    HStack(spacing: 8) {
      Label(title, systemImage: systemImage)
      Spacer(minLength: 8)
      Text("\(count)")
        .font(.caption)
        .foregroundStyle(.tertiary)
    }
    .tag(location)
  }

  private var locationBinding: Binding<NoteLocation?> {
    Binding(
      get: { store.location },
      set: { if let location = $0 { store.selectLocation(location) } }
    )
  }
}

private struct ChangeLoginPasswordSheet: View {
  @EnvironmentObject private var store: NotesStore
  @Environment(\.dismiss) private var dismiss
  @State private var currentPassword = ""
  @State private var newPassword = ""
  @State private var confirmation = ""

  private var validationMessage: String? {
    if currentPassword.isEmpty { return "请输入当前登录密码。" }
    if newPassword.count < 12 { return "新密码至少需要 12 个字符。" }
    if newPassword != confirmation { return "两次输入的新密码不一致。" }
    if newPassword == currentPassword { return "新密码不能与当前密码相同。" }
    return nil
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      HStack(spacing: 12) {
        Image(systemName: "key.fill")
          .font(.title2)
          .foregroundStyle(Color.accentColor)
          .frame(width: 42, height: 42)
          .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
        VStack(alignment: .leading, spacing: 3) {
          Text("修改登录密码").font(.title3.bold())
          Text(store.user?.username ?? "")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }

      Form {
        SecureField("当前密码", text: $currentPassword)
        SecureField("新密码（至少 12 个字符）", text: $newPassword)
        SecureField("再次输入新密码", text: $confirmation)
      }
      .formStyle(.grouped)

      Text("修改成功后，其他设备保存的长期 Token 会立即失效；请使用新密码重新登录。")
        .font(.caption)
        .foregroundStyle(.secondary)

      HStack {
        Button("取消") { dismiss() }
        Spacer()
        Button("修改密码") { submit() }
          .buttonStyle(.borderedProminent)
          .disabled(validationMessage != nil || store.isWorking)
      }
    }
    .padding(24)
    .frame(width: 430)
  }

  private func submit() {
    guard validationMessage == nil else { return }
    Task {
      if await store.changeLoginPassword(
        currentPassword: currentPassword,
        newPassword: newPassword
      ) {
        currentPassword = ""
        newPassword = ""
        confirmation = ""
        dismiss()
      }
    }
  }
}

private struct FolderNameSheet: View {
  @Environment(\.dismiss) private var dismiss
  let request: FolderEditorRequest
  let onSave: (String) -> Void
  @State private var name: String

  init(request: FolderEditorRequest, onSave: @escaping (String) -> Void) {
    self.request = request
    self.onSave = onSave
    _name = State(initialValue: request.initialName)
  }

  var body: some View {
    NavigationStack {
      Form {
        TextField("文件夹名称", text: $name)
          .onSubmit { save() }
      }
      .formStyle(.grouped)
      .navigationTitle(request.title)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("取消") { dismiss() }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("保存", systemImage: "checkmark") { save() }
            .buttonStyle(.borderedProminent)
            .disabled(trimmedName.isEmpty)
        }
      }
    }
    .frame(width: 380, height: 170)
  }

  private var trimmedName: String {
    name.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private func save() {
    guard !trimmedName.isEmpty else { return }
    onSave(trimmedName)
    dismiss()
  }
}

private struct NotesListView: View {
  @EnvironmentObject private var store: NotesStore
  @AppStorage("noteListDisplayMode") private var displayModeRaw = NoteListDisplayMode.details.rawValue

  var body: some View {
    VStack(spacing: 0) {
      listHeader
      Divider()
      listContent
    }
    .background(Color(nsColor: .windowBackgroundColor))
  }

  private var listHeader: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        VStack(alignment: .leading, spacing: 2) {
          Text(store.locationTitle)
            .font(.title2.bold())
          Text("\(store.visibleNotes.count) 条笔记")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        Spacer()
        Menu {
          Picker("显示方式", selection: displayModeBinding) {
            ForEach(NoteListDisplayMode.allCases) { mode in
              Label(mode.title, systemImage: mode.systemImage)
                .tag(mode)
            }
          }
        } label: {
          Image(systemName: displayMode.systemImage)
        }
        .menuStyle(.borderlessButton)
        .help("切换笔记列表显示方式")
      }

      HStack(spacing: 8) {
        Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
        TextField("搜索标题和正文", text: searchBinding)
          .textFieldStyle(.plain)
        if !store.searchQuery.isEmpty {
          Button {
            store.updateSearchQuery("")
          } label: {
            Image(systemName: "xmark.circle.fill")
              .foregroundStyle(.tertiary)
          }
          .buttonStyle(.plain)
        }
      }
      .padding(.horizontal, 10)
      .frame(height: 32)
      .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
    }
    .padding(16)
  }

  @ViewBuilder
  private var listContent: some View {
    if store.visibleNotes.isEmpty {
      ContentUnavailableView(
        emptyTitle,
        systemImage: store.searchQuery.isEmpty ? emptySystemImage : "magnifyingglass",
        description: Text(store.searchQuery.isEmpty ? emptyDescription : "请尝试更短的关键词")
      )
    } else {
      switch displayMode {
      case .cards:
        cardsView
      case .details:
        detailsView
      case .titles:
        titlesView
      }
    }
  }

  private var cardsView: some View {
    ScrollView {
      LazyVGrid(
        columns: [GridItem(.adaptive(minimum: 176, maximum: 260), spacing: 12)],
        spacing: 12
      ) {
        ForEach(store.visibleNotes) { document in
          NoteCard(
            document: document,
            folderName: store.folderName(for: document.folderId),
            isSelected: store.selectedID == document.id,
            isTrash: store.location.isTrash
          ) {
            store.selectedID = document.id
          }
        }
      }
      .padding(14)
    }
  }

  private var detailsView: some View {
    List(selection: $store.selectedID) {
      ForEach(store.visibleNotes) { document in
        DetailedNoteRow(
          document: document,
          folderName: store.folderName(for: document.folderId),
          isTrash: store.location.isTrash
        )
        .tag(Optional(document.id))
      }
    }
    .listStyle(.inset)
  }

  private var titlesView: some View {
    List(selection: $store.selectedID) {
      ForEach(store.visibleNotes) { document in
        TitleNoteRow(
          document: document,
          folderName: store.folderName(for: document.folderId)
        )
        .tag(Optional(document.id))
      }
    }
    .listStyle(.plain)
  }

  private var displayMode: NoteListDisplayMode {
    NoteListDisplayMode(rawValue: displayModeRaw) ?? .details
  }

  private var searchBinding: Binding<String> {
    Binding(
      get: { store.searchQuery },
      set: { store.updateSearchQuery($0) }
    )
  }

  private var displayModeBinding: Binding<NoteListDisplayMode> {
    Binding(
      get: { displayMode },
      set: { displayModeRaw = $0.rawValue }
    )
  }

  private var emptyTitle: String {
    if !store.searchQuery.isEmpty { return "没有匹配的笔记" }
    return switch store.location {
    case .trash: "回收站为空"
    case .folder: "文件夹为空"
    default: "还没有笔记"
    }
  }

  private var emptySystemImage: String {
    switch store.location {
    case .trash: "trash"
    case .folder: "folder"
    case .unfiled: "tray"
    case .allNotes: "note.text"
    }
  }

  private var emptyDescription: String {
    store.location.isTrash ? "" : "新建笔记后会显示在这里"
  }
}

private struct NoteCard: View {
  let document: NoteDocument
  let folderName: String
  let isSelected: Bool
  let isTrash: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      VStack(alignment: .leading, spacing: 12) {
        HStack(alignment: .firstTextBaseline) {
          if document.isProtected {
            Image(systemName: "lock.fill")
              .font(.caption)
              .foregroundStyle(.secondary)
          }
          Text(document.title)
            .font(.headline)
            .lineLimit(2)
          Spacer(minLength: 8)
          if let date = document.envelope.displayDate {
            Text(date, format: .dateTime.month(.abbreviated).day())
              .font(.caption2)
              .foregroundStyle(.tertiary)
          }
        }
        Text(document.excerpt)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .lineLimit(5)
          .frame(maxWidth: .infinity, minHeight: 76, alignment: .topLeading)
        Spacer(minLength: 0)
        Label(isTrash ? "已删除" : folderName, systemImage: isTrash ? "trash" : "folder")
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(1)
      }
      .padding(14)
      .frame(maxWidth: .infinity, minHeight: 176, alignment: .topLeading)
      .background(
        isSelected ? Color.accentColor.opacity(0.13) : Color(nsColor: .textBackgroundColor),
        in: RoundedRectangle(cornerRadius: 12)
      )
      .overlay {
        RoundedRectangle(cornerRadius: 12)
          .stroke(isSelected ? Color.accentColor : Color(nsColor: .separatorColor), lineWidth: 1)
      }
      .shadow(color: .black.opacity(0.05), radius: 3, y: 1)
    }
    .buttonStyle(.plain)
  }
}

private struct DetailedNoteRow: View {
  let document: NoteDocument
  let folderName: String
  let isTrash: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      HStack(alignment: .firstTextBaseline) {
        if document.isProtected {
          Image(systemName: "lock.fill")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        Text(document.title)
          .font(.headline)
          .lineLimit(1)
        Spacer(minLength: 8)
        if let date = document.envelope.displayDate {
          Text(date, format: .dateTime.month(.abbreviated).day())
            .font(.caption2)
            .foregroundStyle(.tertiary)
        }
      }
      Text(document.excerpt)
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .lineLimit(2)
      Label(isTrash ? "已删除" : folderName, systemImage: isTrash ? "trash" : "folder")
        .font(.caption2)
        .foregroundStyle(.tertiary)
        .lineLimit(1)
    }
    .padding(.vertical, 7)
  }
}

private struct TitleNoteRow: View {
  let document: NoteDocument
  let folderName: String

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: document.isProtected ? "lock.fill" : "note.text")
        .foregroundStyle(.secondary)
      Text(document.title)
        .font(.body)
        .lineLimit(1)
      Spacer(minLength: 8)
      Text(folderName)
        .font(.caption)
        .foregroundStyle(.tertiary)
        .lineLimit(1)
      if let date = document.envelope.displayDate {
        Text(date, format: .dateTime.month(.abbreviated).day())
          .font(.caption2)
          .foregroundStyle(.tertiary)
      }
    }
    .padding(.vertical, 3)
  }
}

private struct NoteEditorView: View {
  @EnvironmentObject private var store: NotesStore
  @Environment(\.scenePhase) private var scenePhase
  @State private var confirmTrash = false
  @State private var confirmPurge = false
  @State private var unlockPassword = ""
  @State private var unlockError: String?
  @State private var isUnlocking = false
  @State private var protectionSheet: ProtectionSheetMode?
  @State private var showImageImporter = false

  var body: some View {
    Group {
      if let document = store.selectedDocument {
        VStack(spacing: 0) {
          editorHeader(document)
          Divider()
          if document.isProtected && !store.isUnlocked(document) {
            protectedBody(document)
          } else if store.location.isTrash {
            readOnlyBody(document)
          } else {
            editableBody
          }
        }
      } else {
        ContentUnavailableView(
          store.location.isTrash ? "选择回收站中的笔记" : "选择一篇笔记",
          systemImage: store.location.isTrash ? "trash" : "note.text"
        )
      }
    }
    .background(Color(nsColor: .textBackgroundColor))
    .task(id: attachmentLoadID) { await store.loadSelectedAttachments() }
    .onChange(of: store.selectedID) { oldID, _ in relock(noteID: oldID) }
    .onChange(of: scenePhase) { _, phase in
      if phase != .active { relock() }
    }
    .onDisappear { relock() }
    .sheet(item: $protectionSheet) { mode in
      ProtectionPasswordSheet(mode: mode)
        .environmentObject(store)
    }
    .fileImporter(
      isPresented: $showImageImporter,
      allowedContentTypes: [.image],
      allowsMultipleSelection: false,
      onCompletion: importImage
    )
    .confirmationDialog("将笔记移到回收站？", isPresented: $confirmTrash) {
      Button("移到回收站", role: .destructive) {
        Task { await store.moveSelectedToTrash() }
      }
      Button("取消", role: .cancel) {}
    } message: {
      Text("之后可以从回收站恢复。")
    }
    .confirmationDialog("永久删除这篇笔记？", isPresented: $confirmPurge) {
      Button("永久删除", role: .destructive) {
        Task { await store.purgeSelected() }
      }
      Button("取消", role: .cancel) {}
    } message: {
      Text("此操作无法撤销。")
    }
  }

  private func editorHeader(_ document: NoteDocument) -> some View {
    HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 3) {
        Text(store.locationTitle)
          .font(.caption)
          .foregroundStyle(.secondary)
        saveStatus
      }
      Spacer()
      if !store.location.isTrash {
        Button {
          Task { await store.saveSelected() }
        } label: {
          Label("保存", systemImage: "square.and.arrow.down")
        }
        .buttonStyle(.borderedProminent)
        .disabled(
          store.saveState == .saving
            || (document.isProtected && !store.isUnlocked(document))
        )
        .help("保存笔记（⌘S）")
        Button {
          showImageImporter = true
        } label: {
          Label("图片", systemImage: "photo.badge.plus")
        }
        .disabled(
          store.isAttachmentWorking
            || (document.isProtected && !store.isUnlocked(document))
        )
        .help("添加加密图片（单张不超过 10 MiB）")
        protectionControl(document)
        folderMenu(document)
        Button(role: .destructive) {
          confirmTrash = true
        } label: {
          Label("删除", systemImage: "trash")
        }
      } else {
        Button {
          Task { await store.restoreSelected() }
        } label: {
          Label("恢复", systemImage: "arrow.uturn.backward")
        }
        .buttonStyle(.borderedProminent)
        Button(role: .destructive) {
          confirmPurge = true
        } label: {
          Label("永久删除", systemImage: "trash.slash")
        }
      }
    }
    .padding(.horizontal, 20)
    .frame(height: 58)
  }

  @ViewBuilder
  private func protectionControl(_ document: NoteDocument) -> some View {
    if document.isProtected {
      Menu {
        if store.isUnlocked(document) {
          Button("重新锁定", systemImage: "lock") { relock() }
          Divider()
          Button("取消密码保护", systemImage: "lock.open") {
            Task {
              do { try await store.unprotectSelected() }
              catch { unlockError = error.localizedDescription }
            }
          }
        } else {
          Button("输入密码查看", systemImage: "lock.open") {
            unlockError = nil
          }
        }
      } label: {
        Label(
          store.isUnlocked(document) ? "已解锁" : "已锁定",
          systemImage: store.isUnlocked(document) ? "lock.open" : "lock.fill"
        )
      }
      .help("密码保护")
    } else {
      Button {
        protectionSheet = store.hasProtectionPassword ? .protect : .setup
      } label: {
        Label("保护", systemImage: "lock")
      }
      .help("使用独立保护密码加密正文")
    }
  }

  private func folderMenu(_ document: NoteDocument) -> some View {
    Menu {
      ForEach(store.folders) { folder in
        Button {
          Task { await store.moveSelected(to: folder.id) }
        } label: {
          Label(
            folder.name,
            systemImage: document.folderId == folder.id ? "checkmark" : "folder"
          )
        }
      }
    } label: {
      Label(store.folderName(for: document.folderId), systemImage: "folder")
        .lineLimit(1)
    }
    .help("移动到文件夹")
  }

  @ViewBuilder
  private var saveStatus: some View {
    if let document = store.selectedDocument,
      document.isProtected,
      !store.isUnlocked(document)
    {
      Label("正文已隐藏", systemImage: "lock.fill")
        .foregroundStyle(.secondary)
    } else {
      switch store.saveState {
      case .idle:
        Text("内容已在本地解密")
      case .dirty:
        Label("有未保存更改", systemImage: "circle.fill")
          .foregroundStyle(.orange)
      case .saving:
        Label("正在加密保存…", systemImage: "arrow.triangle.2.circlepath")
      case .saved:
        Label("已加密保存", systemImage: "checkmark.circle")
          .foregroundStyle(.green)
      case .failed:
        Label("保存失败", systemImage: "exclamationmark.triangle")
          .foregroundStyle(.red)
      case .conflict:
        Label("发现同步冲突", systemImage: "arrow.triangle.branch")
          .foregroundStyle(.orange)
      }
    }
  }

  private func protectedBody(_ document: NoteDocument) -> some View {
    VStack(spacing: 20) {
      Spacer()
      Image(systemName: "lock.shield.fill")
        .font(.system(size: 42, weight: .medium))
        .foregroundStyle(Color.accentColor)
        .frame(width: 76, height: 76)
        .background(Color.accentColor.opacity(0.1), in: RoundedRectangle(cornerRadius: 20))

      VStack(spacing: 8) {
        Text(document.title)
          .font(.title2.bold())
        Text("••••••••••••••••")
          .font(.title3.monospaced())
          .foregroundStyle(.secondary)
          .accessibilityLabel("正文已隐藏")
        Text("输入独立保护密码后显示正文")
          .font(.subheadline)
          .foregroundStyle(.secondary)
      }

      VStack(spacing: 10) {
        SecureField("独立保护密码", text: $unlockPassword)
          .textFieldStyle(.roundedBorder)
          .onSubmit { unlock(document) }
          .disabled(isUnlocking)

        if let unlockError {
          Label(unlockError, systemImage: "exclamationmark.circle")
            .font(.caption)
            .foregroundStyle(.red)
        }

        Button {
          unlock(document)
        } label: {
          HStack {
            if isUnlocking { ProgressView().controlSize(.small) }
            Text(isUnlocking ? "正在解锁…" : "解锁并显示")
              .frame(maxWidth: .infinity)
          }
        }
        .buttonStyle(.borderedProminent)
        .disabled(unlockPassword.isEmpty || isUnlocking)
      }
      .frame(width: 300)

      Label("保护密码不会上传或保存在本机", systemImage: "checkmark.shield")
        .font(.caption)
        .foregroundStyle(.tertiary)
      Spacer()
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .padding(32)
  }

  private func unlock(_ document: NoteDocument) {
    guard !unlockPassword.isEmpty, !isUnlocking else { return }
    let password = unlockPassword
    isUnlocking = true
    unlockError = nil
    Task {
      defer {
        unlockPassword = ""
        isUnlocking = false
      }
      do {
        try store.unlockSelected(password: password)
        guard store.selectedID == document.id, scenePhase == .active else { return }
      } catch {
        unlockError = error.localizedDescription
      }
    }
  }

  private func relock(noteID: String? = nil) {
    unlockPassword = ""
    unlockError = nil
    isUnlocking = false
    Task { await store.relock(noteID: noteID) }
  }

  private var editableBody: some View {
    VStack(spacing: 0) {
      TextField("无标题笔记", text: titleBinding)
        .textFieldStyle(.plain)
        .font(.title.bold())
        .padding(.horizontal, 28)
        .padding(.top, 26)
        .padding(.bottom, 12)
      attachmentGallery(allowsDeletion: true)
      TextEditor(text: contentBinding)
        .font(.body)
        .scrollContentBackground(.hidden)
        .padding(.horizontal, 22)
        .padding(.bottom, 20)
    }
  }

  private func readOnlyBody(_ document: NoteDocument) -> some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        Text(document.title)
          .font(.title.bold())
        Text(document.content.content.isEmpty ? "暂无正文" : document.content.content)
          .font(.body)
          .textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading)
        attachmentGallery(allowsDeletion: false)
      }
      .padding(28)
    }
  }

  @ViewBuilder
  private func attachmentGallery(allowsDeletion: Bool) -> some View {
    if !store.selectedAttachments.isEmpty || store.isAttachmentWorking {
      VStack(alignment: .leading, spacing: 8) {
        HStack {
          Label("图片", systemImage: "photo.on.rectangle.angled")
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
          Spacer()
          Text("\(store.selectedAttachments.count)/20")
            .font(.caption2.monospacedDigit())
            .foregroundStyle(.tertiary)
        }
        ScrollView(.horizontal) {
          HStack(spacing: 12) {
            ForEach(store.selectedAttachments) { attachment in
              AttachmentCard(attachment: attachment, allowsDeletion: allowsDeletion)
                .environmentObject(store)
            }
            if store.isAttachmentWorking {
              VStack(spacing: 8) {
                ProgressView()
                Text("正在加密上传…")
                  .font(.caption2)
                  .foregroundStyle(.secondary)
              }
              .frame(width: 150, height: 100)
              .background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
            }
          }
          .padding(.vertical, 2)
        }
        .scrollIndicators(.hidden)
      }
      .padding(.horizontal, 28)
      .padding(.bottom, 12)
    }
  }

  private var attachmentLoadID: String {
    guard let document = store.selectedDocument else { return "none" }
    return "\(document.id):\(store.isUnlocked(document))"
  }

  private func importImage(_ result: Result<[URL], Error>) {
    Task {
      do {
        guard let url = try result.get().first else { return }
        let accessing = url.startAccessingSecurityScopedResource()
        defer { if accessing { url.stopAccessingSecurityScopedResource() } }
        let values = try url.resourceValues(forKeys: [.contentTypeKey])
        let contentType: String
        if values.contentType?.conforms(to: .jpeg) == true {
          contentType = "image/jpeg"
        } else if values.contentType?.conforms(to: .png) == true {
          contentType = "image/png"
        } else if values.contentType?.identifier == "org.webmproject.webp" {
          contentType = "image/webp"
        } else {
          throw AttachmentCryptoError.unsupportedImage
        }
        let data = try Data(contentsOf: url, options: [.mappedIfSafe])
        guard let representation = NSBitmapImageRep(data: data) else {
          throw AttachmentCryptoError.unsupportedImage
        }
        await store.addImage(
          data: data,
          contentType: contentType,
          pixelWidth: representation.pixelsWide,
          pixelHeight: representation.pixelsHigh
        )
      } catch {
        store.report(error)
      }
    }
  }

  private var titleBinding: Binding<String> {
    Binding(
      get: { store.selectedDocument?.content.title ?? "" },
      set: { store.updateSelectedTitle($0) }
    )
  }

  private var contentBinding: Binding<String> {
    Binding(
      get: { store.selectedDocument?.content.content ?? "" },
      set: { store.updateSelectedContent($0) }
    )
  }
}

private struct AttachmentCard: View {
  @EnvironmentObject private var store: NotesStore
  let attachment: NoteAttachment
  let allowsDeletion: Bool

  var body: some View {
    ZStack(alignment: .topTrailing) {
      Group {
        if attachment.metadata.contentType == "audio/mp4" {
          VStack(spacing: 8) {
            Image(systemName: "waveform.circle.fill")
              .font(.system(size: 32))
              .foregroundStyle(.secondary)
            Text("语音附件")
              .font(.caption)
            Text("请在安卓端播放")
              .font(.caption2)
              .foregroundStyle(.secondary)
          }
        } else if let data = attachment.imageData, let image = NSImage(data: data) {
          Image(nsImage: image)
            .resizable()
            .scaledToFill()
        } else {
          VStack(spacing: 8) {
            ProgressView()
            Text("正在安全解密")
              .font(.caption2)
              .foregroundStyle(.secondary)
          }
        }
      }
      .frame(width: 150, height: 100)
      .clipped()
      .background(.quaternary)
      .clipShape(RoundedRectangle(cornerRadius: 12))
      .overlay(alignment: .bottomLeading) {
        Text(ByteCountFormatter.string(fromByteCount: Int64(attachment.metadata.plaintextBytes), countStyle: .file))
          .font(.caption2.monospacedDigit())
          .padding(.horizontal, 7)
          .padding(.vertical, 4)
          .background(.black.opacity(0.58), in: Capsule())
          .foregroundStyle(.white)
          .padding(6)
      }
      if allowsDeletion {
        Button(role: .destructive) {
          Task { await store.deleteAttachment(id: attachment.id) }
        } label: {
          Image(systemName: "xmark.circle.fill")
            .font(.title3)
            .symbolRenderingMode(.palette)
            .foregroundStyle(.white, .black.opacity(0.62))
        }
        .buttonStyle(.plain)
        .padding(6)
        .disabled(store.isAttachmentWorking)
        .help(attachment.metadata.contentType == "audio/mp4" ? "删除录音" : "删除图片")
      }
    }
    .task(id: attachment.id) {
      if attachment.metadata.contentType != "audio/mp4" {
        await store.loadAttachmentImage(id: attachment.id)
      }
    }
    .accessibilityLabel(attachment.metadata.contentType == "audio/mp4" ? "加密录音" : "加密图片")
  }
}

private enum ProtectionSheetMode: String, Identifiable {
  case setup
  case protect
  var id: String { rawValue }
}

private struct ProtectionPasswordSheet: View {
  @EnvironmentObject private var store: NotesStore
  @Environment(\.dismiss) private var dismiss
  let mode: ProtectionSheetMode
  @State private var password = ""
  @State private var confirmation = ""
  @State private var message: String?
  @State private var isWorking = false

  var body: some View {
    NavigationStack {
      Form {
        Section {
          SecureField("独立保护密码", text: $password)
          if mode == .setup {
            SecureField("再次输入保护密码", text: $confirmation)
          }
        } header: {
          Text(mode == .setup ? "设置全局保护密码" : "保护这篇笔记")
        } footer: {
          Text(
            mode == .setup
              ? "所有受保护笔记共用此密码，至少 12 个字符。密码无法找回，请妥善保存。"
              : "使用已设置的独立保护密码，不是登录密码。"
          )
        }
        if let message {
          Label(message, systemImage: "exclamationmark.circle")
            .foregroundStyle(.red)
        }
      }
      .formStyle(.grouped)
      .navigationTitle(mode == .setup ? "设置保护密码" : "密码保护")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("取消") { dismiss() }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("保护笔记", systemImage: "lock.fill") { submit() }
            .buttonStyle(.borderedProminent)
            .disabled(password.isEmpty || isWorking)
        }
      }
    }
    .frame(width: 440, height: mode == .setup ? 300 : 260)
  }

  private func submit() {
    guard !isWorking else { return }
    isWorking = true
    message = nil
    Task {
      defer { isWorking = false }
      do {
        if mode == .setup {
          try await store.setupAndProtectSelected(
            password: password,
            confirmation: confirmation
          )
        } else {
          try await store.protectSelected(password: password)
        }
        password = ""
        confirmation = ""
        dismiss()
      } catch {
        message = error.localizedDescription
      }
    }
  }
}

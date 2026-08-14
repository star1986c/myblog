import NotesCore
import SwiftUI

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
          Text("AI Build Notes").font(.title.bold())
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
          locationRow(
            title: "未分类",
            systemImage: "tray",
            count: store.noteCount(in: nil),
            location: .unfiled
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
      Text("文件夹中的笔记不会删除，将自动移到“未分类”。")
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
          Text("AI Build Notes").font(.headline)
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

      Button("退出登录") {
        Task { await store.logout() }
      }
      .buttonStyle(.plain)
      .foregroundStyle(.secondary)
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
      Image(systemName: "note.text")
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
  @State private var confirmTrash = false
  @State private var confirmPurge = false

  var body: some View {
    Group {
      if let document = store.selectedDocument {
        VStack(spacing: 0) {
          editorHeader(document)
          Divider()
          if store.location.isTrash {
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

  private func folderMenu(_ document: NoteDocument) -> some View {
    Menu {
      Button {
        Task { await store.moveSelected(to: nil) }
      } label: {
        Label("未分类", systemImage: document.folderId == nil ? "checkmark" : "tray")
      }
      if !store.folders.isEmpty { Divider() }
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
    switch store.saveState {
    case .idle:
      Text("内容已在本地解密")
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

  private var editableBody: some View {
    VStack(spacing: 0) {
      TextField("无标题笔记", text: titleBinding)
        .textFieldStyle(.plain)
        .font(.title.bold())
        .padding(.horizontal, 28)
        .padding(.top, 26)
        .padding(.bottom, 12)
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
      }
      .padding(28)
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

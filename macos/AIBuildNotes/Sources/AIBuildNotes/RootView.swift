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
        .navigationSplitViewColumnWidth(min: 180, ideal: 210, max: 250)
    } content: {
      NotesListView()
        .navigationSplitViewColumnWidth(min: 260, ideal: 320, max: 390)
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
        colors: [Color(red: 0.95, green: 0.97, blue: 1), .white],
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
          Text("AI Build Notes")
            .font(.system(size: 28, weight: .bold))
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

        Label("标题和正文只以密文保存到服务器", systemImage: "lock.shield")
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

private struct SidebarView: View {
  @EnvironmentObject private var store: NotesStore

  var body: some View {
    VStack(spacing: 0) {
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
          Label("新建笔记", systemImage: "plus")
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .disabled(store.section != .notes)
      }
      .padding(16)

      List(selection: sectionBinding) {
        Section("记事本") {
          ForEach(NoteSection.allCases) { section in
            Label(section.title, systemImage: section.systemImage)
              .tag(section)
          }
        }
      }
      .listStyle(.sidebar)

      Divider()
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
    .background(Color(nsColor: .controlBackgroundColor))
  }

  private var sectionBinding: Binding<NoteSection?> {
    Binding(
      get: { store.section },
      set: { if let section = $0 { store.selectSection(section) } }
    )
  }
}

private struct NotesListView: View {
  @EnvironmentObject private var store: NotesStore

  var body: some View {
    VStack(spacing: 0) {
      VStack(alignment: .leading, spacing: 12) {
        HStack {
          Text(store.section.title)
            .font(.title2.bold())
          Spacer()
          Text("\(store.visibleNotes.count) 条")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        HStack(spacing: 8) {
          Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
          TextField("搜索标题和正文", text: $store.searchQuery)
            .textFieldStyle(.plain)
          if !store.searchQuery.isEmpty {
            Button {
              store.searchQuery = ""
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

      Divider()

      if store.visibleNotes.isEmpty {
        ContentUnavailableView(
          store.searchQuery.isEmpty
            ? (store.section == .notes ? "还没有笔记" : "回收站为空")
            : "没有匹配的笔记",
          systemImage: store.searchQuery.isEmpty ? store.section.systemImage : "magnifyingglass",
          description: Text(store.searchQuery.isEmpty ? "" : "请尝试更短的关键词")
        )
      } else {
        List(selection: $store.selectedID) {
          ForEach(store.visibleNotes) { document in
            NoteRow(document: document, isTrash: store.section == .trash)
              .tag(Optional(document.id))
          }
        }
        .listStyle(.inset)
      }
    }
    .background(Color(nsColor: .windowBackgroundColor))
  }
}

private struct NoteRow: View {
  let document: NoteDocument
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
      if isTrash {
        Label("已删除", systemImage: "trash")
          .font(.caption2)
          .foregroundStyle(.secondary)
      }
    }
    .padding(.vertical, 7)
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
          if store.section == .notes {
            editableBody
          } else {
            readOnlyBody(document)
          }
        }
      } else {
        ContentUnavailableView(
          store.section == .notes ? "选择一篇笔记" : "选择回收站中的笔记",
          systemImage: store.section == .notes ? "note.text" : "trash"
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
        Text(store.section.title)
          .font(.caption)
          .foregroundStyle(.secondary)
        saveStatus
      }
      Spacer()
      if store.section == .notes {
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
        .font(.system(size: 27, weight: .bold))
        .padding(.horizontal, 28)
        .padding(.top, 26)
        .padding(.bottom, 12)
      TextEditor(text: contentBinding)
        .font(.system(size: 16))
        .scrollContentBackground(.hidden)
        .padding(.horizontal, 22)
        .padding(.bottom, 20)
    }
  }

  private func readOnlyBody(_ document: NoteDocument) -> some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        Text(document.title)
          .font(.system(size: 27, weight: .bold))
        Text(document.content.content.isEmpty ? "暂无正文" : document.content.content)
          .font(.system(size: 16))
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

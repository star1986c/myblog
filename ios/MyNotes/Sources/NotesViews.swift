import SwiftUI
import NotesCore

private struct NoteSelection: Identifiable { let id: String }

struct NotesListView: View {
  @EnvironmentObject private var notes: NotesStore
  @State private var editor: NoteSelection?
  @State private var folders = false
  @State private var creating = false

  private var isSearching: Bool { !notes.searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
  private var title: String {
    if isSearching { return notes.location.isTrash ? "回收站搜索" : "搜索结果" }
    return notes.location == .unfiled ? "未分类" : notes.locationTitle
  }

  var body: some View {
    List {
      if notes.isWorking { ProgressView("正在同步笔记…") }
      Section {
        ForEach(notes.visibleNotes) { note in
          Button {
            guard MobileNoteSelection.open(note.id, in: notes), !creating else { return }
            editor = NoteSelection(id: note.id)
          } label: {
            HStack(alignment: .top, spacing: 12) {
              Image(systemName: note.isProtected ? "lock.doc" : "doc.text")
                .font(.title3).foregroundStyle(MobileTheme.accent)
                .frame(width: 36, height: 40)
                .background(MobileTheme.accent.opacity(0.08), in: RoundedRectangle(cornerRadius: 9))
                .accessibilityHidden(true)
              VStack(alignment: .leading, spacing: 5) {
                Text(note.content.title.isEmpty ? "无标题笔记" : note.content.title).font(.headline).foregroundStyle(.primary).lineLimit(2)
                Text(note.isProtected ? "受保护的笔记" : note.content.content.isEmpty ? "暂无内容" : note.content.content)
                  .font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                Label(note.folderId == nil ? "未分类" : notes.folderName(for: note.folderId), systemImage: "folder")
                  .font(.caption).foregroundStyle(.secondary)
              }
              Spacer(minLength: 0)
              Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary).padding(.top, 6)
            }.padding(.vertical, 6).contentShape(Rectangle())
          }.buttonStyle(.plain).disabled(notes.isWorking || creating).accessibilityIdentifier("note.\(note.id)")
        }
      } header: {
        if !notes.visibleNotes.isEmpty {
          Text(isSearching ? "找到 \(notes.visibleNotes.count) 篇笔记" : "\(notes.visibleNotes.count) 篇笔记")
        }
      } footer: {
        if notes.location.isTrash && !notes.visibleNotes.isEmpty { Text("打开笔记可恢复，或永久删除。") }
        else if isSearching && !notes.visibleNotes.isEmpty { Text("搜索本机已加载的全部笔记；受保护正文不参与搜索。") }
      }
    }
    .listStyle(.insetGrouped)
    .overlay { if notes.visibleNotes.isEmpty && !notes.isWorking { emptyState } }
    .searchable(text: Binding(get: { notes.searchQuery }, set: notes.updateSearchQuery), prompt: notes.location.isTrash ? "搜索回收站" : "搜索本机全部笔记")
    .navigationTitle(title)
    .refreshable { await notes.refresh() }
    .toolbar {
      ToolbarItem(placement: .topBarLeading) { Button("文件夹", systemImage: "folder") { folders = true } }
      ToolbarItem(placement: .topBarTrailing) {
        if !notes.location.isTrash {
          Button("新建笔记", systemImage: "square.and.pencil", action: createNote)
            .disabled(notes.isWorking || creating).accessibilityIdentifier("notes.new")
        }
      }
    }
    .sheet(isPresented: $folders) { FolderListView().mobileErrors() }
    .sheet(item: $editor) { selection in
      NavigationStack { NoteEditorView(noteID: selection.id) }
        .interactiveDismissDisabled()
    }
  }

  private var emptyState: some View {
    ContentUnavailableView {
      Label(isSearching ? "没有找到笔记" : notes.location.isTrash ? "回收站为空" : "这里还没有笔记",
        systemImage: isSearching ? "magnifyingglass" : notes.location.isTrash ? "trash" : "note.text")
    } description: {
      Text(isSearching ? "换个关键词试试；受保护正文不参与搜索。" : notes.location.isTrash ? "删除的笔记会显示在这里，可恢复或永久删除。" : "记下想法，或从其他文件夹移动笔记到这里。")
    } actions: {
      if isSearching { Button("清除搜索") { notes.updateSearchQuery("") }.buttonStyle(.bordered) }
      else if !notes.location.isTrash {
        Button("新建笔记", systemImage: "square.and.pencil", action: createNote)
          .buttonStyle(.borderedProminent).disabled(creating)
      }
    }
  }

  private func createNote() {
    guard !creating, !notes.isWorking, !notes.location.isTrash else { return }
    creating = true
    Task {
      defer { creating = false }
      let previous = Set(notes.activeNotes.map(\.id))
      await notes.createNote()
      if let id = notes.selectedID, !previous.contains(id) { editor = NoteSelection(id: id) }
    }
  }
}

private struct FolderListView: View {
  @EnvironmentObject private var notes: NotesStore
  @Environment(\.dismiss) private var dismiss
  @State private var name = ""
  @State private var editingID: String?
  @State private var naming = false
  @State private var deleting: NoteFolder?
  var body: some View {
    NavigationStack {
      List {
        Section {
          location("全部笔记", "tray.full", .allNotes, count: notes.activeNotes.count)
          location("未分类", "tray", .unfiled, count: notes.noteCount(in: nil))
          location("回收站", "trash", .trash, count: notes.trashedNotes.count)
        }
        Section("文件夹") {
          ForEach(notes.folders) { folder in
            HStack(spacing: 0) {
              Button { notes.selectLocation(.folder(folder.id)); dismiss() } label: {
                locationLabel(folder.name, "folder", .folder(folder.id), count: notes.noteCount(in: folder.id))
              }.buttonStyle(.plain).accessibilityValue(notes.location == .folder(folder.id) ? "当前文件夹" : "")
              Menu {
                Button("重命名") { editingID = folder.id; name = folder.name; naming = true }
                Button("上移") { Task { await notes.moveFolder(id: folder.id, offset: -1) } }
                Button("下移") { Task { await notes.moveFolder(id: folder.id, offset: 1) } }
                Button("删除文件夹", role: .destructive) { deleting = folder }
              } label: { Image(systemName: "ellipsis.circle").frame(minWidth: 44, minHeight: 44) }
                .accessibilityLabel("\(folder.name) 的文件夹操作")
            }
          }
        }
      }.navigationTitle("文件夹")
        .toolbar {
          ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } }
          ToolbarItem(placement: .topBarLeading) { Button("新建", systemImage: "folder.badge.plus") { name = ""; editingID = nil; naming = true } }
        }
        .alert(editingID == nil ? "新建文件夹" : "重命名文件夹", isPresented: $naming) {
          TextField("名称", text: $name)
          Button("取消", role: .cancel) {}
          Button("保存") { Task { if let id = editingID { await notes.renameFolder(id: id, name: name) } else { await notes.createFolder(name: name) } } }
        }
        .alert("删除文件夹？", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
          Button("取消", role: .cancel) { deleting = nil }
          Button("删除", role: .destructive) { if let folder = deleting { Task { await notes.deleteFolder(id: folder.id) } }; deleting = nil }
        } message: { Text("文件夹中的笔记会按服务器规则移出文件夹。") }
    }
  }
  private func location(_ title: String, _ icon: String, _ value: NoteLocation, count: Int) -> some View {
    Button { notes.selectLocation(value); dismiss() } label: { locationLabel(title, icon, value, count: count) }
      .buttonStyle(.plain).accessibilityLabel(title).accessibilityValue(notes.location == value ? "当前选择，\(count) 篇" : "\(count) 篇")
  }
  private func locationLabel(_ title: String, _ icon: String, _ value: NoteLocation, count: Int) -> some View {
    HStack(spacing: 12) {
      Image(systemName: icon).foregroundStyle(MobileTheme.accent).frame(width: 24)
      Text(title).foregroundStyle(.primary)
      Spacer(minLength: 8)
      Text("\(count)").font(.subheadline).monospacedDigit().foregroundStyle(.secondary)
      if notes.location == value {
        Image(systemName: "checkmark").font(.body.weight(.semibold)).foregroundStyle(MobileTheme.accent)
      }
    }.frame(minHeight: 44).contentShape(Rectangle())
  }
}

private struct NoteEditorView: View {
  @EnvironmentObject private var notes: NotesStore
  @EnvironmentObject private var model: MobileModel
  @Environment(\.dismiss) private var dismiss
  let noteID: String
  @State private var password = ""
  @State private var confirmation = ""
  @State private var protecting = false
  @State private var moving = false
  @State private var destructiveAction: String?
  @State private var busy = false
  @State private var preview: MobileFile?
  @State private var previewURL: URL?
  @State private var pendingMedia: CapturedMedia?

  private var document: NoteDocument? {
    (notes.location.isTrash ? notes.trashedNotes : notes.activeNotes).first { $0.id == noteID }
  }
  private var unlocked: Bool { document.map { !$0.isProtected || notes.isUnlocked($0) } ?? false }

  private var canOperate: Bool { !busy && MobileNoteSelection.isCurrent(noteID, in: notes) }

  var body: some View {
    Group {
      if let note = document {
        Form {
          Section {
            TextField("标题", text: Binding(get: { note.content.title }, set: { value in MobileNoteSelection.edit(noteID, in: notes) { notes.updateSelectedTitle(value) } }), axis: .vertical)
              .font(.title3.bold()).disabled(!unlocked || notes.location.isTrash || !canOperate).accessibilityIdentifier("note.title")
          }
          if !unlocked {
            Section("受保护的正文") {
              Label("输入笔记保护密码以查看内容", systemImage: "lock.shield")
              if notes.location.isTrash {
                Text("请先恢复这篇笔记，再解锁正文。")
              } else {
                SecureField("保护密码", text: $password)
                Button("解锁") {
                  guard canOperate else { return }
                  do {
                    try notes.unlockSelected(password: password)
                    password = ""
                    Task { await notes.loadSelectedAttachments() }
                  } catch { model.error = error.localizedDescription }
                }.disabled(password.isEmpty || !canOperate)
              }
            }
          } else {
            Section {
              TextEditor(text: Binding(get: { note.content.content }, set: { value in MobileNoteSelection.edit(noteID, in: notes) { notes.updateSelectedContent(value) } }))
                .frame(minHeight: 280).disabled(notes.location.isTrash || !canOperate).accessibilityIdentifier("note.body")
            } header: {
              HStack { Text("正文"); Spacer(); Text(saveLabel).foregroundStyle(.secondary) }
            }
            Section("照片与录音") {
              ForEach(notes.selectedAttachments) { attachment in
                HStack {
                  Button { perform { await open(attachment) } } label: {
                    Label(attachment.metadata.contentType.hasPrefix("audio/") ? "录音 · \((attachment.metadata.durationMillis ?? 0) / 1000) 秒" : "照片",
                      systemImage: attachment.metadata.contentType.hasPrefix("audio/") ? "waveform" : "photo")
                  }.buttonStyle(.borderless)
                  Spacer()
                  Text(ByteCountFormatter.string(fromByteCount: Int64(attachment.metadata.plaintextBytes), countStyle: .file)).font(.caption).foregroundStyle(.secondary)
                  if !notes.location.isTrash {
                    Button("删除附件", systemImage: "trash", role: .destructive) { destructiveAction = attachment.id }
                      .labelStyle(.iconOnly).buttonStyle(.borderless)
                  }
                }
              }
              if !notes.location.isTrash {
                MediaPickerMenu(includeFiles: false, onCapture: add, onFiles: { _ in }, title: "添加照片或录音")
                  .disabled(notes.isAttachmentWorking || !canOperate || pendingMedia != nil)
                if notes.isAttachmentWorking { ProgressView("正在加密并上传…") }
                if let media = pendingMedia, !notes.isAttachmentWorking {
                  Label("附件尚未上传，原文件已暂存", systemImage: "exclamationmark.circle")
                  Button("重试上传") { add(media) }.disabled(!canOperate)
                  Button("移除待上传附件", role: .destructive) { destructiveAction = "pending-media" }.disabled(!canOperate)
                }
              }
            }
          }
          if notes.location.isTrash {
            Section {
              Button("恢复笔记") { perform { await notes.restoreSelected(); if !notes.trashedNotes.contains(where: { $0.id == noteID }) { dismiss() } } }.disabled(!canOperate)
              Button("永久删除", role: .destructive) { destructiveAction = "purge" }
            }
          }
        }
      } else { ContentUnavailableView("笔记已移动或删除", systemImage: "doc") }
    }
    .navigationTitle("编辑笔记").navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .confirmationAction) {
        Button("完成") {
          guard pendingMedia == nil else { model.error = "请先重试上传或移除待上传附件。"; return }
          if notes.selectedID != noteID || document == nil { dismiss(); return }
          perform {
            guard await notes.saveSelected() else { return }
            await notes.relock(noteID: noteID)
            dismiss()
          }
        }.disabled(busy || notes.isWorking || notes.isAttachmentWorking).accessibilityIdentifier("note.done")
      }
      if !notes.location.isTrash {
        ToolbarItem(placement: .topBarLeading) {
          Menu {
            Button("立即保存", systemImage: "checkmark") { perform { await notes.saveSelected() } }
            Button("移动到文件夹", systemImage: "folder") { moving = true }
            if document?.isProtected == true {
              if unlocked {
                Button("锁定正文", systemImage: "lock") { perform { await notes.relock(noteID: noteID) } }
                Button("取消保护", systemImage: "lock.open") { perform { do { try await notes.unprotectSelected() } catch { model.error = error.localizedDescription } } }
              }
            } else {
              Button("保护正文", systemImage: "lock.shield") { password = ""; confirmation = ""; protecting = true }
            }
            Button("移到回收站", systemImage: "trash", role: .destructive) { destructiveAction = "trash" }
          } label: { Image(systemName: "ellipsis.circle").accessibilityLabel("笔记操作") }.disabled(!canOperate || notes.isAttachmentWorking || pendingMedia != nil)
        }
      }
    }
    .task(id: noteID) {
      guard MobileNoteSelection.isCurrent(noteID, in: notes) else { return }
      await notes.loadSelectedAttachments()
    }
    .sheet(isPresented: $protecting) {
      NavigationStack {
        Form {
          SecureField(notes.hasProtectionPassword ? "现有保护密码" : "设置保护密码", text: $password)
          if !notes.hasProtectionPassword { SecureField("确认保护密码", text: $confirmation) }
          Text("保护密码与登录密码独立，与安卓和 Mac 共用。")
          Button("保护这篇笔记") {
            perform {
              do {
                if notes.hasProtectionPassword { try await notes.protectSelected(password: password) }
                else { try await notes.setupAndProtectSelected(password: password, confirmation: confirmation) }
                password = ""; confirmation = ""; protecting = false
              } catch { model.error = error.localizedDescription }
            }
          }.disabled(password.isEmpty || !canOperate)
        }.navigationTitle("笔记保护")
          .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { protecting = false; password = ""; confirmation = "" }.disabled(busy) } }
      }.presentationDetents([.medium]).interactiveDismissDisabled(busy).mobileErrors()
    }
    .confirmationDialog("移动到文件夹", isPresented: $moving, titleVisibility: .visible) {
      Button("未分类") { perform { await move(nil) } }
      ForEach(notes.folders) { folder in Button(folder.name) { perform { await move(folder.id) } } }
    }
    .alert(destructiveAction == "purge" ? "永久删除笔记？" : destructiveAction == "trash" ? "移到回收站？" : "删除附件？",
      isPresented: Binding(get: { destructiveAction != nil }, set: { if !$0 { destructiveAction = nil } })) {
      Button("取消", role: .cancel) { destructiveAction = nil }
      Button("确认", role: .destructive) {
        let action = destructiveAction; destructiveAction = nil
        if action == "pending-media" {
          if let media = pendingMedia { MobileFiles.remove(media.url) }
          pendingMedia = nil
          return
        }
        perform {
          if action == "purge" { await notes.purgeSelected(); if document == nil { dismiss() } }
          else if action == "trash" { await notes.moveSelectedToTrash(); if document == nil { dismiss() } }
          else if let id = action { await notes.deleteAttachment(id: id) }
        }
      }
    } message: { Text(destructiveAction == "purge" ? "此操作无法撤销。" : "变更会同步到其他设备。") }
    .sheet(item: $preview, onDismiss: { if let url = previewURL { MobileFiles.remove(url) }; previewURL = nil }) { file in FilePreview(url: file.url) }
    .onDisappear { password = ""; confirmation = "" }
    .mobileErrors()
  }

  private var saveLabel: String {
    switch notes.saveState {
    case .idle: ""
    case .saving: "正在保存"
    case .saved: "已保存"
    case .failed: "保存失败，内容仍保留"
    case .conflict: "存在同步冲突"
    case .dirty: "等待保存"
    }
  }
  private func perform(_ operation: @escaping @MainActor () async -> Void) {
    guard canOperate else { return }
    busy = true
    Task {
      defer { busy = false }
      guard MobileNoteSelection.isCurrent(noteID, in: notes) else { return }
      await operation()
    }
  }

  private func add(_ media: CapturedMedia) {
    guard canOperate else {
      model.error = "笔记正在同步，请稍后重新添加附件。"
      MobileFiles.remove(media.url)
      return
    }
    pendingMedia = media
    perform {
      do {
        let data = try Data(contentsOf: media.url)
        if await notes.addImage(data: data, contentType: media.contentType, pixelWidth: media.width, pixelHeight: media.height, durationMillis: media.durationMillis) {
          MobileFiles.remove(media.url)
          pendingMedia = nil
        }
      } catch { model.error = error.localizedDescription }
    }
  }
  private func open(_ attachment: NoteAttachment) async {
    await notes.loadAttachmentImage(id: attachment.id)
    guard let data = notes.selectedAttachments.first(where: { $0.id == attachment.id })?.imageData else { return }
    do {
      let ext = attachment.metadata.contentType.hasPrefix("audio/") ? "m4a" : attachment.metadata.contentType == "image/png" ? "png" : attachment.metadata.contentType == "image/webp" ? "webp" : "jpg"
      let url = try MobileFiles.write(data, name: "attachment.\(ext)")
      previewURL = url; preview = MobileFile(url: url)
    } catch { model.error = error.localizedDescription }
  }
  private func move(_ folderID: String?) async {
    await notes.moveSelected(to: folderID)
    // The shared store may select a different row after moving; restore editor identity.
    notes.selectedID = noteID
  }
}


/// An editor is bound to an ID, while NotesStore also serves the list selection.
/// Reject stale callbacks instead of allowing them to edit a different row.
@MainActor
enum MobileNoteSelection {
  static func isCurrent(_ id: String, in store: NotesStore) -> Bool {
    !store.isWorking && store.selectedID == id && store.selectedDocument?.id == id
  }

  static func open(_ id: String, in store: NotesStore) -> Bool {
    guard !store.isWorking, store.visibleNotes.contains(where: { $0.id == id }) else { return false }
    store.selectedID = id
    return true
  }

  @discardableResult
  static func edit(_ id: String, in store: NotesStore, mutation: () -> Void) -> Bool {
    guard isCurrent(id, in: store) else { return false }
    mutation()
    return true
  }
}

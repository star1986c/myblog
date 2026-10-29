import SwiftUI
import PhotosUI
import AVFoundation
import QuickLook
import UniformTypeIdentifiers
import NotesCore

struct MobileFile: Identifiable {
  let id = UUID()
  let url: URL
}

struct CapturedMedia {
  let url: URL
  let contentType: String
  var width = 1
  var height = 1
  var durationMillis: Int?
}

enum MobileFiles {
  static var root: URL { FileManager.default.temporaryDirectory.appendingPathComponent("MyNotes-iOS", isDirectory: true) }

  static func write(_ data: Data, name: String) throws -> URL {
    let directory = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.complete])
    let filename = URL(fileURLWithPath: name).lastPathComponent
    let url = directory.appendingPathComponent(filename.isEmpty ? "attachment" : filename)
    try data.write(to: url, options: [.atomic, .completeFileProtection])
    return url
  }

  static func importFile(_ url: URL) throws -> URL {
    let scope = url.startAccessingSecurityScopedResource()
    defer { if scope { url.stopAccessingSecurityScopedResource() } }
    let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
    guard values.isRegularFile == true, let count = values.fileSize,
      count > 0, count <= HermesChatCrypto.maximumAttachmentBytes else {
      throw MediaError.message("附件应为非空文件，大小不超过 10 MiB。")
    }
    guard HermesChatAttachmentPolicy.kind(filename: url.lastPathComponent) != nil else {
      throw MediaError.message("暂不支持这种附件格式。")
    }
    return try write(Data(contentsOf: url), name: url.lastPathComponent)
  }

  static func copyPreview(_ source: URL, name: String) throws -> URL {
    let destination = try write(Data(), name: name)
    do {
      try FileManager.default.removeItem(at: destination)
      try FileManager.default.copyItem(at: source, to: destination)
      try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: destination.path)
      return destination
    } catch { remove(destination); throw error }
  }

  static func photo(_ image: UIImage) throws -> CapturedMedia {
    let longest = max(image.size.width, image.size.height)
    guard longest > 0 else { throw MediaError.message("无法读取照片。") }
    let ratio = min(1, 2560 / longest)
    let size = CGSize(width: image.size.width * ratio, height: image.size.height * ratio)
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    format.opaque = true
    let resized = UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
    guard let data = resized.jpegData(compressionQuality: 0.85) else { throw MediaError.message("无法处理照片。") }
    return CapturedMedia(url: try write(data, name: "photo.jpg"), contentType: "image/jpeg", width: Int(size.width), height: Int(size.height))
  }

  static func remove(_ url: URL) {
    guard url.standardizedFileURL.path.hasPrefix(root.path + "/") else { return }
    try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
  }

  static func cleanTemporaryFiles() {
    try? FileManager.default.removeItem(at: root)
    for name in ["MyNotes-Hermes", "MyNotes-Hermes-Downloads"] {
      try? FileManager.default.removeItem(at: FileManager.default.temporaryDirectory.appendingPathComponent(name))
    }
  }

  static func excludePrivateDataFromBackup() {
    // Server is the source of truth; private caches and keys must not migrate via a device backup.
    for location in [FileManager.SearchPathDirectory.applicationSupportDirectory, .cachesDirectory] {
      guard var url = FileManager.default.urls(for: location, in: .userDomainMask).first else { continue }
      try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try? url.setResourceValues(values)
      try? FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path)
    }
  }
}

enum MediaError: LocalizedError {
  case message(String)
  var errorDescription: String? { if case .message(let value) = self { value } else { nil } }
}

struct MediaPickerMenu: View {
  @EnvironmentObject private var model: MobileModel
  let includeFiles: Bool
  let onCapture: (CapturedMedia) -> Void
  let onFiles: ([URL]) -> Void
  @State private var photo: PhotosPickerItem?
  @State private var camera = false
  @State private var recording = false
  @State private var importing = false
  @State private var photoTask: Task<Void, Never>?

  var body: some View {
    Menu {
      PhotosPicker(selection: $photo, matching: .images) { Label("选择照片", systemImage: "photo") }
      if UIImagePickerController.isSourceTypeAvailable(.camera) {
        Button("拍照", systemImage: "camera") { camera = true }
      }
      Button("录音", systemImage: "mic") { recording = true }
      if includeFiles { Button("选择文件", systemImage: "doc") { importing = true } }
    } label: { Image(systemName: "plus.circle").font(.title2).accessibilityLabel("添加附件") }
      .onChange(of: photo) { _, item in
        photoTask?.cancel()
        guard let item else { return }
        photoTask = Task {
          defer { photo = nil }
          do {
            guard let data = try await item.loadTransferable(type: Data.self), !Task.isCancelled, let image = UIImage(data: data) else { return }
            onCapture(try MobileFiles.photo(image))
          } catch { model.error = error.localizedDescription }
        }
      }
      .onDisappear { photoTask?.cancel() }
      .sheet(isPresented: $camera) {
        CameraPicker { image in
          camera = false
          guard let image else { return }
          do { onCapture(try MobileFiles.photo(image)) } catch { model.error = error.localizedDescription }
        }.ignoresSafeArea()
      }
      .sheet(isPresented: $recording) { RecordingView(onCapture: onCapture) }
      .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
        do {
          let urls = try result.get()
          guard urls.count <= 8 else { throw MediaError.message("一条消息最多选择 8 个附件。") }
          var copies: [URL] = []
          do { for url in urls { copies.append(try MobileFiles.importFile(url)) } }
          catch { copies.forEach(MobileFiles.remove); throw error }
          onFiles(copies)
        } catch { model.error = error.localizedDescription }
      }
  }
}

private struct CameraPicker: UIViewControllerRepresentable {
  let completion: (UIImage?) -> Void
  func makeCoordinator() -> Coordinator { Coordinator(completion) }
  func makeUIViewController(context: Context) -> UIImagePickerController {
    let controller = UIImagePickerController()
    controller.sourceType = .camera
    controller.delegate = context.coordinator
    return controller
  }
  func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}
  final class Coordinator: NSObject, UINavigationControllerDelegate, UIImagePickerControllerDelegate {
    let completion: (UIImage?) -> Void
    init(_ completion: @escaping (UIImage?) -> Void) { self.completion = completion }
    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { completion(nil) }
    func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
      completion(info[.originalImage] as? UIImage)
    }
  }
}

struct FilePreview: UIViewControllerRepresentable {
  let url: URL
  func makeCoordinator() -> Coordinator { Coordinator(url) }
  func makeUIViewController(context: Context) -> QLPreviewController {
    let view = QLPreviewController()
    view.dataSource = context.coordinator
    return view
  }
  func updateUIViewController(_ controller: QLPreviewController, context: Context) {}
  final class Coordinator: NSObject, QLPreviewControllerDataSource {
    let url: URL
    init(_ url: URL) { self.url = url }
    func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
    func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> any QLPreviewItem { url as NSURL }
  }
}

@MainActor
final class AudioRecorder: NSObject, ObservableObject, AVAudioRecorderDelegate {
  @Published var recording = false
  @Published private(set) var isStarting = false
  @Published private(set) var isFinishing = false
  @Published var result: CapturedMedia?
  @Published var error: String?
  private var recorder: AVAudioRecorder?
  private var measuredDuration = 0
  private var startedAt = Date()
  private var generation: UInt64 = 0
  private let requestPermission: @MainActor () async -> Bool

  init(requestPermission: @escaping @MainActor () async -> Bool = { await AVAudioApplication.requestRecordPermission() }) {
    self.requestPermission = requestPermission
  }

  func start() async {
    guard !recording, !isStarting, !isFinishing else { return }
    generation &+= 1
    let requestGeneration = generation
    isStarting = true
    error = nil
    defer { if generation == requestGeneration { isStarting = false } }
    let granted = await requestPermission()
    guard generation == requestGeneration, !Task.isCancelled else { return }
    guard granted else { error = "请在系统设置中允许 My Notes 使用麦克风。"; return }
    do {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
      try session.setActive(true)
      let url = try MobileFiles.write(Data(), name: "recording.m4a")
      let recorder = try AVAudioRecorder(url: url, settings: [AVFormatIDKey: kAudioFormatMPEG4AAC,
        AVSampleRateKey: 44_100, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 96_000])
      recorder.delegate = self
      self.recorder = recorder
      guard recorder.record(forDuration: 300) else { throw MediaError.message("无法开始录音。") }
      measuredDuration = 0
      startedAt = Date()
      recording = true
    } catch { self.error = error.localizedDescription; cancel() }
  }
  func finish() {
    guard recording, !isFinishing else { return }
    isFinishing = true
    measuredDuration = Int((recorder?.currentTime ?? 0) * 1000)
    recorder?.stop()
    recording = false
  }
  func cancel() {
    generation &+= 1
    isStarting = false
    isFinishing = false
    result = nil
    let url = recorder?.url
    recorder?.delegate = nil
    recorder?.stop()
    recorder = nil
    recording = false
    if let url { MobileFiles.remove(url) }
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }
  nonisolated func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
    let url = recorder.url
    Task { @MainActor in
      guard self.recorder?.url == url else { return }
      self.recorder?.delegate = nil
      self.recorder = nil
      isFinishing = false
      recording = false
      if flag {
        let duration = measuredDuration > 0 ? measuredDuration : Int(Date().timeIntervalSince(startedAt) * 1000)
        result = CapturedMedia(url: url, contentType: "audio/mp4", durationMillis: min(300_000, max(1, duration)))
      } else { error = "录音中断，请重新录制。" }
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
  }
}

private struct RecordingView: View {
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var phase
  @StateObject private var recorder = AudioRecorder()
  let onCapture: (CapturedMedia) -> Void
  @State private var handedOff = false
  var body: some View {
    NavigationStack {
      VStack(spacing: 24) {
        Image(systemName: recorder.recording ? "waveform" : "mic").font(.system(size: 64)).foregroundStyle(MobileTheme.accent)
        Text(recorder.recording ? "正在录音，最长 5 分钟" : "准备录音")
        if let error = recorder.error { Text(error).foregroundStyle(.red) }
        Button(recorder.recording ? "完成录音" : "开始录音") {
          if recorder.recording { recorder.finish() } else { Task { await recorder.start() } }
        }.buttonStyle(.borderedProminent).disabled(recorder.isStarting || recorder.isFinishing)
        if recorder.isStarting { ProgressView("正在申请麦克风权限…") }
      }.navigationTitle("语音附件").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { recorder.cancel(); dismiss() } } }
        .onChange(of: recorder.result?.url) { _, _ in
          if let result = recorder.result { handedOff = true; onCapture(result); dismiss() }
        }
        .onChange(of: phase) { _, phase in if phase == .background { recorder.cancel(); dismiss() } }
        .onDisappear { if !handedOff { recorder.cancel() } }
    }.presentationDetents([.medium]).interactiveDismissDisabled(recorder.recording)
  }
}

/// Cover the whole window, including Quick Look and presented editors, in app-switcher snapshots.
@MainActor
enum MobilePrivacyShield {
  private static let tag = 7_103_681
  static func setVisible(_ visible: Bool) {
    for scene in UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }) {
      for window in scene.windows {
        if visible {
          guard window.viewWithTag(tag) == nil else { continue }
          let cover = UIView(frame: window.bounds)
          cover.tag = tag
          cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
          cover.backgroundColor = .systemGroupedBackground
          let label = UILabel()
          label.text = "My Notes"
          label.font = .preferredFont(forTextStyle: .title2)
          label.textColor = .secondaryLabel
          label.translatesAutoresizingMaskIntoConstraints = false
          cover.addSubview(label)
          NSLayoutConstraint.activate([label.centerXAnchor.constraint(equalTo: cover.centerXAnchor), label.centerYAnchor.constraint(equalTo: cover.centerYAnchor)])
          window.addSubview(cover)
        } else { window.viewWithTag(tag)?.removeFromSuperview() }
      }
    }
  }
}

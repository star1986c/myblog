import Foundation
import UniformTypeIdentifiers

public enum HermesChatAttachmentKind: String, Codable, Sendable {
  case image
  case audio
  case video
  case document
  case office
  case archive
  case package
}
public enum HermesChatAttachmentPolicy {
  public static let supportedExtensions: [HermesChatAttachmentKind: Set<String>] = [
    .image: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "svg"],
    .audio: ["mp3", "wav", "ogg", "m4a", "opus", "flac", "aac"],
    .video: ["mp4", "mov", "webm", "mkv", "avi"],
    .document: ["pdf", "txt", "md", "csv", "json", "xml", "html", "yaml", "yml", "log"],
    .office: ["doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp"],
    .archive: ["zip", "rar", "7z", "tar", "gz", "bz2"],
    .package: ["epub", "apk", "ipa"],
  ]

  public static func kind(filename: String, contentType: String = "")
    -> HermesChatAttachmentKind?
  {
    let ext = URL(fileURLWithPath: filename).pathExtension.lowercased()
    if let match = supportedExtensions.first(where: { $0.value.contains(ext) })?.key {
      return match
    }
    if contentType.hasPrefix("image/") { return .image }
    if contentType.hasPrefix("audio/") { return .audio }
    if contentType.hasPrefix("video/") { return .video }
    return nil
  }

  public static func contentType(for url: URL) -> String {
    UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
      ?? "application/octet-stream"
  }

  public static func systemImage(
    filename: String,
    contentType: String
  ) -> String {
    switch kind(filename: filename, contentType: contentType) {
    case .image: "photo"
    case .audio: "waveform"
    case .video: "film"
    case .document: contentType == "application/pdf" ? "doc.richtext" : "doc.text"
    case .office:
      filename.lowercased().hasSuffix(".xlsx") || filename.lowercased().hasSuffix(".xls")
        ? "tablecells" : "doc.text"
    case .archive: "archivebox"
    case .package: "shippingbox"
    case nil: "doc"
    }
  }
}

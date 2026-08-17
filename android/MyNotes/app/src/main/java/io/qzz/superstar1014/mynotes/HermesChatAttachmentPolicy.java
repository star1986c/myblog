package io.qzz.superstar1014.mynotes;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/** Shared allowlist and display metadata for encrypted Hermes chat attachments. */
final class HermesChatAttachmentPolicy {
  enum Category {
    IMAGE("图片"),
    AUDIO("音频"),
    VIDEO("视频"),
    DOCUMENT("文档"),
    OFFICE("Office"),
    ARCHIVE("压缩包"),
    BOOK("电子书"),
    PACKAGE("安装包");

    final String label;

    Category(String label) {
      this.label = label;
    }
  }

  static final class ResolvedType {
    final String extension;
    final String contentType;
    final Category category;
    final boolean previewableImage;

    ResolvedType(
      String extension,
      String contentType,
      Category category,
      boolean previewableImage
    ) {
      this.extension = extension;
      this.contentType = contentType;
      this.category = category;
      this.previewableImage = previewableImage;
    }
  }

  private static final Map<String, ResolvedType> BY_EXTENSION;
  private static final Map<String, ResolvedType> BY_CONTENT_TYPE;

  static {
    LinkedHashMap<String, ResolvedType> extensions = new LinkedHashMap<>();

    add(extensions, "png", "image/png", Category.IMAGE, true);
    add(extensions, "jpg", "image/jpeg", Category.IMAGE, true);
    add(extensions, "jpeg", "image/jpeg", Category.IMAGE, true);
    add(extensions, "gif", "image/gif", Category.IMAGE, true);
    add(extensions, "webp", "image/webp", Category.IMAGE, true);
    add(extensions, "bmp", "image/bmp", Category.IMAGE, true);
    add(extensions, "tif", "image/tiff", Category.IMAGE, false);
    add(extensions, "tiff", "image/tiff", Category.IMAGE, false);
    add(extensions, "svg", "image/svg+xml", Category.IMAGE, false);

    add(extensions, "mp3", "audio/mpeg", Category.AUDIO, false);
    add(extensions, "wav", "audio/wav", Category.AUDIO, false);
    add(extensions, "ogg", "audio/ogg", Category.AUDIO, false);
    add(extensions, "m4a", "audio/mp4", Category.AUDIO, false);
    add(extensions, "opus", "audio/opus", Category.AUDIO, false);
    add(extensions, "flac", "audio/flac", Category.AUDIO, false);
    add(extensions, "aac", "audio/aac", Category.AUDIO, false);

    add(extensions, "mp4", "video/mp4", Category.VIDEO, false);
    add(extensions, "mov", "video/quicktime", Category.VIDEO, false);
    add(extensions, "webm", "video/webm", Category.VIDEO, false);
    add(extensions, "mkv", "video/x-matroska", Category.VIDEO, false);
    add(extensions, "avi", "video/x-msvideo", Category.VIDEO, false);

    add(extensions, "pdf", "application/pdf", Category.DOCUMENT, false);
    add(extensions, "txt", "text/plain", Category.DOCUMENT, false);
    add(extensions, "md", "text/markdown", Category.DOCUMENT, false);
    add(extensions, "csv", "text/csv", Category.DOCUMENT, false);
    add(extensions, "json", "application/json", Category.DOCUMENT, false);
    add(extensions, "xml", "application/xml", Category.DOCUMENT, false);
    add(extensions, "html", "text/html", Category.DOCUMENT, false);
    add(extensions, "yaml", "application/yaml", Category.DOCUMENT, false);
    add(extensions, "yml", "application/yaml", Category.DOCUMENT, false);
    add(extensions, "log", "text/plain", Category.DOCUMENT, false);

    // Modern formats from the Hermes attachment table plus legacy Office compatibility.
    add(extensions, "doc", "application/msword", Category.OFFICE, false);
    add(extensions, "docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", Category.OFFICE, false);
    add(extensions, "xls", "application/vnd.ms-excel", Category.OFFICE, false);
    add(extensions, "xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", Category.OFFICE, false);
    add(extensions, "ppt", "application/vnd.ms-powerpoint", Category.OFFICE, false);
    add(extensions, "pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", Category.OFFICE, false);
    add(extensions, "odt", "application/vnd.oasis.opendocument.text", Category.OFFICE, false);
    add(extensions, "ods", "application/vnd.oasis.opendocument.spreadsheet", Category.OFFICE, false);
    add(extensions, "odp", "application/vnd.oasis.opendocument.presentation", Category.OFFICE, false);

    add(extensions, "zip", "application/zip", Category.ARCHIVE, false);
    add(extensions, "rar", "application/vnd.rar", Category.ARCHIVE, false);
    add(extensions, "7z", "application/x-7z-compressed", Category.ARCHIVE, false);
    add(extensions, "tar", "application/x-tar", Category.ARCHIVE, false);
    add(extensions, "gz", "application/gzip", Category.ARCHIVE, false);
    add(extensions, "bz2", "application/x-bzip2", Category.ARCHIVE, false);

    add(extensions, "epub", "application/epub+zip", Category.BOOK, false);
    add(extensions, "apk", "application/vnd.android.package-archive", Category.PACKAGE, false);
    add(extensions, "ipa", "application/octet-stream", Category.PACKAGE, false);

    BY_EXTENSION = Collections.unmodifiableMap(extensions);
    LinkedHashMap<String, ResolvedType> contentTypes = new LinkedHashMap<>();
    for (ResolvedType type : extensions.values()) contentTypes.putIfAbsent(type.contentType, type);
    contentTypes.put("image/jpg", extensions.get("jpg"));
    contentTypes.put("audio/x-wav", extensions.get("wav"));
    contentTypes.put("audio/x-flac", extensions.get("flac"));
    contentTypes.put("application/x-rar-compressed", extensions.get("rar"));
    contentTypes.put("application/x-gzip", extensions.get("gz"));
    contentTypes.put("application/x-bzip2", extensions.get("bz2"));
    contentTypes.put("text/x-markdown", extensions.get("md"));
    contentTypes.put("text/xml", extensions.get("xml"));
    contentTypes.put("application/x-yaml", extensions.get("yaml"));
    contentTypes.put("text/yaml", extensions.get("yaml"));
    BY_CONTENT_TYPE = Collections.unmodifiableMap(contentTypes);
  }

  private HermesChatAttachmentPolicy() {}

  static ResolvedType resolve(String providerContentType, String filename) {
    String extension = extensionOf(filename);
    ResolvedType byExtension = BY_EXTENSION.get(extension);
    if (byExtension != null) return byExtension;

    String normalizedType = normalizeContentType(providerContentType);
    ResolvedType byContentType = BY_CONTENT_TYPE.get(normalizedType);
    if (byContentType != null && !"application/octet-stream".equals(normalizedType)) {
      return byContentType;
    }
    throw new IllegalArgumentException("不支持此附件格式。请选择支持的图片、音视频、文档或压缩包。");
  }

  static boolean isPreviewableImage(String contentType, String filename) {
    try {
      return resolve(contentType, filename).previewableImage;
    } catch (IllegalArgumentException ignored) {
      return false;
    }
  }

  static String safeDisplayName(String value, ResolvedType type) {
    String filename = value == null ? "" : value.replaceAll("[\\\\/:*?\"<>|]", "_")
      .replaceAll("^[ .]+|[ .]+$", "");
    if (filename.isEmpty()) filename = "Hermes-附件." + type.extension;
    if (!filename.contains(".")) filename += "." + type.extension;
    return filename.length() > 120 ? filename.substring(0, 120) : filename;
  }

  static String formatBytes(long bytes) {
    if (bytes < 0) return "大小未知";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) {
      return String.format(Locale.ROOT, "%.1f KiB", bytes / 1024.0);
    }
    return String.format(Locale.ROOT, "%.1f MiB", bytes / (1024.0 * 1024.0));
  }

  private static String extensionOf(String filename) {
    String value = filename == null ? "" : filename.trim();
    int index = value.lastIndexOf('.');
    if (index < 0 || index == value.length() - 1) return "";
    return value.substring(index + 1).toLowerCase(Locale.ROOT);
  }

  private static String normalizeContentType(String value) {
    if (value == null) return "application/octet-stream";
    String normalized = value.split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
    return normalized.isEmpty() ? "application/octet-stream" : normalized;
  }

  private static void add(
    Map<String, ResolvedType> target,
    String extension,
    String contentType,
    Category category,
    boolean previewableImage
  ) {
    target.put(
      extension,
      new ResolvedType(extension, contentType, category, previewableImage)
    );
  }
}

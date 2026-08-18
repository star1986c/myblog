package io.qzz.superstar1014.mynotes;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.util.Locale;

/** Exposes short-lived decrypted chat images through explicitly granted read-only URIs. */
public final class HermesShareFileProvider extends ContentProvider {
  static final String AUTHORITY = "io.qzz.superstar1014.mynotes.hermes-share";
  private static final String DIRECTORY = "hermes-chat-share";

  static File createImageFile(Context context, String extension) throws IOException {
    String safeExtension = extension == null ? "png" : extension.toLowerCase(Locale.ROOT);
    if (!safeExtension.matches("png|jpe?g|gif|webp|bmp")) {
      throw new IOException("Unsupported shared image extension");
    }
    File directory = shareDirectory(context);
    return File.createTempFile("hermes-image-", "." + safeExtension, directory);
  }

  static Uri uriFor(Context context, File file, String displayName) throws IOException {
    File safe = requireShareFile(context, file.getName());
    if (!safe.equals(file.getCanonicalFile())) throw new IOException("Invalid share file");
    String name = safeDisplayName(displayName, file.getName());
    return new Uri.Builder()
      .scheme("content")
      .authority(AUTHORITY)
      .appendPath("image")
      .appendPath(file.getName())
      .appendQueryParameter("name", name)
      .build();
  }

  static void cleanupStale(Context context, long cutoffMillis) {
    try {
      File[] files = shareDirectory(context).listFiles();
      if (files == null) return;
      for (File file : files) {
        if (file.isFile() && file.lastModified() < cutoffMillis) file.delete();
      }
    } catch (IOException ignored) {
      // Cache cleanup is best effort; files remain private to this app.
    }
  }

  @Override public boolean onCreate() { return true; }

  @Override
  public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
    if (!"r".equals(mode)) throw new FileNotFoundException("Share URI is read-only");
    try {
      return ParcelFileDescriptor.open(resolve(uri), ParcelFileDescriptor.MODE_READ_ONLY);
    } catch (Exception error) {
      throw new FileNotFoundException("Invalid Hermes share URI");
    }
  }

  @Override
  public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs,
    String sortOrder) {
    try {
      File file = resolve(uri);
      String[] columns = projection == null
        ? new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE }
        : projection;
      MatrixCursor cursor = new MatrixCursor(columns, 1);
      Object[] row = new Object[columns.length];
      for (int index = 0; index < columns.length; index++) {
        if (OpenableColumns.DISPLAY_NAME.equals(columns[index])) {
          row[index] = safeDisplayName(uri.getQueryParameter("name"), file.getName());
        } else if (OpenableColumns.SIZE.equals(columns[index])) {
          row[index] = file.length();
        }
      }
      cursor.addRow(row);
      return cursor;
    } catch (Exception ignored) {
      return new MatrixCursor(projection == null ? new String[0] : projection, 0);
    }
  }

  @Override
  public String getType(Uri uri) {
    try {
      String name = resolve(uri).getName().toLowerCase(Locale.ROOT);
      if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
      if (name.endsWith(".gif")) return "image/gif";
      if (name.endsWith(".webp")) return "image/webp";
      if (name.endsWith(".bmp")) return "image/bmp";
      return "image/png";
    } catch (Exception ignored) {
      return "application/octet-stream";
    }
  }

  @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
  @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { return 0; }
  @Override public int delete(Uri uri, String selection, String[] selectionArgs) { return 0; }

  private File resolve(Uri uri) throws IOException {
    if (!AUTHORITY.equals(uri.getAuthority()) || uri.getPathSegments().size() != 2
        || !"image".equals(uri.getPathSegments().get(0))) {
      throw new IOException("Invalid Hermes share URI");
    }
    Context context = getContext();
    if (context == null) throw new IOException("Provider unavailable");
    File file = requireShareFile(context, uri.getPathSegments().get(1));
    if (!file.isFile()) throw new IOException("Share file missing");
    return file;
  }

  private static File requireShareFile(Context context, String name) throws IOException {
    if (name == null || !name.matches("[A-Za-z0-9._-]{1,100}")) {
      throw new IOException("Invalid share filename");
    }
    File directory = shareDirectory(context);
    File file = new File(directory, name).getCanonicalFile();
    if (!directory.equals(file.getParentFile())) throw new IOException("Invalid share path");
    return file;
  }

  private static File shareDirectory(Context context) throws IOException {
    File directory = new File(context.getCacheDir(), DIRECTORY).getCanonicalFile();
    if (!directory.exists() && !directory.mkdirs()) {
      throw new IOException("Cannot create share cache");
    }
    return directory;
  }

  private static String safeDisplayName(String value, String fallback) {
    String name = value == null ? "" : value.replaceAll("[\\r\\n\\u0000/\\\\]", "_").trim();
    if (name.isEmpty()) name = fallback;
    return name.length() > 120 ? name.substring(0, 120) : name;
  }
}

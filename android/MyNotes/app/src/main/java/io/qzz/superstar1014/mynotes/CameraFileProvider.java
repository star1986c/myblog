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

/** Grants the system camera temporary access to one app-private capture file. */
public final class CameraFileProvider extends ContentProvider {
  static final String AUTHORITY = "io.qzz.superstar1014.mynotes.camera";

  static Uri uriFor(Context context, File file) throws IOException {
    File safe = requireCaptureFile(context, file.getName());
    if (!safe.equals(file.getCanonicalFile())) throw new IOException("Invalid capture file");
    return new Uri.Builder()
      .scheme("content")
      .authority(AUTHORITY)
      .appendPath("capture")
      .appendPath(file.getName())
      .build();
  }

  @Override public boolean onCreate() { return true; }

  @Override
  public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
    try {
      File file = resolve(uri);
      return ParcelFileDescriptor.open(file, ParcelFileDescriptor.parseMode(mode));
    } catch (Exception error) {
      throw new FileNotFoundException("Invalid camera capture URI");
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
        if (OpenableColumns.DISPLAY_NAME.equals(columns[index])) row[index] = file.getName();
        else if (OpenableColumns.SIZE.equals(columns[index])) row[index] = file.length();
      }
      cursor.addRow(row);
      return cursor;
    } catch (Exception ignored) {
      return new MatrixCursor(projection == null ? new String[0] : projection, 0);
    }
  }

  @Override public String getType(Uri uri) { return "image/jpeg"; }
  @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
  @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { return 0; }

  @Override
  public int delete(Uri uri, String selection, String[] selectionArgs) {
    try { return resolve(uri).delete() ? 1 : 0; }
    catch (Exception ignored) { return 0; }
  }

  private File resolve(Uri uri) throws IOException {
    if (!AUTHORITY.equals(uri.getAuthority()) || uri.getPathSegments().size() != 2
      || !"capture".equals(uri.getPathSegments().get(0))) {
      throw new IOException("Invalid capture URI");
    }
    Context context = getContext();
    if (context == null) throw new IOException("Provider unavailable");
    return requireCaptureFile(context, uri.getPathSegments().get(1));
  }

  private static File requireCaptureFile(Context context, String name) throws IOException {
    if (name == null || !name.matches("[A-Za-z0-9._-]{1,100}")) {
      throw new IOException("Invalid capture filename");
    }
    File directory = new File(context.getCacheDir(), "camera-captures").getCanonicalFile();
    if (!directory.exists() && !directory.mkdirs()) throw new IOException("Cannot create capture directory");
    File file = new File(directory, name).getCanonicalFile();
    if (!directory.equals(file.getParentFile())) throw new IOException("Invalid capture path");
    return file;
  }
}

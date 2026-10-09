package gr.argyrismitsos.fleetcontrol;

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

/**
 * Read-only content provider used to hand the downloaded update APK to the
 * Android package installer without exposing the app's private files.
 */
public final class FleetUpdateProvider extends ContentProvider {
    public static final String AUTHORITY = "gr.argyrismitsos.fleetcontrol.updateprovider";
    public static final String UPDATE_FILE_NAME = "fleet-control-update.apk";

    private File updateFile() {
        Context context = getContext();
        if (context == null) throw new IllegalStateException("Ο provider δεν είναι διαθέσιμος.");
        return new File(context.getCacheDir(), UPDATE_FILE_NAME);
    }

    private boolean isUpdateUri(Uri uri) {
        return uri != null && "update.apk".equals(uri.getLastPathSegment());
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public String getType(Uri uri) {
        return isUpdateUri(uri) ? "application/vnd.android.package-archive" : null;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!isUpdateUri(uri) || !"r".equals(mode)) {
            throw new FileNotFoundException("Μη έγκυρο αρχείο ενημέρωσης.");
        }
        File file = updateFile();
        if (!file.isFile()) throw new FileNotFoundException("Δεν βρέθηκε το APK ενημέρωσης.");
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        if (!isUpdateUri(uri) || !updateFile().isFile()) return null;
        MatrixCursor cursor = new MatrixCursor(new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE});
        cursor.addRow(new Object[]{UPDATE_FILE_NAME, updateFile().length()});
        return cursor;
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return isUpdateUri(uri) && updateFile().delete() ? 1 : 0;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException("Read-only provider");
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException("Read-only provider");
    }
}

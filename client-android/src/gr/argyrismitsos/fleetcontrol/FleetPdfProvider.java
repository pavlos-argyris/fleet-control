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
 * Read-only provider for a PDF fetched by the WebView. Android PDF viewers
 * cannot open a blob URL from a WebView, so the client gives them this
 * temporary, permission-scoped content URI instead.
 */
public final class FleetPdfProvider extends ContentProvider {
    public static final String AUTHORITY = "gr.argyrismitsos.fleetcontrol.pdfprovider";
    public static final String PDF_FILE_NAME = "fleet-control-preview.pdf";
    private static final String DISPLAY_NAME_KEY = "fleet_control_preview_name";

    private File pdfFile() {
        Context context = getContext();
        if (context == null) throw new IllegalStateException("Ο provider PDF δεν είναι διαθέσιμος.");
        return new File(context.getCacheDir(), PDF_FILE_NAME);
    }

    private boolean isPdfUri(Uri uri) {
        return uri != null && "preview.pdf".equals(uri.getLastPathSegment());
    }

    public static Uri uri() {
        return Uri.parse("content://" + AUTHORITY + "/preview.pdf");
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public String getType(Uri uri) {
        return isPdfUri(uri) ? "application/pdf" : null;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!isPdfUri(uri) || !"r".equals(mode)) {
            throw new FileNotFoundException("Μη έγκυρο PDF.");
        }
        File file = pdfFile();
        if (!file.isFile()) throw new FileNotFoundException("Δεν βρέθηκε το PDF.");
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        File file = pdfFile();
        if (!isPdfUri(uri) || !file.isFile()) return null;
        String name = getContext().getSharedPreferences("fleet_control_pdf", Context.MODE_PRIVATE)
                .getString(DISPLAY_NAME_KEY, PDF_FILE_NAME);
        MatrixCursor cursor = new MatrixCursor(new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE});
        cursor.addRow(new Object[]{name, file.length()});
        return cursor;
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return isPdfUri(uri) && pdfFile().delete() ? 1 : 0;
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

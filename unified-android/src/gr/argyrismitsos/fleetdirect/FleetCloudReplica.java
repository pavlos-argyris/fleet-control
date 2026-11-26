package gr.argyrismitsos.fleetdirect;

import android.content.Context;
import android.database.Cursor;
import org.sqlite.database.sqlite.SQLiteDatabase;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/** Holds the remote journal in a separate private SQLite replica before cutover. */
final class FleetCloudReplica {
    static final long MAX_DOCUMENT_BYTES=15L*1024*1024;
    private static final long MAX_CURSOR=9007199254740991L;
    private static final Set<String> KINDS=new HashSet<>(Arrays.asList("machine","service","mileage","invoice"));
    private FleetCloudReplica() { }

    interface Pull { JSONObject page(long cursor) throws Exception; }
    interface DocumentPull { void copy(String sha256,long expectedSize,OutputStream output) throws Exception; }

    static JSONObject sync(Context context,String epoch,Pull pull,DocumentPull documents) throws Exception {
        if (!ScopedContext.owns(context)) throw invalidDelta();
        File location=new File(context.getNoBackupFilesDir(),"fleet-cloud-replica.sqlite");
        File directory=new File(context.getNoBackupFilesDir(),"fleet-cloud-documents");
        try (SQLiteDatabase database=SQLiteDatabase.openDatabase(location.getPath(),null,SQLiteDatabase.CREATE_IF_NECESSARY)) {
            initialize(database,epoch);
            long cursor=readCursor(database,epoch);
            boolean more=false;
            for (int count=0;count<6;count++) {
                JSONObject page=pull.page(cursor);
                cursor=apply(database,epoch,cursor,page,directory,documents);
                more=page.getBoolean("hasMore");
                if (!more) break;
            }
            return new JSONObject().put("cursor",cursor).put("hasMore",more);
        }
    }

    static void initialize(SQLiteDatabase db,String epoch) throws Exception {
        if (!epoch.matches("[a-f0-9]{32}")) throw invalidDelta();
        db.beginTransaction();
        try {
            db.execSQL("CREATE TABLE IF NOT EXISTS fleet_cloud_checkpoint(id INTEGER PRIMARY KEY CHECK(id=1),epoch TEXT NOT NULL,cursor INTEGER NOT NULL)");
            db.execSQL("CREATE TABLE IF NOT EXISTS fleet_cloud_replica(kind TEXT NOT NULL,machine_id TEXT NOT NULL,record_id TEXT NOT NULL,"+
                    "service_id TEXT NOT NULL,revision INTEGER NOT NULL,deleted INTEGER NOT NULL,data TEXT,"+
                    "PRIMARY KEY(kind,machine_id,record_id))");
            db.execSQL("INSERT OR IGNORE INTO fleet_cloud_checkpoint(id,epoch,cursor) VALUES(1,?,0)",new Object[]{epoch});
            readCursor(db,epoch);
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }

    static long apply(SQLiteDatabase db,String epoch,long previous,JSONObject page,File directory,DocumentPull documents) throws Exception {
        if (!epoch.equals(page.getString("epoch"))) throw invalidDelta();
        JSONArray changes=page.getJSONArray("changes");
        long next=integer(page,"nextCursor");
        boolean more=bool(page,"hasMore");
        if (changes.length()>24 || next<previous || (next==previous&&(more||changes.length()!=0))) throw invalidDelta();
        copyInvoiceFiles(changes,directory,documents);
        db.beginTransaction();
        try {
            if (readCursor(db,epoch)!=previous) throw invalidDelta();
            long position=previous;
            for (int i=0;i<changes.length();i++) {
                JSONObject change=changes.getJSONObject(i);
                long cursor=integer(change,"cursor");
                if (cursor<=position||cursor>next) throw invalidDelta();
                writeRecord(db,change);
                position=cursor;
            }
            if (position!=next) throw invalidDelta();
            if (next>previous) db.execSQL("UPDATE fleet_cloud_checkpoint SET cursor=? WHERE id=1 AND epoch=?",new Object[]{next,epoch});
            db.setTransactionSuccessful();
            return next;
        } finally { db.endTransaction(); }
    }

    private static void copyInvoiceFiles(JSONArray changes,File directory,DocumentPull documents) throws Exception {
        for (int i=0;i<changes.length();i++) {
            JSONObject change=changes.getJSONObject(i);
            if (!"invoice".equals(change.getString("kind"))||bool(change,"deleted")) continue;
            JSONObject invoice=change.getJSONObject("data");
            long size=integer(invoice,"size");
            if (size==0||size>MAX_DOCUMENT_BYTES) throw invalidDocument();
            copyDocument(directory,documents,invoice.getString("sha256"),size);
            String source=invoice.optString("sourceSha256");
            if (!source.isEmpty()) copyDocument(directory,documents,source,0);
        }
    }

    private static void copyDocument(File directory,DocumentPull documents,String sha,long expectedSize) throws Exception {
        if (!sha.matches("[a-f0-9]{64}")||Files.isSymbolicLink(directory.toPath())||
                (!directory.isDirectory()&&!directory.mkdir()&&!directory.isDirectory())) throw invalidDocument();
        File installed=new File(directory,sha);
        if (Files.isSymbolicLink(installed.toPath())||(installed.exists()&&!installed.isFile())) throw invalidDocument();
        if (matchesDocument(installed,sha,expectedSize)) return;
        File pending=File.createTempFile("fleet-file-",".part",directory);
        try {
            try (FileOutputStream output=new FileOutputStream(pending)) {
                documents.copy(sha,expectedSize,output);
                output.getFD().sync();
            }
            if (!matchesDocument(pending,sha,expectedSize)) throw invalidDocument();
            Files.move(pending.toPath(),installed.toPath(),StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);
            NativeColdRuntime.sync(directory);
        } finally { Files.deleteIfExists(pending.toPath()); }
    }

    private static boolean matchesDocument(File file,String sha,long size) throws Exception {
        long bytes=file.length();
        return file.isFile()&&bytes>0&&bytes<=MAX_DOCUMENT_BYTES&&(size==0||bytes==size)&&sha.equals(NativeDatabaseSnapshot.digest(file));
    }

    private static long readCursor(SQLiteDatabase db,String epoch) throws Exception {
        try (Cursor found=db.rawQuery("SELECT cursor FROM fleet_cloud_checkpoint WHERE id=1 AND epoch=?",new String[]{epoch})) {
            if (!found.moveToFirst()) throw invalidDelta();
            return found.getLong(0);
        }
    }

    private static void writeRecord(SQLiteDatabase db,JSONObject change) throws Exception {
        String kind=change.getString("kind"),machine=id(change.getString("machineId")),key=id(change.getString("recordId"));
        String service=change.getString("serviceId");
        long expected=integer(change,"revision");
        boolean deleted=bool(change,"deleted");
        if (kind.equals("invoice")) id(service);
        else if (!service.isEmpty()) throw invalidDelta();
        if (!KINDS.contains(kind)||expected==0||(kind.equals("machine")&&!machine.equals(key))||
                (deleted?!change.has("data")||!change.isNull("data"):change.optJSONObject("data")==null)) throw invalidDelta();
        long current=0;
        try (Cursor row=db.rawQuery("SELECT revision,service_id FROM fleet_cloud_replica WHERE kind=? AND machine_id=? AND record_id=?",
                new String[]{kind,machine,key})) {
            if (row.moveToFirst()) {
                current=row.getLong(0);
                if (!service.equals(row.getString(1))) throw invalidDelta();
            }
        }
        if (current+1!=expected || (current==0&&deleted)) throw invalidDelta();
        String content=deleted?null:change.getJSONObject("data").toString();
        if (current==0) db.execSQL("INSERT INTO fleet_cloud_replica(kind,machine_id,record_id,service_id,revision,deleted,data) VALUES(?,?,?,?,?,?,?)",
                new Object[]{kind,machine,key,service,expected,0,content});
        else db.execSQL("UPDATE fleet_cloud_replica SET revision=?,deleted=?,data=? WHERE kind=? AND machine_id=? AND record_id=?",
                new Object[]{expected,deleted?1:0,content,kind,machine,key});
    }

    private static long integer(JSONObject value,String key) throws Exception {
        Object raw=value.get(key);
        if (!(raw instanceof Number)) throw invalidDelta();
        long integer=((Number)raw).longValue();
        if (integer<0||integer>MAX_CURSOR||((Number)raw).doubleValue()!=integer) throw invalidDelta();
        return integer;
    }

    private static boolean bool(JSONObject value,String key) throws Exception {
        Object raw=value.get(key);
        if (!(raw instanceof Boolean)) throw invalidDelta();
        return (Boolean)raw;
    }

    private static String id(String value) throws IOException {
        if (value.isEmpty()||value.length()>160||value.indexOf(0)>=0) throw invalidDelta();
        return value;
    }

    private static IOException invalidDelta() {
        return new IOException("Η δοκιμαστική SQLite δεν επιβεβαίωσε τη σειρά ή την έκδοση των αλλαγών Fleet.");
    }

    private static IOException invalidDocument() {
        return new IOException("Δεν επαληθεύτηκε το αρχείο της δοκιμαστικής αντιγραφής Fleet.");
    }
}

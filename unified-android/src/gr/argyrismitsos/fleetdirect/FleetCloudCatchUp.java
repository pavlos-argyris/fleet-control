package gr.argyrismitsos.fleetdirect;

import android.database.Cursor;
import org.json.JSONArray;
import org.json.JSONObject;
import org.sqlite.database.sqlite.SQLiteDatabase;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InterruptedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Persists the exact changes awaiting a receipt beside the Direct database. */
final class FleetCloudCatchUp {
    private FleetCloudCatchUp() { }

    static void seed(File root,String epoch,String source,long initial,File archive) throws Exception {
        try (SQLiteDatabase index=open(root,epoch,true)) {
            index.beginTransaction();
            try {
                State saved=state(index);
                if (saved==null) {
                    try (BufferedReader rows=Files.newBufferedReader(archive.toPath(),StandardCharsets.UTF_8)) {
                        for (String line;(line=rows.readLine())!=null;) {
                            interrupted();
                            index.execSQL("INSERT INTO fleet_source_rows(key,sha256) VALUES(?,?)",
                                    new Object[]{key(new JSONObject(line)),digest(line)});
                        }
                    }
                    index.execSQL("INSERT INTO fleet_source_checkpoint(id,source,initial,cursor) VALUES(1,?,?,?)",
                            new Object[]{source,initial,initial});
                } else saved.require(source,initial);
                index.setTransactionSuccessful();
            } finally { index.endTransaction(); }
        }
    }

    static void capture(File root,SQLiteDatabase live,File objects,String epoch,String journalId,String source,String generation,long initial) throws Exception {
        try (SQLiteDatabase index=open(root,epoch,false)) {
            State saved=requireState(index,source,initial);
            if (saved.pending>0) return;
            live.beginTransactionNonExclusive();
            try {
                long through=FleetCloudSourceJournal.checkpoint(live,journalId,generation);
                if (through<saved.cursor) throw invalid();
                if (through>saved.cursor) {
                    File files=files(root,epoch);
                    prune(files);
                    saveDelta(index,live,objects,files,generation,through);
                }
                live.setTransactionSuccessful();
            } finally { live.endTransaction(); }
        }
    }

    private static void saveDelta(SQLiteDatabase index,SQLiteDatabase live,File objects,File files,String generation,long through) throws Exception {
        Set<String> present=new HashSet<>();
        index.beginTransaction();
        try {
            Set<String> references=FleetCloudArchive.project(live,generation,row->captureRow(index,present,row));
            try (Cursor rows=live.rawQuery("SELECT key,name,content_type,size,sha256,local_name FROM native_objects "+
                    "WHERE substr(key,1,18)='service-documents/' AND deleted_at IS NULL ORDER BY key",null)) {
                while (rows.moveToNext()) {
                    String key=rows.getString(0),type=rows.getString(2),sha=rows.getString(4),name=rows.getString(5);
                    long size=rows.getLong(3);
                    if (!BusinessObjects.validLocalName(name)||!sha.matches("[a-f0-9]{64}")||size<=0||
                            size>FleetCloudReplica.MAX_DOCUMENT_BYTES) throw invalid();
                    references.remove(key);
                    if (captureRow(index,present,FleetCloudArchive.document(key,rows.getString(1),type,size,sha))) {
                        saveFile(files,new File(objects,name),sha,size);
                        index.execSQL("INSERT OR IGNORE INTO fleet_source_files(sha256,type,size) VALUES(?,?,?)",new Object[]{sha,type,size});
                    }
                }
            }
            if (!references.isEmpty()) throw invalid();
            try (Cursor previous=index.rawQuery("SELECT key,sha256 FROM fleet_source_rows",null)) {
                while (previous.moveToNext()) {
                    interrupted();
                    String key=previous.getString(0);
                    if (!present.contains(key)) index.execSQL("INSERT INTO fleet_source_pending(key,before_sha) VALUES(?,?)",
                            new Object[]{key,previous.getString(1)});
                }
            }
            index.execSQL("UPDATE fleet_source_checkpoint SET pending=? WHERE id=1 AND pending IS NULL",new Object[]{through});
            index.setTransactionSuccessful();
        } finally { index.endTransaction(); }
    }

    private static boolean captureRow(SQLiteDatabase db,Set<String> present,JSONObject row) throws Exception {
        interrupted();
        String key=key(row);
        if (!present.add(key)) throw invalid();
        String body=row.toString(),hash=digest(body),before=null;
        try (Cursor previous=db.rawQuery("SELECT sha256 FROM fleet_source_rows WHERE key=?",new String[]{key})) {
            if (previous.moveToFirst()) before=previous.getString(0);
        }
        if (hash.equals(before)) return false;
        db.execSQL("INSERT INTO fleet_source_pending(key,before_sha,sha256,record) VALUES(?,?,?,?)",new Object[]{key,before,hash,body});
        return true;
    }

    static JSONObject send(File root,String epoch,String source,long initial,FleetCloudBaseline.Transport transport) throws Exception {
        try (SQLiteDatabase index=open(root,epoch,false)) {
            State saved=requireState(index,source,initial);
            if (saved.pending==0) return new JSONObject().put("cursor",saved.cursor).put("acknowledged",false);
            File directory=files(root,epoch),records=File.createTempFile("fleet-source-",".ndjson",directory);
            try {
                int changed=writeChanges(index,saved,records);
                List<FleetCloudBaseline.Document> documents=new ArrayList<>();
                try (Cursor rows=index.rawQuery("SELECT sha256,type,size FROM fleet_source_files ORDER BY sha256",null)) {
                    while (rows.moveToNext()) {
                        String sha=rows.getString(0);
                        long size=rows.getLong(2);
                        File file=new File(directory,sha);
                        if (!matches(file,sha,size)) throw invalid();
                        documents.add(new FleetCloudBaseline.Document(sha,rows.getString(1),size,()->new FileInputStream(file)));
                    }
                }
                FleetCloudBaseline.stageDelta(epoch,source,saved.cursor,saved.pending,records,documents,transport);
                acknowledge(index,saved);
                prune(directory);
                return new JSONObject().put("cursor",saved.pending).put("acknowledged",true).put("records",changed);
            } finally { Files.deleteIfExists(records.toPath()); }
        }
    }

    private static int writeChanges(SQLiteDatabase index,State saved,File records) throws Exception {
        int count=0;
        try (BufferedWriter output=Files.newBufferedWriter(records.toPath(),StandardCharsets.UTF_8);
             Cursor pending=index.rawQuery("SELECT key,before_sha,sha256,record FROM fleet_source_pending ORDER BY key",null)) {
            output.write(new JSONObject().put("kind","source-checkpoint").put("afterCursor",saved.cursor).put("sourceCursor",saved.pending).toString());
            output.write('\n');
            while (pending.moveToNext()) {
                interrupted();
                JSONObject change=new JSONObject().put("key",new JSONArray(pending.getString(0)))
                        .put("beforeSha256",pending.isNull(1)?JSONObject.NULL:pending.getString(1))
                        .put("sha256",pending.isNull(2)?JSONObject.NULL:pending.getString(2))
                        .put("record",pending.isNull(3)?JSONObject.NULL:pending.getString(3));
                output.write(change.toString());
                output.write('\n');
                count++;
            }
        }
        return count;
    }

    private static void acknowledge(SQLiteDatabase db,State sent) throws Exception {
        db.beginTransaction();
        try {
            State current=requireState(db,sent.source,sent.initial);
            if (current.cursor!=sent.cursor||current.pending!=sent.pending) throw invalid();
            db.execSQL("DELETE FROM fleet_source_rows WHERE key IN (SELECT key FROM fleet_source_pending WHERE sha256 IS NULL)");
            db.execSQL("INSERT INTO fleet_source_rows(key,sha256) SELECT key,sha256 FROM fleet_source_pending WHERE sha256 IS NOT NULL "+
                    "ON CONFLICT(key) DO UPDATE SET sha256=excluded.sha256");
            db.execSQL("DELETE FROM fleet_source_pending");
            db.execSQL("DELETE FROM fleet_source_files");
            db.execSQL("UPDATE fleet_source_checkpoint SET cursor=pending,pending=NULL WHERE id=1");
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }

    private static void saveFile(File directory,File source,String sha,long size) throws Exception {
        if (!source.isFile()||Files.isSymbolicLink(source.toPath())||source.length()!=size) throw invalid();
        File saved=new File(directory,sha);
        if (matches(saved,sha,size)) return;
        File temp=File.createTempFile("fleet-source-",".part",directory);
        try {
            try (FileInputStream input=new FileInputStream(source); FileOutputStream output=new FileOutputStream(temp)) {
                byte[] block=new byte[8192];
                long copied=0;
                for (int n;(n=input.read(block))!=-1;) {
                    interrupted();
                    copied+=n;
                    if (copied>size) throw invalid();
                    output.write(block,0,n);
                }
                output.getFD().sync();
            }
            if (!matches(temp,sha,size)) throw invalid();
            Files.move(temp.toPath(),saved.toPath(),StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);
            NativeColdRuntime.sync(directory);
        } finally { Files.deleteIfExists(temp.toPath()); }
    }

    private static boolean matches(File file,String sha,long size) throws Exception {
        return sha.matches("[a-f0-9]{64}")&&file.isFile()&&!Files.isSymbolicLink(file.toPath())&&
                file.length()==size&&sha.equals(NativeDatabaseSnapshot.digest(file));
    }

    private static File files(File root,String epoch) throws IOException {
        File directory=new File(root,"fleet-source-files-"+epoch);
        if (Files.isSymbolicLink(directory.toPath())||(!directory.isDirectory()&&!directory.mkdir()&&!directory.isDirectory())) throw invalid();
        return directory;
    }

    private static void prune(File directory) throws IOException {
        File[] entries=directory.listFiles();
        if (entries==null) throw invalid();
        for (File file:entries) {
            if (file.getName().matches("[0-9a-f]{64}|fleet-source-.+\\.(?:part|ndjson)")) Files.deleteIfExists(file.toPath());
        }
    }

    private static SQLiteDatabase open(File root,String epoch,boolean create) throws IOException {
        if (!epoch.matches("[a-f0-9]{32}")) throw invalid();
        File path=new File(root,"fleet-source-"+epoch+".sqlite");
        if (Files.isSymbolicLink(path.toPath())||(!create&&!path.isFile())) throw invalid();
        SQLiteDatabase db=SQLiteDatabase.openDatabase(path.getPath(),null,create?SQLiteDatabase.CREATE_IF_NECESSARY:SQLiteDatabase.OPEN_READWRITE);
        if (!create) return db;
        try {
            db.execSQL("CREATE TABLE IF NOT EXISTS fleet_source_checkpoint(id INTEGER PRIMARY KEY CHECK(id=1),source TEXT NOT NULL,"+
                    "initial INTEGER NOT NULL,cursor INTEGER NOT NULL,pending INTEGER)");
            db.execSQL("CREATE TABLE IF NOT EXISTS fleet_source_rows(key TEXT PRIMARY KEY,sha256 TEXT NOT NULL)");
            db.execSQL("CREATE TABLE IF NOT EXISTS fleet_source_pending(key TEXT PRIMARY KEY,before_sha TEXT,sha256 TEXT,record TEXT)");
            db.execSQL("CREATE TABLE IF NOT EXISTS fleet_source_files(sha256 TEXT PRIMARY KEY,type TEXT NOT NULL,size INTEGER NOT NULL)");
            return db;
        } catch (RuntimeException error) { db.close(); throw error; }
    }

    private static String key(JSONObject row) throws Exception {
        return new JSONArray().put(row.getString("kind")).put(row.optString("machineId")).put(row.optString("recordId")).toString();
    }

    private static State state(SQLiteDatabase db) {
        try (Cursor value=db.rawQuery("SELECT source,initial,cursor,pending FROM fleet_source_checkpoint WHERE id=1",null)) {
            return value.moveToFirst()?new State(value.getString(0),value.getLong(1),value.getLong(2),value.getLong(3)):null;
        }
    }

    private static State requireState(SQLiteDatabase db,String source,long initial) throws IOException {
        State value=state(db);
        if (value==null) throw invalid();
        value.require(source,initial);
        return value;
    }

    private static final class State {
        final String source;
        final long initial,cursor,pending;

        State(String source,long initial,long cursor,long pending) {
            this.source=source;
            this.initial=initial;
            this.cursor=cursor;
            this.pending=pending;
        }

        void require(String expected,long checkpoint) throws IOException {
            if (!source.equals(expected)||!source.matches("[a-f0-9]{64}")||initial!=checkpoint||initial<0||cursor<initial||
                    (pending!=0&&pending<=cursor)) throw invalid();
        }
    }

    private static String digest(String value) throws Exception {
        return FleetCloudBaseline.digest(value.getBytes(StandardCharsets.UTF_8));
    }

    private static void interrupted() throws InterruptedIOException {
        if (Thread.currentThread().isInterrupted()) throw new InterruptedIOException();
    }

    private static IOException invalid() {
        return new IOException("Δεν επαληθεύτηκαν οι αλλαγές Fleet μετά το αρχικό αντίγραφο.");
    }
}

package gr.argyrismitsos.fleetdirect;

import android.content.Context;
import android.database.Cursor;
import org.sqlite.database.sqlite.SQLiteDatabase;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/** Holds the remote journal in a separate private SQLite replica before cutover. */
final class FleetCloudReplica {
    private static final long MAX_CURSOR=9007199254740991L;
    private static final Set<String> KINDS=new HashSet<>(Arrays.asList("machine","service","mileage","invoice"));
    private FleetCloudReplica() { }

    interface Pull { JSONObject page(long cursor) throws Exception; }

    static JSONObject sync(Context context,String epoch,Pull pull) throws Exception {
        if (!ScopedContext.owns(context)) throw invalidDelta();
        File location=new File(context.getNoBackupFilesDir(),"fleet-cloud-replica.sqlite");
        try (SQLiteDatabase database=SQLiteDatabase.openDatabase(location.getPath(),null,SQLiteDatabase.CREATE_IF_NECESSARY)) {
            initialize(database,epoch);
            long cursor=readCursor(database,epoch);
            boolean more=false;
            for (int count=0;count<6;count++) {
                JSONObject page=pull.page(cursor);
                cursor=apply(database,epoch,cursor,page);
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

    static long apply(SQLiteDatabase db,String epoch,long previous,JSONObject page) throws Exception {
        if (!epoch.equals(page.getString("epoch"))) throw invalidDelta();
        JSONArray changes=page.getJSONArray("changes");
        long next=integer(page,"nextCursor");
        boolean more=bool(page,"hasMore");
        if (changes.length()>24 || next<previous || (next==previous&&(more||changes.length()!=0))) throw invalidDelta();
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
        if (!value.matches("[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}")) throw invalidDelta();
        return value;
    }

    private static IOException invalidDelta() {
        return new IOException("Η δοκιμαστική SQLite δεν επιβεβαίωσε τη σειρά ή την έκδοση των αλλαγών Fleet.");
    }
}

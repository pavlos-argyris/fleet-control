package gr.argyrismitsos.fleetdirect;

import android.database.Cursor;
import org.json.JSONObject;
import org.sqlite.database.sqlite.SQLiteDatabase;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.stream.Collectors;

/** Tracks changes in the same SQLite transactions as the Direct Fleet data. */
final class FleetCloudSourceJournal {
    private static final String STATE="fleet_cloud_source_state";
    private static final String CHANGES="fleet_cloud_source_changes";
    private static final long MAX_CURSOR=9007199254740991L;

    private FleetCloudSourceJournal() { }

    static void arm(SQLiteDatabase db,String epoch,String generation) throws Exception {
        String lineage=lineage(epoch,generation);
        db.beginTransaction();
        try {
            db.execSQL("CREATE TABLE IF NOT EXISTS "+STATE+"(id INTEGER PRIMARY KEY CHECK(id=1),lineage TEXT NOT NULL)");
            db.execSQL("CREATE TABLE IF NOT EXISTS "+CHANGES+"(seq INTEGER PRIMARY KEY AUTOINCREMENT,lineage TEXT NOT NULL,"+
                    "scope TEXT NOT NULL,record_id TEXT NOT NULL,UNIQUE(lineage,scope,record_id))");
            db.execSQL("CREATE INDEX IF NOT EXISTS fleet_cloud_source_range ON "+CHANGES+"(lineage,seq)");
            watch(db,"fleet_snapshot","id","snapshot","@.id=1","version,data,updated_at");
            watch(db,"vehicle_registry","bike_id","machine-registry","1","name,odometer,status,version,updated_at");
            watch(db,"vehicle_archives","bike_id","machine-archive","1",
                    "name,odometer,original_status,snapshot_json,archived_at,reason,active,restored_at,restore_reason");
            watch(db,"deleted_records","id","history-trash","@.record_type='fleet_history'",
                    "record_type,record_id,payload,label,reason,deleted_at,restored_at,restore_reason");
            watch(db,"fleet_operations","id","invoice-job","@.type IN ('service_document_render','service_document_reprocess_batch') "+
                    "AND @.status IN ('pending','error')","type,payload,status,created_at");
            watch(db,"invoice_import_drafts","id","invoice-draft","@.status IN ('processing','ready','committing','error')",
                    "data,status,created_at,updated_at");
            watch(db,"native_objects","key","document","substr(@.key,1,18)='service-documents/' AND @.deleted_at IS NULL",
                    "local_name,name,content_type,size,sha256,updated_at,deleted_at");
            db.execSQL("INSERT INTO "+STATE+"(id,lineage) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET "+
                    "lineage=excluded.lineage WHERE lineage<>excluded.lineage",new Object[]{lineage});
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }

    private static void watch(SQLiteDatabase db,String table,String id,String scope,String eligible,String fields) {
        String previous=eligible.replace("@","OLD"), current=eligible.replace("@","NEW");
        String renamed="OLD."+id+" IS NOT NEW."+id;
        String changed=Arrays.stream(fields.split(","))
                .map(field->"OLD."+field+" IS NOT NEW."+field).collect(Collectors.joining(" OR "));
        String watch="CREATE TRIGGER IF NOT EXISTS fleet_cloud_source_"+table+"_";
        db.execSQL(watch+"insert AFTER INSERT ON "+table+" BEGIN "+mark("NEW",id,scope,current)+" END");
        db.execSQL(watch+"delete AFTER DELETE ON "+table+" BEGIN "+mark("OLD",id,scope,previous)+" END");
        db.execSQL(watch+"update AFTER UPDATE ON "+table+" WHEN "+renamed+" OR "+changed+" BEGIN "+
                mark("OLD",id,scope,"("+previous+") AND ("+renamed+" OR NOT ("+current+"))")+
                mark("NEW",id,scope,current)+" END");
    }

    private static String mark(String alias,String id,String scope,String eligible) {
        return "INSERT INTO "+CHANGES+"(lineage,scope,record_id) "+
                "SELECT lineage,'"+scope+"',CAST("+alias+"."+id+" AS TEXT) FROM "+STATE+" WHERE id=1 AND ("+eligible+") "+
                "ON CONFLICT(lineage,scope,record_id) DO UPDATE SET seq=excluded.seq;";
    }

    static long checkpoint(SQLiteDatabase db,String epoch,String generation) throws Exception {
        JSONObject proof=progress(db,epoch,generation,0);
        return proof.optLong("cursor",-1);
    }

    static JSONObject progress(SQLiteDatabase db,String epoch,String generation,long after) throws Exception {
        String expected=lineage(epoch,generation);
        if (after<0||after>MAX_CURSOR) throw invalid();
        Cursor tables=db.rawQuery("SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN (?,?)",
                new String[]{STATE,CHANGES});
        try {
            if (!tables.moveToFirst()||tables.getInt(0)!=2) return new JSONObject().put("verified",false);
        } finally { tables.close(); }
        Cursor row=db.rawQuery("SELECT COALESCE((SELECT max(seq) FROM "+CHANGES+" WHERE lineage=s.lineage),0),"+
                "(SELECT count(*) FROM "+CHANGES+" WHERE lineage=s.lineage AND seq>?) FROM "+STATE+" s WHERE id=1 AND lineage=?",
                new String[]{Long.toString(after),expected});
        try {
            if (!row.moveToFirst()||!validCursor(row.getLong(0),after)) return new JSONObject().put("verified",false);
            return new JSONObject().put("verified",true).put("cursor",row.getLong(0)).put("pending",row.getLong(1));
        } finally { row.close(); }
    }

    private static boolean validCursor(long cursor,long after) { return cursor>=after&&cursor<=MAX_CURSOR; }

    private static String lineage(String epoch,String generation) throws Exception {
        if (!epoch.matches("[a-f0-9]{32}")||!generation.matches("[a-f0-9-]{36}")) throw invalid();
        return BusinessRuntime.sha256((epoch+":"+generation).getBytes(StandardCharsets.UTF_8));
    }

    private static IOException invalid() { return new IOException("Δεν επαληθεύτηκε το σημείο καταγραφής αλλαγών Fleet."); }
}

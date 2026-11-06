package gr.argyrismitsos.fleetserver;
import android.database.sqlite.SQLiteDatabase;import org.json.*;

/** Durable state never grants authority without the matching live coordinator lease. */
public final class NativePrimaryState {
    private NativePrimaryState(){}
    public static JSONObject read(SQLiteDatabase db)throws Exception{
        BusinessSqlite sql=new BusinessSqlite(db);JSONArray exists=sql.call("sql.query",new JSONObject().put("sql","SELECT name FROM sqlite_master WHERE type='table' AND name='native_primary_state'")).getJSONArray("results");if(exists.length()==0)return new JSONObject().put("phase","cloud");
        JSONArray rows=sql.call("sql.query",new JSONObject().put("sql","SELECT * FROM native_primary_state WHERE id=1")).getJSONArray("results");return rows.length()==0?new JSONObject().put("phase","cloud"):rows.getJSONObject(0);
    }
    public static boolean hasImportedData(SQLiteDatabase db)throws Exception{return java.util.Arrays.asList("prepared","active","needs_recovery","recovering").contains(read(db).getString("phase"));}
    public static void phase(SQLiteDatabase db,String phase,String realm,String generation,String ownerId,String dataHash)throws Exception{
        if(!java.util.Arrays.asList("cloud","preparing","importing","prepared","active","needs_recovery","recovering","aborting").contains(phase))throw new IllegalArgumentException("Unknown primary phase");
        db.execSQL(NativePrimarySchema.STATE);
        db.execSQL("INSERT INTO native_primary_state(id,phase,realm,generation,owner_id,data_hash,imported_at) VALUES(1,?,?,?,?,?,datetime('now')) ON CONFLICT(id) DO UPDATE SET phase=excluded.phase,realm=excluded.realm,generation=excluded.generation,owner_id=excluded.owner_id,data_hash=excluded.data_hash,imported_at=excluded.imported_at,proof_sha=''",new Object[]{phase,realm,generation,ownerId,dataHash});
    }
}

package gr.argyrismitsos.fleetserver;

import android.content.Context;
import android.database.Cursor;
import org.sqlite.database.sqlite.SQLiteDatabase;
import java.io.IOException;

/** One provider for import, integrity, runtime and backup, regardless of OEM SQLite. */
public final class IndependentSqlite {
    private static boolean ready;
    private static String version="";
    private IndependentSqlite(){}
    public static synchronized void initialize(Context context)throws IOException {
        if(ready)return;
        try{
            System.loadLibrary("sqliteX");
            try(SQLiteDatabase db=SQLiteDatabase.create(null)){
                version=text(db,"SELECT sqlite_version()");
                if(!version.equals("3.54.1"))throw new IOException("Unexpected bundled SQLite version");
                if(!text(db,"SELECT json_extract(json_set('{\"probe\":0}','$.probe',1),'$.probe')").equals("1"))throw new IOException("Missing JSON support");
                if(!text(db,"SELECT sum(value) FROM json_each('[2,3]')").equals("5"))throw new IOException("Missing JSON table support");
                db.execSQL("CREATE TABLE sqlite_probe(value TEXT)");
                db.execSQL("CREATE INDEX sqlite_probe_json ON sqlite_probe(json_extract(value,'$.probe'))");
                db.beginTransaction();
                try{
                    db.execSQL("INSERT INTO sqlite_probe VALUES('{\"probe\":1}')");
                    db.execSQL("SAVEPOINT sqlite_probe_savepoint");
                    db.execSQL("INSERT INTO sqlite_probe VALUES('{\"probe\":2}')");
                    db.execSQL(statement("ROLLBACK TO SAVEPOINT sqlite_probe_savepoint"));
                    db.execSQL("RELEASE SAVEPOINT sqlite_probe_savepoint");
                    if(!db.inTransaction()||!text(db,"SELECT count(*) FROM sqlite_probe").equals("1"))throw new IOException("Savepoint rollback failed");
                }finally{db.endTransaction();}
                if(!text(db,"SELECT count(*) FROM sqlite_probe").equals("0")||!text(db,"PRAGMA integrity_check").equals("ok"))throw new IOException("Integrity/rollback failed");
            }
            ready=true;
            context.getSharedPreferences("independent_ui",Context.MODE_PRIVATE).edit().putString("sqlite","SQLite "+version+" · JSON / ακεραιότητα / αναίρεση OK").commit();
        }catch(LinkageError error){throw unavailable(error);}catch(Exception error){throw unavailable(error);}
    }
    private static IOException unavailable(Throwable cause){return new IOException("Η ενσωματωμένη SQLite δεν πέρασε τον έλεγχο συμβατότητας. Η εισαγωγή σταμάτησε πριν ανοίξει η βάση· τα αρχικά αρχεία διατηρούνται.",cause);}
    public static synchronized void requireReady()throws IOException {if(!ready)throw unavailable(null);}
    public static String text(SQLiteDatabase db,String sql){try(Cursor c=db.rawQuery(sql,null)){if(!c.moveToFirst())throw new IllegalStateException("Missing SQLite probe result");return c.getString(0);}}
    /** Official Android bindings classify every ROL prefix as full ROLLBACK.
     * A SQL comment leaves SQLite savepoint semantics unchanged while bypassing
     * only that Java classifier. Full ROLLBACK is deliberately left untouched. */
    public static String statement(String sql){return sql.matches("(?is)^\\s*ROLLBACK\\s+TO\\b.*")?"/* fleet savepoint */ "+sql:sql;}
}

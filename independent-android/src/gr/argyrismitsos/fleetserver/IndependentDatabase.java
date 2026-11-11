package gr.argyrismitsos.fleetserver;
import android.database.sqlite.SQLiteDatabase;import android.database.sqlite.SQLiteStatement;import java.io.IOException;

/** Settings run before requests; PRAGMAs that return rows use Android's scalar-query API. */
public final class IndependentDatabase {
 private IndependentDatabase(){}
 static void configure(SQLiteDatabase db)throws Exception{
  try(SQLiteStatement timeout=db.compileStatement("PRAGMA busy_timeout=5000")){if(timeout.simpleQueryForLong()!=5000)throw new IOException("Δεν εφαρμόστηκε ο χρόνος αναμονής SQLite.");}
  db.execSQL("PRAGMA synchronous=FULL");
  db.execSQL("CREATE TABLE IF NOT EXISTS independent_instance(id INTEGER PRIMARY KEY CHECK(id=1),instance_id TEXT NOT NULL,mode TEXT NOT NULL,activated_at INTEGER,activated_by TEXT)");
  db.execSQL("CREATE TABLE IF NOT EXISTS independent_readiness(id INTEGER PRIMARY KEY CHECK(id=1),proof TEXT,actor_id TEXT,session_hash TEXT,peer_hash TEXT,created_at INTEGER)");
 }
}

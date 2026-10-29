import fs from 'node:fs';
import path from 'node:path';
/** The same Python/SQLite bridge used by the existing CursorWindow regression. */
export function storeSqliteFixture(dir){
 const source=fs.readFileSync('scripts/test-server-large-storage-native.mjs','utf8'),files={};
 for(const name of ['sqlite_rpc.py','Cursor.java','SQLiteStatement.java','SQLiteDatabase.java']){
  const match=source.match(new RegExp("write\\('"+name.replaceAll('.','\\.')+"',String.raw`([\\s\\S]*?)`\\);"));if(!match)throw Error('Missing verified SQLite fixture '+name);files[name]=match[1];
 }
 files['ContentValues.java']='package android.content;import java.util.*;public class ContentValues{public final Map<String,Object> values=new LinkedHashMap<String,Object>();public void put(String k,String v){values.put(k,v);}public void put(String k,Integer v){values.put(k,v);}}';
 files['Context.java']='package android.content;public class Context{}';
 files['SQLiteException.java']='package android.database.sqlite;public class SQLiteException extends RuntimeException{public SQLiteException(String s){super(s);}}';
 files['SQLiteDoneException.java']='package android.database.sqlite;public class SQLiteDoneException extends SQLiteException{public SQLiteDoneException(){super("No rows");}}';
 files['FleetDataStore.java']='package gr.argyrismitsos.fleetserver;public class FleetDataStore{private final android.database.sqlite.SQLiteDatabase db=new android.database.sqlite.SQLiteDatabase();public android.database.sqlite.SQLiteDatabase getWritableDatabase(){return db;}public void close(){db.close();}}';
 for(const [name,body]of Object.entries(files))fs.writeFileSync(path.join(dir,name),body);
 return Object.keys(files).filter(n=>n.endsWith('.java')).map(n=>path.join(dir,n));
}

import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import {execFileSync} from 'node:child_process';
const root=process.cwd(),temp=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-large-storage-'));
const version=JSON.parse(fs.readFileSync('release-config.json','utf8')).server.version;assert.match(fs.readFileSync('server-android/src/gr/argyrismitsos/fleetserver/ServerConfig.java','utf8'),new RegExp('SERVER_VERSION = "'+version.replaceAll('.','\\.')+'"'));
const jar=path.join(root,'vendor/json-java/json-20240303.jar');
assert.equal(crypto.createHash('sha256').update(fs.readFileSync(jar)).digest('hex'),'3cf6cd6892e32e2b4c1c39e0f52f5248a2f5b37646fdfbb79a66b46b618414ed');
const write=(name,source)=>fs.writeFileSync(path.join(temp,name),source);
try{
write('sqlite_rpc.py',String.raw`import sqlite3,json,sys
c=sqlite3.connect(sys.argv[1],isolation_level=None)
for line in sys.stdin:
 try:
  q=json.loads(line);r=c.execute(q['sql'],q.get('args',[]));print(json.dumps({'rows':r.fetchall()},ensure_ascii=False),flush=True)
 except Exception as e:print(json.dumps({'error':str(e)}),flush=True)
`);
write('Context.java','package android.content;public class Context{}');
write('ContentValues.java','package android.content;import java.util.*;public class ContentValues{public final Map<String,Object> values=new LinkedHashMap<String,Object>();public void put(String k,String v){values.put(k,v);}}');
write('Cursor.java',String.raw`package android.database;import org.json.*;public final class Cursor{
 private final JSONArray rows;private int at=-1;public static int largeRows,opened;public Cursor(JSONArray r){rows=r;opened++;}
 private boolean move(int n){at=n;if(at>=rows.length())return false;JSONArray row=rows.getJSONArray(at);long bytes=0;for(int i=0;i<row.length();i++)bytes+=String.valueOf(row.get(i)).getBytes(java.nio.charset.StandardCharsets.UTF_8).length;if(bytes>2*1024*1024){largeRows++;throw new android.database.sqlite.SQLiteException("Row too big to fit into CursorWindow requiredPos="+n+", totalRows="+rows.length());}return true;}
 public boolean moveToFirst(){return move(0);}public boolean moveToNext(){return move(at+1);}public String getString(int i){return String.valueOf(rows.getJSONArray(at).get(i));}public void close(){opened--;}
}`);
write('SQLiteException.java','package android.database.sqlite;public class SQLiteException extends RuntimeException{public SQLiteException(String m){super(m);}}');
write('SQLiteDoneException.java','package android.database.sqlite;public class SQLiteDoneException extends SQLiteException{public SQLiteDoneException(){super("No rows");}}');
write('SQLiteStatement.java',String.raw`package android.database.sqlite;import org.json.*;public final class SQLiteStatement{
 private final SQLiteDatabase db;private final String sql;private final JSONArray args=new JSONArray();public static int opened;public SQLiteStatement(SQLiteDatabase d,String s){db=d;sql=s;opened++;}public void bindString(int i,String s){args.put(i-1,s);}public String simpleQueryForString(){JSONArray r=db.query(sql,args);if(r.length()==0)throw new SQLiteDoneException();Object v=r.getJSONArray(0).get(0);return v==JSONObject.NULL?null:String.valueOf(v);}public void close(){opened--;}
}`);
write('SQLiteDatabase.java',String.raw`package android.database.sqlite;import org.json.*;import android.content.*;import android.database.*;import java.io.*;import java.nio.charset.StandardCharsets;
public final class SQLiteDatabase{
 public static final int CONFLICT_REPLACE=5,CONFLICT_IGNORE=4;public static SQLiteDatabase current;private final Process process;private final BufferedReader input;private final BufferedWriter output;public String injectedSql="";
 public SQLiteDatabase(){try{process=new ProcessBuilder("python3","-u",System.getProperty("fixture.rpc"),System.getProperty("fixture.db")).redirectError(ProcessBuilder.Redirect.INHERIT).start();input=new BufferedReader(new InputStreamReader(process.getInputStream(),StandardCharsets.UTF_8));output=new BufferedWriter(new OutputStreamWriter(process.getOutputStream(),StandardCharsets.UTF_8));current=this;}catch(Exception e){throw new RuntimeException(e);}}
 public synchronized JSONArray query(String sql,JSONArray args){if(!injectedSql.isEmpty()&&sql.contains(injectedSql))throw new SQLiteException("injected read failure");try{output.write(new JSONObject().put("sql",sql).put("args",args).toString());output.newLine();output.flush();JSONObject reply=new JSONObject(input.readLine());if(reply.has("error"))throw new SQLiteException(reply.getString("error"));return reply.getJSONArray("rows");}catch(IOException e){throw new RuntimeException(e);}}
 private JSONArray params(String[] a){JSONArray r=new JSONArray();if(a!=null)for(String s:a)r.put(s);return r;}
 public Cursor rawQuery(String sql,String[] a){return new Cursor(query(sql,params(a)));}public SQLiteStatement compileStatement(String s){return new SQLiteStatement(this,s);}public void execSQL(String s){query(s,new JSONArray());}
 public void beginTransaction(){execSQL("BEGIN");}public void setTransactionSuccessful(){execSQL("COMMIT");}public void endTransaction(){try{execSQL("ROLLBACK");}catch(SQLiteException e){if(!e.getMessage().contains("no transaction"))throw e;}}
 public long insertWithOnConflict(String table,String ignored,ContentValues v,int conflict){StringBuilder cols=new StringBuilder(),marks=new StringBuilder();JSONArray a=new JSONArray();for(String k:v.values.keySet()){if(cols.length()>0){cols.append(',');marks.append(',');}cols.append(k);marks.append('?');a.put(v.values.get(k));}query("INSERT OR "+(conflict==CONFLICT_IGNORE?"IGNORE":"REPLACE")+" INTO "+table+" ("+cols+") VALUES ("+marks+")",a);return 1;}
 public int delete(String t,String where,String[] a){query("DELETE FROM "+t+(where==null?"":" WHERE "+where),params(a));return 1;}public void close(){try{output.close();input.close();process.waitFor();}catch(Exception e){throw new RuntimeException(e);}}
}`);
write('SQLiteOpenHelper.java','package android.database.sqlite;import android.content.Context;public abstract class SQLiteOpenHelper{private SQLiteDatabase db;public SQLiteOpenHelper(Context c,String n,Object f,int v){}public SQLiteDatabase getReadableDatabase(){return getWritableDatabase();}public SQLiteDatabase getWritableDatabase(){if(db==null){db=new SQLiteDatabase();onCreate(db);}return db;}public abstract void onCreate(SQLiteDatabase db);public abstract void onUpgrade(SQLiteDatabase db,int a,int b);public void close(){if(db!=null)db.close();}}');
write('LargeStorageTest.java',String.raw`import android.content.*;import android.database.*;import android.database.sqlite.*;import gr.argyrismitsos.fleetserver.*;import org.json.*;import java.nio.charset.StandardCharsets;
public class LargeStorageTest{
 static void check(boolean v,String m){if(!v)throw new AssertionError(m);}static String text;static void same(JSONObject o){check(text.equals(o.getString("payload")),"Large Unicode JSON must round-trip exactly");}
 public static void main(String[] args)throws Exception{
 FleetDataStore s=new FleetDataStore(new Context());try{
 check(s.getFleet().getJSONArray("bikes").length()==0,"new database");check(s.getSystemExport().length()==0&&s.getCanonicalSnapshot().length()==0&&s.getLocalWorkState().length()==0,"missing optional rows");check(s.getSetting("missing","fallback").equals("fallback"),"missing settings");
 StringBuilder b=new StringBuilder();for(int i=0;i<150000;i++)b.append("Ελληνικά 🛵 café \\\"\\n");text=b.toString();check(text.getBytes(StandardCharsets.UTF_8).length>4*1024*1024,"fixture exceeds common CursorWindow sizes");
 JSONObject large=new JSONObject().put("payload",text);JSONObject full=new JSONObject(large.toString()).put("workforce",new JSONObject().put("app_users",new JSONArray().put(new JSONObject().put("id","u"))).put("shifts",new JSONArray().put(new JSONObject().put("status","active"))));
 s.setSystemExport(full);s.setCanonicalSnapshot(large);s.setLocalWorkState(large);s.setSetting("large-setting",text);s.setSetting("quote'key","Ελληνικά");
 for(int i=0;i<3;i++)s.replaceBike(new JSONObject().put("id","bike-"+i).put("updatedAt","2026-10-28T10:00:00Z").put("history",new JSONArray().put(new JSONObject().put("id","service").put("type","service").put("notes",i==1?text:"small").put("km",1000))));
 same(s.getSystemExport());same(s.getCanonicalSnapshot());same(s.getLocalWorkState());check(s.getSetting("large-setting","").equals(text),"large setting");check(s.getSetting("quote'key","").equals("Ελληνικά"),"bound key");
 JSONObject fleet=s.getFleet(),stats=s.getStats();check(fleet.getJSONArray("bikes").length()==3&&fleet.getJSONArray("bikes").getJSONObject(1).getJSONArray("history").getJSONObject(0).getString("notes").equals(text),"all bikes/history retained");check(stats.getInt("bikes")==3&&stats.getInt("historyEntries")==3&&stats.getInt("users")==1&&stats.getInt("activeShifts")==1,"dashboard statistics");
 JSONObject backup=s.fullBackupPayload();same(backup);check(backup.getJSONObject("fleet").getJSONArray("bikes").length()==3,"backup contains all records");
 s.mergeFleet(new JSONObject().put("bikes",new JSONArray().put(new JSONObject(fleet.getJSONArray("bikes").getJSONObject(1).toString()).put("updatedAt","2026-10-28T11:00:00Z"))));check(s.getFleet().getJSONArray("bikes").getJSONObject(1).getJSONArray("history").getJSONObject(0).getString("notes").equals(text),"readBike/merge preserves large existing row");
 for(String kind:new String[]{"full_export","canonical_snapshot","local_invoice_queue"}){SQLiteDatabase.current.injectedSql=kind;boolean failed=false;try{if(kind.equals("full_export"))s.getSystemExport();else if(kind.equals("canonical_snapshot"))s.getCanonicalSnapshot();else s.getLocalWorkState();}catch(RuntimeException e){failed=true;}finally{SQLiteDatabase.current.injectedSql="";}check(failed,"SQL failure must not become an empty "+kind);}
 same(s.getSystemExport());same(s.getCanonicalSnapshot());same(s.getLocalWorkState());
 for(String kind:new String[]{"full_export","canonical_snapshot","local_invoice_queue"}){SQLiteDatabase.current.execSQL("UPDATE system_state SET value='{' WHERE key='"+kind+"'");boolean invalid=false;try{if(kind.equals("full_export"))s.getSystemExport();else if(kind.equals("canonical_snapshot"))s.getCanonicalSnapshot();else s.getLocalWorkState();}catch(RuntimeException e){invalid=true;}check(invalid,"Invalid JSON must not become empty "+kind);check(SQLiteDatabase.current.query("SELECT value FROM system_state WHERE key=?",new JSONArray().put(kind)).getJSONArray(0).getString(0).equals("{"),"Invalid persisted value not erased");}s.setSystemExport(full);s.setCanonicalSnapshot(large);s.setLocalWorkState(large);
 check(Cursor.largeRows==0,"No large JSON value may pass through CursorWindow");check(Cursor.opened==0&&SQLiteStatement.opened==0,"all read handles closed, including missing/error paths");
 System.out.println("PASS actual FleetDataStore with real SQLite and JSON-java: >4 MB Unicode cells, mirror/canonical/queue/settings/bikes, complete dashboard/backup/merge, missing rows, bound keys, surfaced SQL failures, no mutation on failed read and no large CursorWindow rows. CursorWindow is simulated; physical Android remains untested.");
 }finally{s.close();}}
}`);
const sources=['Context','ContentValues','Cursor','SQLiteException','SQLiteDoneException','SQLiteStatement','SQLiteDatabase','SQLiteOpenHelper','LargeStorageTest'].map(n=>path.join(temp,n+'.java'));
execFileSync('java',['-jar',path.join(root,'.android-toolchain/usr/share/java/eclipse-jdt-core-3.32.0.jar'),'-proc:none','-source','8','-target','8','-nowarn','-encoding','UTF-8','-classpath',jar,'-d',temp,...sources,...['FleetDataStore','HistoryMergePolicy','NextServiceNotes'].map(n=>path.join(root,'server-android/src/gr/argyrismitsos/fleetserver',n+'.java'))],{stdio:'inherit'});
execFileSync('java',['-Xmx384m','-Dfixture.rpc='+path.join(temp,'sqlite_rpc.py'),'-Dfixture.db='+path.join(temp,'fixture.db'),'-cp',temp+path.delimiter+jar,'LargeStorageTest'],{stdio:'inherit',timeout:120000});
}finally{fs.rmSync(temp,{recursive:true,force:true});}

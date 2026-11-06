import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {storeSqliteFixture} from './fixtures/native-store-sqlite.mjs';

const root=process.cwd(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-frozen-import-v3-'));
try {
  const fixtures=storeSqliteFixture(dir);
  // The shared Python SQLite fixture predates BLOB bind support: JSON-java
  // represents byte[] as a JSON array. Decode only bind parameters to bytes;
  // production Android SQLite already binds byte[] natively.
  const rpc=path.join(dir,'sqlite_rpc.py'),python=fs.readFileSync(rpc,'utf8');
  const marker="q.get('args',[])";
  assert(python.includes(marker),'Expected isolated SQLite RPC fixture contract');
  fs.writeFileSync(rpc,python.replace(marker,
   "[sqlite3.Binary(bytes((int(x)&255) for x in v)) if isinstance(v,list) else (float(v['__fleet_sqlite_real__']) if isinstance(v,dict) and set(v)=={'__fleet_sqlite_real__'} else v) for v in q.get('args',[])]"));
  // The legacy Java JSON bridge serializes Double(1.0) as JSON integer 1.
  // Preserve the real Android execSQL binding type in this test fixture.
  const sqliteJava=path.join(dir,'SQLiteDatabase.java'),java=fs.readFileSync(sqliteJava,'utf8');
  const javaBind='public void execSQL(String s,Object[] a){query(s,new JSONArray(a));}';
  assert(java.includes(javaBind),'Expected isolated SQLiteDatabase bind contract');
  fs.writeFileSync(sqliteJava,java.replace(javaBind,
   'public void execSQL(String s,Object[] a){JSONArray values=new JSONArray();for(Object v:a){if(v instanceof Double)values.put(new JSONObject().put("__fleet_sqlite_real__",Double.toString((Double)v)));else values.put(v);}query(s,values);}'));

  fs.writeFileSync(path.join(dir,'FrozenImportTest.java'),String.raw`package gr.argyrismitsos.fleetserver;
import android.database.*;import android.database.sqlite.*;import org.json.*;
import java.io.*;import java.util.*;
public class FrozenImportTest {
 static SQLiteDatabase db;
 static void ok(boolean b,String message){if(!b)throw new AssertionError(message);}
 static String sql(String q){Cursor c=db.rawQuery(q,null);try{return c.moveToFirst()?c.getString(0):"";}finally{c.close();}}
 static JSONObject inventory()throws Exception {
  JSONArray columns=new JSONArray();
  for(String name:new String[]{"id","amount","real_value","payload","note"})
   columns.put(new JSONObject().put("name",name).put("notnull",name.equals("note")?0:1).put("pk",0));
  return new JSONObject().put("schemaVersion",3).put("generation","frozen-generation-1")
   .put("tables",new JSONArray().put(new JSONObject().put("name","cash_fixture")
    .put("rows",2).put("lastRow",3).put("columns",columns)));
 }
 static JSONObject row(long rowid,String id,String amount,String real,boolean empty,String note)throws Exception {
  JSONArray meta=new JSONArray().put(JSONObject.NULL)
   .put(amount==null?JSONObject.NULL:new JSONObject().put("name","amount").put("type","integer").put("decimal",amount))
   .put(new JSONObject().put("name","real_value").put("type","real").put("decimal",real))
   .put(new JSONObject().put("name","payload").put("type","blob").put("bytes",empty?0:4))
   .put(JSONObject.NULL);
  return new JSONObject().put("_primaryRowid",rowid).put("_primaryOversize",meta.toString())
   .put("id",id).put("amount",amount==null?-42:JSONObject.NULL)
   .put("real_value",JSONObject.NULL).put("payload",JSONObject.NULL)
   .put("note",note==null?JSONObject.NULL:note);
 }
 static NativeFrozenImportV3.PageReader pages(int mode)throws Exception {
  JSONObject first=row(1,"alice","9223372036854775807","1.0",false,"Ελληνικά 🛵");
  JSONObject second=row(mode==2?1:3,"bob",null,"0.10000000000000001",true,null);
  return (table,after,limit)->{
   if(mode==1&&after==1)return null;
   JSONObject p=new JSONObject().put("schemaVersion",3)
    .put("generation",mode==3?"wrong-generation":"frozen-generation-1")
    .put("table",table);
   if(after==0)return p.put("rows",new JSONArray().put(first)).put("next",1).put("hasMore",true);
   if(after==1)return p.put("rows",new JSONArray().put(second))
     .put("next",mode==4?999:(mode==2?1:3)).put("hasMore",false);
   throw new IOException("Unexpected pagination request");
  };
 }
 static NativeFrozenExportV3.CellReader cells(boolean corrupt) {
  return (table,rowid,column,offset,size)->{
   byte[] value=new byte[]{0,(byte)255,(byte)128,1};
   StringBuilder hex=new StringBuilder();
   for(int i=offset;i<offset+size;i++)hex.append(String.format(Locale.US,"%02x",value[i]&255));
   return new JSONObject().put("schemaVersion",3).put("generation",corrupt?"bad-generation":"frozen-generation-1")
    .put("table",table).put("rowid",rowid).put("column",column)
    .put("offset",offset).put("bytes",4).put("kind","blob")
    .put("hex",hex.toString()).put("complete",true);
  };
 }
 static JSONObject run(int mode,boolean corrupt,NativeFrozenImportV3.Progress progress)throws Exception {
  return NativeFrozenImportV3.stage(db,inventory(),pages(mode),cells(corrupt),progress);
 }
 static void fail(int mode,boolean corrupt)throws Exception {
  boolean rejected=false;try{run(mode,corrupt,null);}catch(Exception expected){rejected=true;}
  ok(rejected,"invalid frozen import must fail closed: "+mode+"/"+corrupt);
 }
 public static void main(String[] args)throws Exception {
  System.setProperty("fixture.db",args[0]);db=new SQLiteDatabase();
  try {
   db.execSQL("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT)");
   db.execSQL("CREATE TABLE active_ledger(id INTEGER PRIMARY KEY,amount INTEGER NOT NULL)");
   db.execSQL("INSERT INTO active_ledger VALUES(1,12000)");
   JSONObject proof=run(0,false,null);
   ok(proof.getLong("rows")==2&&!proof.getBoolean("businessWritesEnabled")
    &&proof.getBoolean("contentRevalidationRequired")&&proof.getBoolean("restoreProbeRequired"),
    "candidate remains inactive and requires full recovery/content proof");
   ok("9223372036854775807".equals(sql("SELECT CAST(amount AS TEXT) FROM server_primary_frozen_v3_cash_fixture WHERE _fleet_source_rowid=1")),
    "64-bit INTEGER exact in real SQLite");
   ok("real".equals(sql("SELECT typeof(real_value) FROM server_primary_frozen_v3_cash_fixture WHERE _fleet_source_rowid=1")),
    "REAL 1.0 preserved as REAL");
   ok("blob".equals(sql("SELECT typeof(payload) FROM server_primary_frozen_v3_cash_fixture WHERE _fleet_source_rowid=3"))
    &&"0".equals(sql("SELECT length(payload) FROM server_primary_frozen_v3_cash_fixture WHERE _fleet_source_rowid=3")),
    "empty BLOB remains BLOB and not NULL");
   ok("null".equals(sql("SELECT typeof(note) FROM server_primary_frozen_v3_cash_fixture WHERE _fleet_source_rowid=3")),
    "NULL remains SQL NULL");
   ok("00FF8001".equals(sql("SELECT hex(payload) FROM server_primary_frozen_v3_cash_fixture WHERE _fleet_source_rowid=1")),
    "binary payload byte exact");
   ok("Ελληνικά 🛵".equals(sql("SELECT note FROM server_primary_frozen_v3_cash_fixture WHERE _fleet_source_rowid=1")),
    "Unicode exact");
   String hash=sql("SELECT inventory_sha256 FROM server_primary_frozen_v3_meta WHERE id=1");
   fail(1,false);fail(2,false);fail(3,false);fail(4,false);fail(0,true);
   ok(hash.equals(sql("SELECT inventory_sha256 FROM server_primary_frozen_v3_meta WHERE id=1"))
    &&"2".equals(sql("SELECT COUNT(*) FROM server_primary_frozen_v3_cash_fixture")),
    "failed page/duplicate/generation/cursor/chunk rolls back prior candidate");
   db.injectedSql="INSERT INTO server_primary_frozen_v3_cash_fixture";
   fail(0,false);db.injectedSql="";
   ok("2".equals(sql("SELECT COUNT(*) FROM server_primary_frozen_v3_cash_fixture")),
    "SQL write failure leaves old candidate untouched");
   boolean interrupted=false;
   try{run(0,false,(table,count,expected)->{if(count==1)throw new InterruptedIOException("cancelled");});}
   catch(InterruptedIOException expected){interrupted=true;}
   ok(interrupted&&"2".equals(sql("SELECT COUNT(*) FROM server_primary_frozen_v3_cash_fixture")),
    "interruption rolls back full transaction");
   JSONObject invalid=inventory();invalid.getJSONArray("tables").getJSONObject(0).getJSONArray("columns")
    .getJSONObject(0).put("name","rowid");
   boolean bad=false;try{NativeFrozenImportV3.stage(db,invalid,pages(0),cells(false),null);}
   catch(IOException expected){bad=true;}
   ok(bad,"unsafe column name rejected before SQL mutation");
   ok("12000".equals(sql("SELECT amount FROM active_ledger WHERE id=1")),
    "live business data unchanged");
   // A real restore invalidates both the old mirror proof and this candidate.
   ServerAuthorityStage.invalidate(db);
   ok("0".equals(sql("SELECT COUNT(*) FROM server_primary_frozen_v3_meta")),
    "restore invalidates candidate metadata without deleting historical rows");
   ok("12000".equals(sql("SELECT amount FROM active_ledger WHERE id=1")),
    "restore proof invalidation never changes active business amounts");
   run(0,false,null);
   db.close();db=new SQLiteDatabase();
   ok("2".equals(sql("SELECT COUNT(*) FROM server_primary_frozen_v3_cash_fixture"))
    &&"12000".equals(sql("SELECT amount FROM active_ledger WHERE id=1")),
    "candidate and active data survive process restart independently");
   System.out.println("PASS transactional native frozen v3 importer: typed real SQLite, exact integer/BLOB/Unicode/NULL, rollback on malformed pages, generation, cursor, duplicate row, chunk, SQL failure, interruption, unsafe identifiers, restore proof invalidation, restart, inactive authority.");
  }finally{db.close();}
 }
}
`);
  const jar=path.join(root,'vendor/json-java/json-20240303.jar');
  execFileSync('java',['-jar',path.join(root,'.android-toolchain/usr/share/java/eclipse-jdt-core-3.32.0.jar'),
   '-proc:none','-source','8','-target','8','-nowarn','-encoding','UTF-8','-classpath',jar,'-d',dir,
   ...fixtures,path.join(dir,'FrozenImportTest.java'),
   path.join(root,'server-android/src/gr/argyrismitsos/fleetserver/NativeFrozenExportV3.java'),
   path.join(root,'server-android/src/gr/argyrismitsos/fleetserver/NativeFrozenImportV3.java'),
   path.join(root,'server-android/src/gr/argyrismitsos/fleetserver/ServerAuthorityStage.java')],{stdio:'inherit'});
  execFileSync('java',['-Xmx192m','-Dfixture.rpc='+path.join(dir,'sqlite_rpc.py'),
   '-cp',dir+path.delimiter+jar,'gr.argyrismitsos.fleetserver.FrozenImportTest',
   path.join(dir,'import.sqlite')],{stdio:'inherit',timeout:60000});
} finally {fs.rmSync(dir,{recursive:true,force:true});}

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {storeSqliteFixture} from './fixtures/native-store-sqlite.mjs';
import {MIRROR_TABLES} from '../cloudflare-worker/src/mirror-delta.js';

const root=process.cwd(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-authority-stage-'));
const source='server-android/src/gr/argyrismitsos/fleetserver/ServerAuthorityStage.java';
const declared=fs.readFileSync(source,'utf8').match(/String\[\] TABLES=\{([^}]+)\}/)[1].match(/"([a-z_]+)"/g).map(s=>JSON.parse(s));
assert.deepEqual(declared,MIRROR_TABLES,'Native candidate must preserve every exported table; no silent omission on schema changes');
try {
  storeSqliteFixture(dir);
  fs.writeFileSync(path.join(dir,'AuthorityTest.java'),String.raw`package gr.argyrismitsos.fleetserver;
import android.database.*;import android.database.sqlite.*;import org.json.*;import java.io.*;import java.util.*;import java.util.concurrent.*;import java.security.*;
public class AuthorityTest {
 static final String BASE="https://fleet.fixture.invalid";static SQLiteDatabase db;
 static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 static String scalar(String sql){Cursor c=db.rawQuery(sql,null);try{return c.moveToFirst()?c.getString(0):"";}finally{c.close();}}
 static void save(JSONObject value,String at){db.execSQL("INSERT OR REPLACE INTO system_state(key,value,updated_at) VALUES('full_export',?,?)",new Object[]{value.toString(),at});}
 static JSONObject prepare(String id)throws Exception{return ServerAuthorityStage.prepare(db,BASE,id,Long.MAX_VALUE,null);}
 static String stageId()throws Exception{return ServerAuthorityStage.status(db,BASE).optString("stageId");}
 static void rejected(String id)throws Exception{boolean rejected=false;try{prepare(id);}catch(Exception expected){rejected=true;}check(rejected,"invalid stage must reject");}
 static String hex(byte[] bytes){StringBuilder s=new StringBuilder();for(byte b:bytes)s.append(String.format(java.util.Locale.US,"%02x",b&255));return s.toString();}
 public static void main(String[] args)throws Exception{
  System.setProperty("fixture.db",args[0]);db=new SQLiteDatabase();
  try{
   db.execSQL("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT)");db.execSQL("CREATE TABLE system_state(key TEXT PRIMARY KEY,value TEXT,updated_at TEXT)");
   db.execSQL("INSERT INTO settings VALUES('direct_auth_v1','original read-only auth sentinel')");
   check("not_prepared".equals(ServerAuthorityStage.status(db,BASE).getString("state")),"no invented authority on an existing installation");
   JSONObject workforce=new JSONObject(),ids=new JSONObject();for(String table:ServerAuthorityStage.TABLES){workforce.put(table,new JSONArray());ids.put(table,new JSONArray());}
   workforce.getJSONArray("app_users").put(new JSONObject().put("id","owner").put("role","owner").put("full_name","Συνθετικός εργαζόμενος 🛵")).put(new JSONObject().put("id","employee").put("role","employee"));ids.getJSONArray("app_users").put(101).put(202);
   for(int i=0;i<5000;i++){workforce.getJSONArray("app_users").put(new JSONObject().put("id","employee-"+i).put("role","employee"));ids.getJSONArray("app_users").put(1000+i);}
   StringBuilder large=new StringBuilder();for(int i=0;i<300000;i++)large.append("Ελληνικά 🛵 ");
   workforce.getJSONArray("payroll_snapshots").put(new JSONObject().put("id","locked").put("status","locked").put("amount_cents",12000).put("history",large.toString()));ids.getJSONArray("payroll_snapshots").put(303);
   JSONObject source=new JSONObject().put("schemaVersion",5).put("sourceWorker",BASE).put("workforce",workforce).put("mirror",new JSONObject().put("epoch","0123456789abcdef0123456789abcdef").put("cursor",44).put("rowIds",ids));
   save(source,"2026-11-05T10:00:00Z");String original=source.toString(),sha=hex(MessageDigest.getInstance("SHA-256").digest(original.getBytes("UTF-8")));
   boolean spaceRejected=false;try{ServerAuthorityStage.prepare(db,BASE,"",0,null);}catch(IOException expected){spaceRejected=true;}check(spaceRejected,"low storage rejected before destructive preparation");
   boolean realmRejected=false;try{ServerAuthorityStage.prepare(db,"https://other.fixture.invalid","",Long.MAX_VALUE,null);}catch(IOException expected){realmRejected=true;}check(realmRejected,"wrong Fleet connection rejected");
   long started=System.currentTimeMillis();JSONObject result=prepare("");
   check(result.getInt("tables")==ServerAuthorityStage.TABLES.length&&result.getLong("rows")==5003,"all tables and original stable row IDs copied at realistic row volume");
   check(result.getBoolean("contentCompared")&&!result.getBoolean("businessWritesEnabled")&&result.getBoolean("sourceRevalidationRequired"),"staging never grants write authority");
   check(sha.equals(result.getString("sourcePayloadSha256")),"exact UTF-8 fingerprint including >4 MiB Unicode cell");
   check("12000".equals(scalar("SELECT json_extract(data,'$.amount_cents') FROM server_authority_stage_rows WHERE table_name='payroll_snapshots' AND row_id=303")),"locked historical payroll stays exact");
   check("original read-only auth sentinel".equals(scalar("SELECT value FROM settings WHERE key='direct_auth_v1'")),"existing auth/session state unchanged");
   String first=stageId();db.close();db=new SQLiteDatabase();check(first.equals(stageId()),"real SQLite candidate survives process storage restart");
   check("prepared".equals(ServerAuthorityStage.status(db,BASE).getString("state")),"restart does not invent migration activation");
   JSONObject bad=new JSONObject(original);bad.getJSONObject("mirror").getJSONObject("rowIds").getJSONArray("app_users").put(1,101);save(bad,"2026-11-05T10:01:00Z");rejected(first);
   check(first.equals(stageId())&&"5003".equals(scalar("SELECT COUNT(*) FROM server_authority_stage_rows")),"duplicate row ID rolls back deletion and partial inserts");
   check("source_changed".equals(ServerAuthorityStage.status(db,BASE).getString("state")),"changed source is explicit, never advertised current");
   save(source,"2026-11-05T10:00:00Z");db.injectedSql="INSERT INTO server_authority_stage_rows";rejected(first);db.injectedSql="";
   check(first.equals(stageId())&&"5003".equals(scalar("SELECT COUNT(*) FROM server_authority_stage_rows")),"SQL/disk-style failure preserves the previous candidate");
   boolean interrupted=false;try{ServerAuthorityStage.prepare(db,BASE,first,Long.MAX_VALUE,new ServerAuthorityStage.Progress(){public void stage(String message)throws Exception{if(message.contains("18 /"))throw new InterruptedIOException("simulated OTA safe-point cancellation");}});}catch(InterruptedIOException expected){interrupted=true;}
   check(interrupted&&first.equals(stageId())&&"5003".equals(scalar("SELECT COUNT(*) FROM server_authority_stage_rows")),"mid-copy cancellation rolls back and retains previous candidate");
   check("0".equals(scalar("SELECT COUNT(*) FROM server_authority_stage_ids")),"temporary lookup rows are not retained after completion or rollback");
   String second=prepare(first).getString("stageId");check(!second.equals(first),"new successful proof has a new CAS token");rejected(first);check(second.equals(stageId()),"stale admin cannot overwrite newer preparation");
   final String expected=second;final java.util.concurrent.atomic.AtomicInteger successes=new java.util.concurrent.atomic.AtomicInteger(),conflicts=new java.util.concurrent.atomic.AtomicInteger();final CountDownLatch go=new CountDownLatch(1);
   Runnable attempt=new Runnable(){public void run(){try{go.await();prepare(expected);successes.incrementAndGet();}catch(Exception conflict){conflicts.incrementAndGet();}}};Thread a=new Thread(attempt),b=new Thread(attempt);a.start();b.start();go.countDown();a.join();b.join();check(successes.get()==1&&conflicts.get()==1,"two admins produce one commit and one real conflict");
   String current=stageId();bad=new JSONObject(original);bad.put("schemaVersion",6);save(bad,"2026-11-05T10:02:00Z");rejected(current);
   bad=new JSONObject(original);bad.getJSONObject("workforce").remove("audit_log");save(bad,"2026-11-05T10:03:00Z");rejected(current);
   bad=new JSONObject(original);bad.getJSONObject("workforce").put("unknown_future_table",new JSONArray());save(bad,"2026-11-05T10:04:00Z");rejected(current);
   bad=new JSONObject(original);bad.getJSONObject("mirror").getJSONObject("rowIds").getJSONArray("app_users").put(0,"101");save(bad,"2026-11-05T10:05:00Z");rejected(current);
   save(source,"2026-11-05T10:00:00Z");
   check("source_changed".equals(ServerAuthorityStage.status(db,"https://other.fixture.invalid").getString("state")),"connection change invalidates the prepared proof");
   ServerAuthorityStage.invalidate(db);check("not_prepared".equals(ServerAuthorityStage.status(db,BASE).getString("state")),"restore explicitly invalidates all previous migration proofs");
   JSONObject restored=new JSONObject(original).put("schemaVersion",3);save(restored,"2026-11-05T10:06:00Z");check(prepare("").getBoolean("contentCompared"),"compatible backup wrapper v3 still requires and permits a new full preparation");save(source,"2026-11-05T10:00:00Z");
   check("original read-only auth sentinel".equals(scalar("SELECT value FROM settings WHERE key='direct_auth_v1'")),"no business/auth writes in any failure or success path");
   java.nio.file.Files.write(java.nio.file.Paths.get(args[0]+".sha256"),sha.getBytes("UTF-8"));
   System.out.println("PASS real SQLite migration candidate: all "+ServerAuthorityStage.TABLES.length+" tables, 5003 rows, >4 MiB Unicode cell, exact SHA/content/row IDs, restart, low space, wrong realm, duplicate IDs, SQL failure, mid-copy cancellation, stale/two-admin CAS and restore invalidation; existing authority/auth unchanged. Synthetic elapsed "+(System.currentTimeMillis()-started)+" ms.");
  }finally{db.close();}
 }
}`);
  const jar=path.join(root,'vendor/json-java/json-20240303.jar');
  const files=fs.readdirSync(dir).filter(n=>n.endsWith('.java')).map(n=>path.join(dir,n));
  execFileSync('java',['-jar',path.join(root,'.android-toolchain/usr/share/java/eclipse-jdt-core-3.32.0.jar'),'-proc:none','-source','8','-target','8','-nowarn','-encoding','UTF-8','-classpath',jar,'-d',dir,...files,path.join(root,source)],{stdio:'inherit'});
  const database=path.join(dir,'migration.sqlite');
  execFileSync('java',['-Xmx192m','-Dfixture.rpc='+path.join(dir,'sqlite_rpc.py'),'-cp',dir+path.delimiter+jar,'gr.argyrismitsos.fleetserver.AuthorityTest',database],{stdio:'inherit',timeout:60000});
  execFileSync('python3',['-c',`import hashlib,sqlite3,sys,pathlib
p=sys.argv[1]
with sqlite3.connect(p) as db:
 data=db.execute("SELECT value FROM system_state WHERE key='full_export'").fetchone()[0]
 assert hashlib.sha256(data.encode('utf-8')).hexdigest()==pathlib.Path(p+'.sha256').read_text()
 assert db.execute("SELECT json_extract(data,'$.amount_cents') FROM server_authority_stage_rows WHERE table_name='payroll_snapshots'").fetchone()[0]==12000
print('PASS independent Python: original mirror bytes and locked historical amount remain intact.')`,database],{stdio:'inherit'});
}finally{fs.rmSync(dir,{recursive:true,force:true});}

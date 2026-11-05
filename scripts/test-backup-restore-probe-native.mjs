import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {storeSqliteFixture} from './fixtures/native-store-sqlite.mjs';

const root=process.cwd(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-restore-probe-'));
const jar=path.join(root,'vendor/json-java/json-20240303.jar');
try {
  storeSqliteFixture(dir);
  fs.unlinkSync(path.join(dir,'FleetDataStore.java'));
  const write=(name,body)=>fs.writeFileSync(path.join(dir,name+'.java'),body);
  write('Context',String.raw`package android.content;import java.io.*;import java.util.*;
public class Context {
 protected final File root;public final List<String> deleted=new ArrayList<String>();
 public Context(File directory){root=directory;root.mkdirs();}
 public File getFilesDir(){File f=new File(root,"files");f.mkdirs();return f;}
 public File getCacheDir(){File f=new File(root,"cache");f.mkdirs();return f;}
 public File getDatabasePath(String name){File f=new File(root,"databases");f.mkdirs();return new File(f,name);}
 public boolean deleteDatabase(String name){if(!name.startsWith("fleet-recovery-probe-"))throw new AssertionError("live database deletion");deleted.add(name);return getDatabasePath(name).delete();}
}`);
  write('ContextWrapper',String.raw`package android.content;import java.io.File;
public class ContextWrapper extends Context{final Context base;public ContextWrapper(Context c){super(c.root);base=c;}public File getFilesDir(){return base.getFilesDir();}public File getCacheDir(){return base.getCacheDir();}}`);
  write('SQLiteOpenHelper',String.raw`package android.database.sqlite;import android.content.Context;
public abstract class SQLiteOpenHelper {
 private SQLiteDatabase db;private final Context context;private final String name;
 public SQLiteOpenHelper(Context c,String n,Object factory,int version){context=c;name=n;}
 public SQLiteDatabase getReadableDatabase(){return getWritableDatabase();}
 public SQLiteDatabase getWritableDatabase(){if(db==null){System.setProperty("fixture.db",context.getDatabasePath(name).getPath());db=new SQLiteDatabase();onCreate(db);if(name.startsWith("fleet-recovery-probe-")&&Boolean.getBoolean("fixture.fail.probe"))db.injectedSql="quick_check";}return db;}
 public abstract void onCreate(SQLiteDatabase db);public abstract void onUpgrade(SQLiteDatabase db,int a,int b);public void close(){if(db!=null)db.close();}
}`);
  write('FleetHttp',String.raw`package gr.argyrismitsos.fleetserver;import java.io.*;import java.util.*;
public class FleetHttp{public static void downloadToFile(String u,File f,Map<String,String> h){throw new AssertionError("unexpected network");}public static void putStream(String u,InputStream i,long l,String t,Map<String,String> h){throw new AssertionError("unexpected upload");}}`);
  write('ProbeTest',String.raw`package gr.argyrismitsos.fleetserver;
import android.content.*;import java.io.*;import java.nio.file.*;import java.util.zip.*;import org.json.*;
public class ProbeTest {
 static void check(boolean v,String m){if(!v)throw new AssertionError(m);}
 static String live(FleetDataStore store)throws Exception{return BackupRestoreProbe.canonical(store.getFleet())+BackupRestoreProbe.canonical(store.getSystemExport())+BackupRestoreProbe.canonical(new StoreBillingStore(store).exportRows());}
 static void rejected(Context c,JSONObject source,JSONObject inventory,File archive,int documents)throws Exception{boolean failed=false;try{BackupRestoreProbe.run(c,source,inventory,archive,documents);}catch(Exception expected){failed=true;}check(failed,"bad restore must fail");}
 public static void main(String[] args)throws Exception{
  Context context=new Context(new File(args[0],"app"));FleetDataStore live=new FleetDataStore(context);
  try {
   String key="service-documents/bike/entry/invoice.pdf";byte[] pdf="%PDF-1.4\nΣυνθετικό τιμολόγιο\n%%EOF".getBytes("UTF-8");
   JSONObject document=new JSONObject().put("key",key).put("name","invoice.pdf").put("contentType","application/pdf");
   JSONObject fleet=new JSONObject().put("bikes",new JSONArray().put(new JSONObject().put("id","bike").put("name","Μηχανάκι").put("history",new JSONArray().put(new JSONObject().put("id","entry").put("type","service").put("notes","Ελληνικό ιστορικό 🛵").put("attachments",new JSONArray().put(document))))));
   live.mergeFleet(fleet);
   JSONObject workforce=new JSONObject().put("app_users",new JSONArray().put(new JSONObject().put("id","user").put("full_name","Συνθετικός εργαζόμενος")))
    .put("payroll_periods",new JSONArray().put(new JSONObject().put("id","period").put("status","locked").put("total_cents",3000)))
    .put("payroll_entries",new JSONArray().put(new JSONObject().put("id","payment").put("period_id","period").put("employee_id","user").put("amount_cents",3000)))
    .put("audit_logs",new JSONArray().put(new JSONObject().put("id","audit").put("action","fixture")));
   live.setSystemExport(new JSONObject().put("workforce",workforce));
   StoreBillingStore stores=new StoreBillingStore(live);String scope="fixture",shop=StoreBillingStore.key("store",scope,"1"),order=StoreBillingStore.key("order",scope,"order-1");
   stores.put(shop,"store",scope,shop,"",new JSONObject().put("id",shop).put("sourceShopId","1").put("retainOrders",false),false);
   stores.put(order,"order",scope,shop,"2026-11-04",new JSONObject().put("id",order).put("storeId",shop).put("sourceShopId","1").put("sourceOrderId","order-1").put("businessDay","2026-11-04").put("at","2026-11-04T10:00:00Z").put("active",true),false);
   stores.put("coverage-1","coverage",scope,"","2026-11-04",new JSONObject().put("runId","run-1").put("sourceAt","2026-11-04T11:00:00Z"),false);
   stores.put("day-1","local_day",scope,shop,"2026-11-04",new JSONObject().put("storeId",shop).put("businessDay","2026-11-04").put("orderCount",1).put("orderChargeCents",200).put("minimumTopUpCents",800).put("totalChargeCents",1000),false);
   File original=ServiceDocumentStore.localFile(context,key,"invoice.pdf");original.getParentFile().mkdirs();Files.write(original.toPath(),pdf);
   File archive=new File(args[0],"documents.zip");
   try(ZipOutputStream zip=new ZipOutputStream(new FileOutputStream(archive))){
    JSONArray manifest=new JSONArray().put(new JSONObject(document.toString()).put("zipName","documents/one.pdf").put("size",pdf.length).put("sha256",BackupArchiveVerifier.digest(pdf)));
    zip.putNextEntry(new ZipEntry("fleet-control-documents.json"));zip.write(manifest.toString().getBytes("UTF-8"));zip.closeEntry();
    zip.putNextEntry(new ZipEntry("documents/one.pdf"));zip.write(pdf);zip.closeEntry();
   }
   JSONObject source=live.fullBackupPayload().put("settings",new JSONObject().put("backupHour",3).put("backupFrequency","daily"));String before=live(live),sourceBefore=BackupRestoreProbe.canonical(source);
   JSONObject evidence=BackupRestoreProbe.run(context,source,fleet,archive,1);
   check(evidence.getBoolean("restoreVerified")&&evidence.getBoolean("isolated")&&evidence.getBoolean("contentMatches"),"real recovery evidence");
   check(evidence.getInt("bikes")==1&&evidence.getInt("workforceRecords")==4&&evidence.getInt("storeRecords")==4&&evidence.getInt("documents")==1,"all expected sections restored");
   check(evidence.getBoolean("sourceRevalidationRequired"),"restored coverage cannot be advertised fresh");
   check(before.equals(live(live)),"live SQLite and locked payroll remain identical");
   check(sourceBefore.equals(BackupRestoreProbe.canonical(source)),"source backup not mutated");
   check(java.util.Arrays.equals(pdf,Files.readAllBytes(original.toPath())),"original service document untouched");
   check(context.getCacheDir().list().length==0,"temporary document tree removed");
   check(context.getDatabasePath("fleet-control-server.db").isFile(),"live database still exists");
   for(String name:context.deleted)check(!context.getDatabasePath(name).exists(),"temporary SQLite removed");
   rejected(context,new JSONObject(source.toString()).put("schemaVersion",99),fleet,archive,1);
   JSONObject missing=new JSONObject(source.toString());missing.remove("workforce");rejected(context,missing,fleet,archive,1);
   JSONObject duplicate=new JSONObject(source.toString());duplicate.getJSONObject("fleet").getJSONArray("bikes").put(duplicate.getJSONObject("fleet").getJSONArray("bikes").getJSONObject(0));rejected(context,duplicate,fleet,archive,1);
   rejected(context,source,fleet,null,1);
   System.setProperty("fixture.fail.probe","true");rejected(context,source,fleet,archive,1);System.clearProperty("fixture.fail.probe");
   check(before.equals(live(live))&&context.getCacheDir().list().length==0,"failure cleans isolated state and never changes production");
   System.out.println("PASS actual isolated restore: separate real SQLite, Fleet and locked workforce snapshot, store ledger/financial content, real PDF restoration to private scratch, source revalidation flags, byte-identical live state, cleanup and rejected corrupt/incomplete/future-schema/SQL-failure cases; no network calls.");
  } finally {live.close();}
 }
}`);
  const sourceNames=['FleetDataStore','HistoryMergePolicy','NextServiceNotes','StoreBillingStore','StoreBillingEngine','OrdexaClient','ServiceDocumentStore','BackupArchiveVerifier','BackupRestoreProbe'];
  const files=fs.readdirSync(dir).filter(n=>n.endsWith('.java')).map(n=>path.join(dir,n));
  execFileSync('java',['-jar',path.join(root,'.android-toolchain/usr/share/java/eclipse-jdt-core-3.32.0.jar'),'-proc:none','-source','8','-target','8','-nowarn','-encoding','UTF-8','-classpath',jar,'-d',dir,...files,...sourceNames.map(n=>path.join(root,'server-android/src/gr/argyrismitsos/fleetserver',n+'.java'))],{stdio:'inherit'});
  execFileSync('java',['-Xmx192m','-Dfixture.rpc='+path.join(dir,'sqlite_rpc.py'),'-cp',dir+path.delimiter+jar,'gr.argyrismitsos.fleetserver.ProbeTest',dir],{stdio:'inherit',timeout:60000});
} finally {fs.rmSync(dir,{recursive:true,force:true});}

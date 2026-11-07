import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
import {businessSqliteFixture} from './fixtures/business-sqlite.mjs';
import {pdfboxFixture} from './fixtures/pdfbox.mjs';
import {backupBase64Fixture} from './fixtures/backup-base64.mjs';
const root=process.cwd(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-business-'));
try{
 execFileSync('python3',['scripts/prepare-business-dependencies.py'],{stdio:'inherit'});
 execFileSync('python3',['scripts/prepare-invoice-dependencies.py','.build/business-build-deps'],{stdio:'inherit'});
 execFileSync('node',['scripts/build-business-runtime.mjs'],{stdio:'inherit'});
 const files=businessSqliteFixture(dir),write=(name,text)=>fs.writeFileSync(path.join(dir,name),text);files.push(...pdfboxFixture(dir),...backupBase64Fixture(dir));
 write('BusinessTest.java',String.raw`package gr.argyrismitsos.fleetserver;
import org.json.*;import android.database.sqlite.*;import android.database.Cursor;import java.nio.file.*;import java.io.*;
public class BusinessTest{
 static String lastError="";static NativeBusinessEngine runtime;static boolean primaryChecks,expireBeforeCommit;static long monotonic;static NativePrimaryLease lease=new NativePrimaryLease(()->monotonic);static String primaryEpoch;static NativePrimaryGuard primaryGuard;static final String GEN="00000000-0000-4000-8000-000000000001";static SQLiteDatabase db;static final String PEPPER="ppppppppppppppppppppppppppppppppppppppppppp";
 static void check(boolean b,String message){if(!b)throw new AssertionError(message);}
 static JSONObject call(String path,String method,Object body,boolean internal,String token)throws Exception{
  return call(path,method,body,internal,token,java.util.UUID.randomUUID().toString());
 }
 static JSONObject call(String path,String method,Object body,boolean internal,String token,String operationId)throws Exception{
  JSONObject headers=new JSONObject().put("Content-Type","application/json");if(internal)headers.put("X-Fleet-Server-Key","fixture-server-key-at-least-32-bytes");if(token!=null)headers.put("Authorization","Bearer "+token);
  if(!internal&&!method.equals("GET")&&operationId!=null)headers.put("X-Fleet-Operation",operationId);
  JSONObject request=new JSONObject().put("url","https://fleet.fixture.invalid"+path).put("method",method).put("headers",headers);if(body!=null)request.put("body",body.toString());
  JSONObject response=runtime.request(request,internal,30000);if(response.optInt("status")>=500)throw new AssertionError("API "+path+" failed "+response+" native="+lastError);return response;
 }
 public static void main(String[] args)throws Exception{db=new SQLiteDatabase(args[0]);final BusinessSqlite sql=new BusinessSqlite(db);
  try{
   for(String empty:new String[]{"","-- standalone schema comment","/* standalone block comment */","; -- only comments"}){
    boolean rejected=false;try{db.execSQL(empty);}catch(SQLiteException expected){rejected=true;}check(rejected,"fixture preserves Android empty-statement rejection");
   }
   JSONObject script=sql.call("sql.exec",new JSONObject().put("sql","-- header\\r\\nCREATE TABLE fixture_script(id INTEGER PRIMARY KEY,value TEXT);\\r\\n/* comment-only */\\n; -- empty separators\\nINSERT INTO fixture_script VALUES(1,'a--b /* literal */'); -- trailing comment\\n".replace("\\r","\r").replace("\\n","\n")));
   check(script.getInt("count")==2,"comments do not become Android SQL statements");
   check(sql.call("sql.query",new JSONObject().put("sql","SELECT value FROM fixture_script")).getJSONArray("results").getJSONObject(0).getString("value").equals("a--b /* literal */"),"SQL literal comment markers preserved");
   db.execSQL("DROP TABLE fixture_script");
   boolean queryRejected=false;try{db.execSQL("SELECT 1");}catch(SQLiteException expected){queryRejected=true;}check(queryRejected,"fixture preserves Android execSQL result-row rejection");
   boolean scriptFailed=false;try{sql.call("sql.exec",new JSONObject().put("sql","CREATE TABLE fixture_script_rollback(id INTEGER);\n-- comment between statements\nINSERT INTO fixture_missing_table VALUES(1);"));}catch(SQLiteException expected){scriptFailed=true;}
   check(scriptFailed&&sql.call("sql.query",new JSONObject().put("sql","SELECT name FROM sqlite_master WHERE name='fixture_script_rollback'")).getJSONArray("results").length()==0,"failed schema scripts preserve atomic rollback");
   String code=new String(Files.readAllBytes(Paths.get(args[1])),"UTF-8");JSONObject manifest=new JSONObject(new String(Files.readAllBytes(Paths.get(args[2])),"UTF-8"));
   final android.content.Context appContext=new android.content.Context(new File(new File(args[0]).getParentFile(),"app").getPath());
   final BusinessObjects objects=new BusinessObjects(db,new File(appContext.getFilesDir(),"service-documents"),new File(appContext.getCacheDir(),"business-files"));
   com.tom_roush.pdfbox.android.PDFBoxResourceLoader.init(new android.content.Context(args[3]));
   primaryGuard=new NativePrimaryGuard(db,lease,"https://fleet.fixture.invalid",GEN);
   runtime=new NativeBusinessEngine(db,new File(appContext.getFilesDir(),"service-documents"),new File(appContext.getCacheDir(),"business-files"),new JSONObject().put("realm","https://fleet.fixture.invalid").put("generation",GEN).put("serverKey","fixture-server-key-at-least-32-bytes").put("authPepper",PEPPER).put("eventSigningKey","native-event-fixture-at-least-32-bytes"),code,manifest.getString("bundleSha256"),new NativeBusinessEngine.Authority(){
    public void beforeRequest(JSONObject request,boolean internal)throws Exception{if(primaryChecks){primaryGuard.begin(primaryEpoch,false);primaryGuard.beforeRequest(request,internal);}}
    public void beforeCommit(JSONObject response,boolean internal)throws Exception{if(primaryChecks){if(expireBeforeCommit)monotonic+=31000;primaryGuard.beforeCommit(response,internal);}}
   },new NativeBusinessEngine.Ports(){
    public JSONObject call(String command,JSONObject data,BusinessObjects objects)throws Exception{
     JSONObject value=null;
       if(command.equals("store.context")){db.execSQL("CREATE TABLE IF NOT EXISTS store_billing_local(id TEXT PRIMARY KEY,kind TEXT NOT NULL,scope TEXT NOT NULL,store_id TEXT NOT NULL DEFAULT \"\",day TEXT NOT NULL DEFAULT \"\",data TEXT NOT NULL,dirty INTEGER NOT NULL DEFAULT 1)");value=new JSONObject().put("configured",true).put("scope","report-fixture").put("generation","source-generation-1");}
       else if(command.equals("health.snapshot"))value=BusinessFeatureChecks.health;
       else if(command.equals("reports.export")){
        String format=data.getString("format");File target=objects.exportTarget(format);
        if(format.equals("xlsx"))FinancialExport.writeXlsx(target,data.getJSONObject("spec"));else FinancialExport.writePdf(target,data.getJSONObject("spec"),new FileInputStream(new File(args[3],"com/tom_roush/pdfbox/resources/ttf/LiberationSans-Regular.ttf")));
        value=objects.registerExport(target,"fixture-export."+format,format.equals("pdf")?"application/pdf":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
       }else throw new IOException("unsupported fixture capability "+command);
      return value;
    }
   });
   JSONObject sandbox=runtime.sandboxStatus();for(String key:sandbox.keySet())check("undefined".equals(sandbox.getString(key)),"Java/file reflection is unavailable: "+key);
   check(call("/api/status","GET",null,false,null).getInt("status")==200,"actual shared status on local SQLite");
   check(call("/api/admin/employees","GET",null,false,null).getInt("status")==401,"native API preserves login gate");
   JSONObject owner=new JSONObject().put("fullName","Συνθετικός ιδιοκτήτης").put("username","owner.fixture").put("password","Fixture-Secret-2026!").put("deviceId","native-fixture");
   JSONObject bootstrap=call("/api/auth/bootstrap","POST",owner,true,null);check(bootstrap.getInt("status")==200||bootstrap.getInt("status")==201,"owner bootstrap "+bootstrap);
   JSONObject login=call("/api/auth/user-login","POST",new JSONObject().put("username","owner.fixture").put("password","Fixture-Secret-2026!").put("deviceId","native-fixture"),false,null);check(login.getInt("status")==200,"actual PBKDF2 native login "+login);String token=new JSONObject(login.getString("body")).getString("token");
   JSONObject staff=call("/api/admin/employees","GET",null,false,token);check(staff.getInt("status")==200,"native authenticated staff API");
   check(staff.getJSONObject("headers").getString("x-fleet-principal").matches("[a-f0-9]{64}")&&!staff.getJSONObject("headers").getString("x-fleet-actor").isEmpty(),"authenticated encrypted response identifies current account/security revision");
   check(!call("/api/status","GET",null,false,null).getJSONObject("headers").has("x-fleet-actor"),"principal cannot leak into a later public request");
   JSONObject created=call("/api/admin/employees","POST",new JSONObject().put("fullName","Δοκιμή διανομέα").put("username","rider.fixture").put("password","Rider-Fixture-2026!").put("role","employee"),false,token);check(created.getInt("status")==201,"actual staff mutation "+created);
   String riderId=new JSONObject(created.getString("body")).getJSONObject("employee").getString("id");
   String operation=java.util.UUID.randomUUID().toString();JSONObject noLogin=new JSONObject().put("fullName","Συνθετική καταχώριση").put("loginEnabled",false);
   check(call("/api/admin/employees","POST",noLogin,false,token,null).getInt("status")==428,"missing operation identity cannot create business mutation");
   JSONObject once=call("/api/admin/employees","POST",noLogin,false,token,operation),again=call("/api/admin/employees","POST",noLogin,false,token,operation);check(once.getInt("status")==201&&again.getString("body").equals(once.getString("body"))&&again.getJSONObject("headers").getString("x-fleet-replayed").equals("1"),"lost-response retry returns same receipt without duplicate mutation");
   check(call("/api/admin/employees","POST",new JSONObject().put("fullName","Διαφορετικό προσχέδιο").put("loginEnabled",false),false,token,operation).getInt("status")==409,"operation body cannot change after commit");
   String failing=java.util.UUID.randomUUID().toString();db.execSQL("CREATE TRIGGER fixture_receipt_failure BEFORE INSERT ON native_operation_receipts WHEN NEW.operation_id='"+failing+"' BEGIN SELECT RAISE(ABORT,'fixture_receipt_failure'); END;");
   boolean receiptFailure=false;try{call("/api/admin/employees","POST",new JSONObject().put("fullName","Must roll back with receipt").put("loginEnabled",false),false,token,failing);}catch(AssertionError expected){receiptFailure=true;}check(receiptFailure,"injected receipt write must fail");
   check(sql.call("sql.query",new JSONObject().put("sql","SELECT COUNT(*) n FROM app_users WHERE full_name='Must roll back with receipt'")).getJSONArray("results").getJSONObject(0).getInt("n")==0,"business mutation and audit roll back when receipt cannot commit");
   db.execSQL("DROP TRIGGER fixture_receipt_failure");
   JSONObject riderLogin=call("/api/auth/user-login","POST",new JSONObject().put("username","rider.fixture").put("password","Rider-Fixture-2026!").put("deviceId","rider-fixture"),false,null);check(riderLogin.getInt("status")==200,"rider login");String riderToken=new JSONObject(riderLogin.getString("body")).getString("token");
   check(call("/api/admin/employees","GET",null,false,riderToken).getInt("status")==403,"employee cannot manage staff");
   check(call("/api/native/cash?from=2026-11-04&to=2026-11-04","GET",null,false,riderToken).getInt("status")==403,"employee cannot read management cash records");
   check(call("/api/server/ordexa/import","POST",new JSONObject(),false,token).getInt("status")==403,"public caller cannot acquire native pipeline capability");
   check(call("/api/admin/employees/"+riderId,"PUT",new JSONObject().put("active",false),false,token).getInt("status")==200,"owner disables staff account");
   check(call("/api/auth/me","GET",null,false,riderToken).getInt("status")==401,"revocation is immediate on local authority");
   BusinessFeatureChecks.run(sql,db,token,riderToken,riderId);
   BusinessAutomaticCashChecks.run(sql,db,token);
   BusinessFileChecks.run(objects,sql,db,token);
   BusinessPrimaryChecks.run(sql,db,token);
   JSONObject bind=sql.call("sql.query",new JSONObject().put("sql","SELECT typeof(?) integer_type,typeof(?) float_type,? greek,? flag").put("params",new JSONArray().put(123).put(1.5).put("Ελληνικά '); DROP TABLE app_users; --").put(true))).getJSONArray("results").getJSONObject(0);
   check(bind.getString("integer_type").equals("integer")&&bind.getString("float_type").equals("real")&&bind.getInt("flag")==1&&bind.getString("greek").startsWith("Ελληνικά"),"native typed binds and SQL injection isolation");
   db.execSQL("CREATE TABLE fixture_atomic(id INTEGER PRIMARY KEY,value TEXT)");
   try{sql.call("sql.batch",new JSONObject().put("queries",new JSONArray().put(new JSONObject().put("sql","INSERT INTO fixture_atomic VALUES(1,?)").put("params",new JSONArray().put("rollback"))).put(new JSONObject().put("sql","INSERT INTO table_missing VALUES(1)"))));throw new AssertionError("batch should fail");}catch(android.database.sqlite.SQLiteException expected){}
   check(sql.call("sql.query",new JSONObject().put("sql","SELECT COUNT(*) n FROM fixture_atomic")).getJSONArray("results").getJSONObject(0).getInt("n")==0,"real rollback after mid-batch failure");
   StringBuilder large=new StringBuilder();for(int i=0;i<1100000;i++)large.append("Ω€");String historical=large.toString();db.execSQL("INSERT INTO fixture_atomic VALUES(?,?)",new Object[]{7,historical});
   JSONObject historicalRow=sql.call("sql.query",new JSONObject().put("sql","SELECT id,value FROM fixture_atomic ORDER BY id")).getJSONArray("results").getJSONObject(0);check(historicalRow.getString("value").equals(historical)&&historicalRow.getInt("id")==7&&Cursor.largeRows>0,"bounded CursorWindow fallback retains historical Unicode exactly");
   check(Cursor.opened==0,"all actual SQL cursors closed");
   BusinessSnapshotChecks.run(db,sql,new File(new File(args[0]).getParentFile(),"snapshot-test"));
   BusinessBundleChecks.run(appContext,db,sql);
   runtime.close();runtime=null;
   String diagnostic="globalThis.__fleetInit=function(){__fleetNative('sql.exec','{}');};";
   try{new BusinessRuntime((command,raw)->{throw new SQLiteException("no such table: PRIVATE_NATIVE_ERROR_CANARY");},diagnostic,BusinessRuntime.sha256(diagnostic.getBytes("UTF-8")),new JSONObject());throw new AssertionError("injected native SQL failure expected");}
   catch(org.mozilla.javascript.EvaluatorException expected){check(expected.getMessage().contains("[SQL_EXEC/SQLITE_SCHEMA]")&&!expected.getMessage().contains("PRIVATE_NATIVE_ERROR_CANARY")&&!expected.getMessage().contains("no such table"),"safe capability category without raw SQL/data");}
   String unknownDiagnostic="globalThis.__fleetInit=function(){__fleetNative('PRIVATE_COMMAND_CANARY','{}');};";
   try{new BusinessRuntime((command,raw)->{throw new IOException("PRIVATE_IO_ERROR_CANARY");},unknownDiagnostic,BusinessRuntime.sha256(unknownDiagnostic.getBytes("UTF-8")),new JSONObject());throw new AssertionError("injected unknown capability failure expected");}
   catch(org.mozilla.javascript.EvaluatorException expected){check(expected.getMessage().contains("[LOCAL/LOCAL_IO]")&&!expected.getMessage().contains("PRIVATE_"),"unknown native command and cause stay private");}
   try{new BusinessRuntime((command,raw)->"{}",code,"00",new JSONObject());throw new AssertionError("corrupt bundle should be rejected");}catch(IOException expected){}
   String looping="globalThis.__fleetInit=function(){};globalThis.__fleetRequest=function(){while(true){}}";
   BusinessRuntime limited=new BusinessRuntime((command,raw)->"{}",looping,BusinessRuntime.sha256(looping.getBytes("UTF-8")),new JSONObject());long start=System.nanoTime();try{limited.request(new JSONObject(),false,100);throw new AssertionError("budget should stop interpreter");}catch(Exception expected){check((System.nanoTime()-start)/1000000<5000,"bounded interpreter budget");}finally{limited.close();}
   System.out.println("PASS actual shared business runtime: sealed Java capabilities, integrity/time budget, schema, PBKDF2 auth, staff mutation/permissions/immediate revocation, typed binds, real atomic rollback, >5 MiB historical Unicode/CursorWindow fallback and cursor cleanup. Queries="+db.queries);
  }catch(Throwable e){System.err.println(e.toString());throw e;}finally{if(runtime!=null)runtime.close();db.close();}
 }
}`);
 write('BusinessAutomaticCashChecks.java',fs.readFileSync('scripts/fixtures/BusinessAutomaticCashChecks.java.txt','utf8'));
 write('BusinessFeatureChecks.java',fs.readFileSync('scripts/fixtures/BusinessFeatureChecks.java.txt','utf8'));
 write('BusinessFileChecks.java',fs.readFileSync('scripts/fixtures/BusinessFileChecks.java.txt','utf8'));
 write('BusinessPrimaryChecks.java',fs.readFileSync('scripts/fixtures/BusinessPrimaryChecks.java.txt','utf8'));
 write('NativeMigrationFlowTest.java',fs.readFileSync('scripts/fixtures/NativeMigrationFlowTest.java.txt','utf8'));
 write('NativeColdRestoreChecks.java',fs.readFileSync('scripts/fixtures/NativeColdRestoreChecks.java.txt','utf8'));
 write('BusinessSnapshotChecks.java',fs.readFileSync('scripts/fixtures/BusinessSnapshotChecks.java.txt','utf8'));
 write('BusinessBundleChecks.java',fs.readFileSync('scripts/fixtures/BusinessBundleChecks.java.txt','utf8'));
 write('FleetHttp.java','package gr.argyrismitsos.fleetserver;import java.io.*;import java.util.*;public class FleetHttp{public static void downloadToFile(String url,File file,Map<String,String> headers){throw new AssertionError("unexpected network during backup");}public static void putStream(String url,InputStream input,long size,String type,Map<String,String> headers){throw new AssertionError("unexpected upload during backup");}}');
 write('BackupManager.java','package gr.argyrismitsos.fleetserver;public class BackupManager{static byte[] encryptionKey(){return new byte[32];}}');
 write('BackupProtection.java','package gr.argyrismitsos.fleetserver;import android.content.Context;public class BackupProtection{static PortableBackupCipher.Material material(Context context){throw new AssertionError("unexpected platform Keystore access in portable builder");}}');
 const names=['NativeColdRestore','NativeRecoveryInstall','NativeMigrationCoordinator','NativeFrozenExportV3','NativeFrozenImportV3','NativeFrozenDigest','NativePrimaryPromotion','NativeBusinessEngine','NativePrimaryGuard','NativePrimaryLease','BusinessRuntime','BusinessPrimitives','BusinessSqlite','BusinessObjects','BusinessActor','FinancialExport','NativeDatabaseSnapshot','NativePrimarySchema','PortableBackupCipher','BackupCipher','BackupArchiveVerifier','BackupJsonWriter','BackupEnvelope','NativeBackupBuilder','NativeBackupReader','NativeBackupRestoreProbe','NativePrimaryState','ServiceDocumentArchive','ServiceDocumentStore'];files.push(path.join(dir,'BusinessTest.java'),path.join(dir,'BusinessFeatureChecks.java'),path.join(dir,'BusinessAutomaticCashChecks.java'),path.join(dir,'BusinessFileChecks.java'),path.join(dir,'BusinessPrimaryChecks.java'),path.join(dir,'NativeMigrationFlowTest.java'),path.join(dir,'NativeColdRestoreChecks.java'),path.join(dir,'BusinessSnapshotChecks.java'),path.join(dir,'BusinessBundleChecks.java'),path.join(dir,'FleetHttp.java'),path.join(dir,'BackupManager.java'),path.join(dir,'BackupProtection.java'),...names.map(n=>path.join(root,'server-android/src/gr/argyrismitsos/fleetserver',n+'.java')));
 const jars=[path.join(root,'vendor/json-java/json-20240303.jar'),path.join(root,'.build/runtime-deps/rhino-1.9.1.jar'),...fs.readdirSync('.build/business-build-deps/jars').filter(n=>n.endsWith('.jar')).map(n=>path.resolve('.build/business-build-deps/jars',n))].join(path.delimiter);
 execFileSync('java',['-jar',path.join(root,'.android-toolchain/usr/share/java/eclipse-jdt-core-3.32.0.jar'),'-proc:none','-source','8','-target','8','-nowarn','-encoding','UTF-8','-classpath',jars,'-d',dir,...files],{stdio:'inherit'});
 execFileSync('java',['-Xmx384m','-Dfixture.rpc='+path.join(dir,'sqlite_rpc.py'),'-cp',dir+path.delimiter+jars,'gr.argyrismitsos.fleetserver.BusinessTest',path.join(dir,'business.sqlite'),path.join(root,'.build/business-runtime/runtime.js'),path.join(root,'.build/business-runtime/manifest.json'),path.resolve('.build/business-build-deps/assets')],{stdio:'inherit',timeout:90000});
 execFileSync('java',['-Xmx384m','-Dfixture.rpc='+path.join(dir,'sqlite_rpc.py'),'-cp',dir+path.delimiter+jars,'gr.argyrismitsos.fleetserver.NativeMigrationFlowTest',path.join(dir,'business.sqlite'),path.join(root,'.build/business-runtime/runtime.js'),path.join(root,'.build/business-runtime/manifest.json'),path.join(dir,'migration-app'),path.join(dir,'app/files/service-documents'),path.resolve('.build/business-build-deps/assets')],{stdio:'inherit',timeout:90000});
}finally{fs.rmSync(dir,{recursive:true,force:true});}

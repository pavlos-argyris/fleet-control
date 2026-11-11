import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
import {businessSqliteFixture} from './fixtures/business-sqlite.mjs';
import {backupBase64Fixture} from './fixtures/backup-base64.mjs';
const root=process.cwd(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-independent-business-'));
try{
 execFileSync('python3',['scripts/prepare-business-dependencies.py'],{stdio:'inherit'});execFileSync('node',['scripts/build-business-runtime.mjs'],{stdio:'inherit'});
 const files=[...businessSqliteFixture(dir),...backupBase64Fixture(dir)];
 const write=(name,text)=>{const file=path.join(dir,name);fs.writeFileSync(file,text);files.push(file);};
 write('NativeDatabaseSnapshot.java','package gr.argyrismitsos.fleetserver;public class NativeDatabaseSnapshot{public static final Object OBJECT_LIFECYCLE_LOCK=new Object();}');
 write('IndependentConfig.java','package gr.argyrismitsos.fleetserver;public class IndependentConfig{static String random(){byte[] bytes=new byte[32];new java.security.SecureRandom().nextBytes(bytes);return java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);}}');
 write('IndependentBusinessTest.java',String.raw`package gr.argyrismitsos.fleetserver;
import org.json.*;import android.database.sqlite.*;import java.io.*;import java.nio.file.*;
public class IndependentBusinessTest {
 static SQLiteDatabase db;static BusinessSqlite sql;static NativeBusinessEngine engine;static int network;static boolean trusted=true;static String instance="fixture-instance";static final String realm="https://fixture.duckdns.org";
 static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 static JSONObject call(String path,String method,JSONObject body,String token,boolean internal,String operation,boolean external)throws Exception{
  JSONObject headers=new JSONObject().put("Content-Type","application/json");if(token!=null)headers.put("Authorization","Bearer "+token);if(internal)headers.put("X-Fleet-Server-Key","fixture-independent-server-key-123456");if(operation!=null)headers.put("X-Fleet-Operation",operation);
  JSONObject request=new JSONObject().put("url",realm+path).put("method",method).put("headers",headers).put("independentPeer",external?"8.8.8.8":"127.0.0.1").put("independentExternal",external);if(body!=null)request.put("body",body.toString());return engine.request(request,internal,30000);
 }
 static JSONObject call(String path,String method,JSONObject body,String token)throws Exception{return call(path,method,body,token,false,java.util.UUID.randomUUID().toString(),false);}
 static JSONObject body(JSONObject response){return new JSONObject(response.getString("body"));}
 static String mode()throws Exception{return sql.call("sql.query",new JSONObject().put("sql","SELECT mode FROM independent_instance WHERE id=1")).getJSONArray("results").getJSONObject(0).getString("mode");}
 public static void main(String[] args)throws Exception{
  db=new SQLiteDatabase(args[0]);sql=new BusinessSqlite(db);String code=new String(Files.readAllBytes(Paths.get(args[1])),"UTF-8");JSONObject manifest=new JSONObject(new String(Files.readAllBytes(Paths.get(args[2])),"UTF-8"));
  db.execSQL("CREATE TABLE independent_readiness(id INTEGER PRIMARY KEY,proof TEXT,actor_id TEXT,session_hash TEXT,peer_hash TEXT,created_at INTEGER)");db.execSQL("CREATE TABLE independent_instance(id INTEGER PRIMARY KEY,instance_id TEXT,mode TEXT,activated_at INTEGER,activated_by TEXT)");db.execSQL("INSERT INTO independent_instance VALUES(1,'fixture-instance','test',NULL,NULL)");
  JSONObject configuration=new JSONObject().put("standalone",true).put("realm",realm).put("generation","00000000-0000-4000-8000-000000000001").put("serverKey","fixture-independent-server-key-123456").put("authPepper","fixture-independent-pepper").put("eventSigningKey","fixture-independent-events-123456789");
  engine=new NativeBusinessEngine(db,new File(args[3],"documents"),new File(args[3],"temporary"),configuration,code,manifest.getString("bundleSha256"),new NativeBusinessEngine.Authority(){public void beforeRequest(JSONObject r,boolean internal){}public void beforeCommit(JSONObject r,boolean internal){}},new NativeBusinessEngine.Ports(){public JSONObject call(String command,JSONObject value,BusinessObjects objects)throws Exception{
   if(command.equals("store.context"))return new JSONObject().put("configured",false);
   if(command.equals("health.snapshot"))return new JSONObject();
   if(command.equals("independent.status"))return new JSONObject().put("instanceId",instance).put("mode",mode());
   if(command.equals("independent.probe"))return IndependentReadiness.probe(db,value,System.currentTimeMillis());
   if(command.equals("independent.activate"))return IndependentReadiness.activate(db,value,instance,trusted,System.currentTimeMillis()).put("instanceId",instance);
   network++;throw new AssertionError("unexpected outbound native capability: "+command);
  }});
  try{
   check(call("/api/status","GET",null,null).getInt("status")==200,"actual local schema initialized");
   check(call("/api/independent/status","GET",null,null).getInt("status")==401,"status requires a current account");
   JSONObject owner=new JSONObject().put("username","owner.test").put("password","Strong-Fixture-Password-2026!").put("fullName","Owner test");
   check(call("/api/auth/bootstrap","POST",owner,null,true,null,false).getInt("status")<300,"bootstrap fixture only through local capability");
   String token=body(call("/api/auth/user-login","POST",owner,null)).getString("token");
   JSONObject created=body(call("/api/admin/employees","POST",new JSONObject().put("username","employee.test").put("password","Employee-Fixture-2026!").put("fullName","Employee test").put("role","employee"),token));String employee=created.getJSONObject("employee").getString("id");
   String rider=body(call("/api/auth/user-login","POST",new JSONObject().put("username","employee.test").put("password","Employee-Fixture-2026!"),null)).getString("token");
   check(call("/api/independent/probe","POST",new JSONObject(),rider).getInt("status")==403,"employee cannot acquire owner readiness");
   check(call("/api/server/ordexa/import","POST",new JSONObject(),token).getInt("status")==403,"external owner cannot claim internal server key");
   JSONObject local=body(call("/api/independent/probe","POST",new JSONObject(),token));check(local.getBoolean("writeRollback")&&!local.getBoolean("externalVerified")&&local.getString("proof").isEmpty(),"actual local write/rollback cannot claim external proof");
   check(sql.call("sql.query",new JSONObject().put("sql","SELECT name FROM sqlite_master WHERE name='independent_rollback_probe'")).getJSONArray("results").length()==0,"probe table really rolled back");
   JSONObject attempt=new JSONObject().put("proof","").put("confirm","ΕΝΕΡΓΟΠΟΙΗΣΗ").put("oldProductionStopped",true).put("mobileDataTested",true);
   check(call("/api/independent/activate","POST",attempt,token).getInt("status")==409&&mode().equals("test"),"localhost cannot activate");
   JSONObject remote=body(call("/api/independent/probe","POST",new JSONObject(),token,false,java.util.UUID.randomUUID().toString(),true));check(remote.getBoolean("externalVerified"),"synthetic public peer is explicitly fixture evidence");attempt.put("proof",remote.getString("proof"));
   trusted=false;check(call("/api/independent/activate","POST",attempt,token).getInt("status")==409&&mode().equals("test"),"untrusted certificate cannot activate");trusted=true;
   attempt.put("mobileDataTested",false);check(call("/api/independent/activate","POST",attempt,token).getInt("status")==409,"owner must attest actual mobile-data network");attempt.put("mobileDataTested",true);
   db.execSQL("UPDATE independent_readiness SET created_at=0");check(call("/api/independent/activate","POST",attempt,token).getInt("status")==409,"expired proof cannot activate");
   remote=body(call("/api/independent/probe","POST",new JSONObject(),token,false,java.util.UUID.randomUUID().toString(),true));attempt.put("proof",remote.getString("proof"));
   String second=body(call("/api/auth/user-login","POST",owner,null)).getString("token");check(call("/api/independent/activate","POST",attempt,second).getInt("status")==409,"proof is bound to the actual owner session");
   String fail=java.util.UUID.randomUUID().toString();db.execSQL("CREATE TRIGGER independent_receipt_failure BEFORE INSERT ON native_operation_receipts WHEN NEW.operation_id='"+fail+"' BEGIN SELECT RAISE(ABORT,'fixture receipt failure'); END");
   check(call("/api/independent/activate","POST",attempt,token,false,fail,true).getInt("status")==500&&mode().equals("test"),"activation rolls back with receipt failure");db.execSQL("DROP TRIGGER independent_receipt_failure");
   String operation=java.util.UUID.randomUUID().toString();JSONObject activated=call("/api/independent/activate","POST",attempt,token,false,operation,true);check(activated.getInt("status")==200&&body(activated).getBoolean("activated")&&!body(activated).getBoolean("cloudChanged")&&mode().equals("primary"),"explicit owner activation affects only transactional local mode");
   JSONObject replay=call("/api/independent/activate","POST",attempt,token,false,operation,true);check(replay.getString("body").equals(activated.getString("body"))&&replay.getJSONObject("headers").getString("x-fleet-replayed").equals("1"),"lost activation ACK replays the same receipt");
   for(int i=0;i<31;i++)check(call("/api/auth/user-login","POST",owner,null).getInt("status")==200,"30+ actual sessions");
   java.util.List<Thread> clients=new java.util.ArrayList<Thread>();java.util.concurrent.atomic.AtomicReference<Throwable> failure=new java.util.concurrent.atomic.AtomicReference<Throwable>();for(int i=0;i<8;i++){Thread client=new Thread(()->{try{for(int j=0;j<5;j++)check(call("/api/admin/employees","GET",null,token).getInt("status")==200,"concurrent client read");}catch(Throwable error){failure.set(error);}});clients.add(client);client.start();}for(Thread client:clients)client.join();if(failure.get()!=null)throw new AssertionError(failure.get());
   check(call("/api/admin/employees/"+employee,"PUT",new JSONObject().put("active",false),token).getInt("status")==200,"owner revokes employee");check(call("/api/auth/me","GET",null,rider).getInt("status")==401,"local revocation immediate");
   check(call("/api/auth/user-logout","POST",new JSONObject(),token).getInt("status")==200,"logout supported");check(call("/api/independent/probe","POST",new JSONObject(),token).getInt("status")==401,"revoked owner cannot reuse readiness");
   check(network==0,"zero Cloudflare/external capability calls in actual local runtime scenario");
   System.out.println("PASS real Java/Rhino/SQLite independent auth, roles, 30+ sessions and 8 concurrent clients, real probe write/rollback, localhost/stale/session/TLS/confirmation gates, atomic activation+audit+receipt failure and ACK replay, immediate revocation; outbound capabilities=0. Public peer is synthetic; physical 4G/Android acceptance remains pending.");
  }finally{engine.close();db.close();}
 }
}`);
 const native=['NativeBusinessEngine','BusinessRuntime','BusinessPrimitives','BusinessSqlite','BusinessObjects','BusinessActor'];
 files.push(...native.map(n=>path.join(root,'server-android/src/gr/argyrismitsos/fleetserver',n+'.java')),...['IndependentPolicy','IndependentReadiness'].map(n=>path.join(root,'independent-android/src/gr/argyrismitsos/fleetserver',n+'.java')));
 const jars=path.resolve('vendor/json-java/json-20240303.jar')+path.delimiter+path.resolve('.build/runtime-deps/rhino-1.9.1.jar');
 execFileSync('java',['-jar',path.resolve('.android-toolchain/usr/share/java/eclipse-jdt-core-3.32.0.jar'),'-proc:none','-source','8','-target','8','-nowarn','-encoding','UTF-8','-cp',jars,'-d',dir,...files],{stdio:'inherit'});
 execFileSync('java',['-Xmx384m','-Dfixture.rpc='+path.join(dir,'sqlite_rpc.py'),'-cp',dir+path.delimiter+jars,'gr.argyrismitsos.fleetserver.IndependentBusinessTest',path.join(dir,'business.sqlite'),path.resolve('.build/business-runtime/runtime.js'),path.resolve('.build/business-runtime/manifest.json'),dir],{stdio:'inherit',timeout:180000});
}finally{fs.rmSync(dir,{recursive:true,force:true});}

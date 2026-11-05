import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
import {businessSqliteFixture} from './fixtures/business-sqlite.mjs';
const root=process.cwd(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-business-'));
try{
 execFileSync('python3',['scripts/prepare-business-dependencies.py'],{stdio:'inherit'});
 execFileSync('node',['scripts/build-business-runtime.mjs'],{stdio:'inherit'});
 const files=businessSqliteFixture(dir),write=(name,text)=>fs.writeFileSync(path.join(dir,name),text);
 write('BusinessTest.java',String.raw`package gr.argyrismitsos.fleetserver;
import org.json.*;import android.database.sqlite.*;import android.database.Cursor;import java.nio.file.*;import java.io.*;
public class BusinessTest{
 static String lastError="";static BusinessRuntime runtime;static SQLiteDatabase db;
 static void check(boolean b,String message){if(!b)throw new AssertionError(message);}
 static JSONObject call(String path,String method,Object body,boolean internal,String token)throws Exception{
  JSONObject headers=new JSONObject().put("Content-Type","application/json");if(internal)headers.put("X-Fleet-Server-Key","fixture-server-key-at-least-32-bytes");if(token!=null)headers.put("Authorization","Bearer "+token);
  JSONObject request=new JSONObject().put("url","https://fleet.fixture.invalid"+path).put("method",method).put("headers",headers);if(body!=null)request.put("body",body.toString());
  JSONObject response=runtime.request(request,internal,30000);if(response.optInt("status")>=500)throw new AssertionError("API "+path+" failed "+response+" native="+lastError);return response;
 }
 public static void main(String[] args)throws Exception{db=new SQLiteDatabase(args[0]);final BusinessSqlite sql=new BusinessSqlite(db);
  try{
   String code=new String(Files.readAllBytes(Paths.get(args[1])),"UTF-8");JSONObject manifest=new JSONObject(new String(Files.readAllBytes(Paths.get(args[2])),"UTF-8"));
   runtime=new BusinessRuntime(new BusinessRuntime.Host(){public String call(String command,String raw)throws Exception{try{JSONObject data=new JSONObject(raw),value=command.startsWith("sql.")?sql.call(command,data):BusinessPrimitives.call(command,data);if(value==null){if(command.equals("objects.get"))value=new JSONObject().put("exists",false);else throw new IOException("unsupported fixture capability "+command);}return value.toString();}catch(Exception e){lastError=command+": "+e.getMessage();throw e;}}},code,manifest.getString("bundleSha256"),new JSONObject().put("realm","https://fleet.fixture.invalid").put("serverKey","fixture-server-key-at-least-32-bytes").put("authPepper","fixture-private-pepper"));
   JSONObject sandbox=runtime.sandboxStatus();for(String key:sandbox.keySet())check("undefined".equals(sandbox.getString(key)),"Java/file reflection is unavailable: "+key);
   check(call("/api/status","GET",null,false,null).getInt("status")==200,"actual shared status on local SQLite");
   check(call("/api/admin/employees","GET",null,false,null).getInt("status")==401,"native API preserves login gate");
   JSONObject owner=new JSONObject().put("fullName","Συνθετικός ιδιοκτήτης").put("username","owner.fixture").put("password","Fixture-Secret-2026!").put("deviceId","native-fixture");
   JSONObject bootstrap=call("/api/auth/bootstrap","POST",owner,true,null);check(bootstrap.getInt("status")==200||bootstrap.getInt("status")==201,"owner bootstrap "+bootstrap);
   JSONObject login=call("/api/auth/user-login","POST",new JSONObject().put("username","owner.fixture").put("password","Fixture-Secret-2026!").put("deviceId","native-fixture"),false,null);check(login.getInt("status")==200,"actual PBKDF2 native login "+login);String token=new JSONObject(login.getString("body")).getString("token");
   JSONObject staff=call("/api/admin/employees","GET",null,false,token);check(staff.getInt("status")==200,"native authenticated staff API");
   JSONObject created=call("/api/admin/employees","POST",new JSONObject().put("fullName","Δοκιμή διανομέα").put("username","rider.fixture").put("password","Rider-Fixture-2026!").put("role","employee"),false,token);check(created.getInt("status")==201,"actual staff mutation "+created);
   String riderId=new JSONObject(created.getString("body")).getJSONObject("employee").getString("id");
   JSONObject riderLogin=call("/api/auth/user-login","POST",new JSONObject().put("username","rider.fixture").put("password","Rider-Fixture-2026!").put("deviceId","rider-fixture"),false,null);check(riderLogin.getInt("status")==200,"rider login");String riderToken=new JSONObject(riderLogin.getString("body")).getString("token");
   check(call("/api/admin/employees","GET",null,false,riderToken).getInt("status")==403,"employee cannot manage staff");
   check(call("/api/server/ordexa/import","POST",new JSONObject(),false,token).getInt("status")==403,"public caller cannot acquire native pipeline capability");
   check(call("/api/admin/employees/"+riderId,"PUT",new JSONObject().put("active",false),false,token).getInt("status")==200,"owner disables staff account");
   check(call("/api/auth/me","GET",null,false,riderToken).getInt("status")==401,"revocation is immediate on local authority");
   JSONObject bind=sql.call("sql.query",new JSONObject().put("sql","SELECT typeof(?) integer_type,typeof(?) float_type,? greek,? flag").put("params",new JSONArray().put(123).put(1.5).put("Ελληνικά '); DROP TABLE app_users; --").put(true))).getJSONArray("results").getJSONObject(0);
   check(bind.getString("integer_type").equals("integer")&&bind.getString("float_type").equals("real")&&bind.getInt("flag")==1&&bind.getString("greek").startsWith("Ελληνικά"),"native typed binds and SQL injection isolation");
   db.execSQL("CREATE TABLE fixture_atomic(id INTEGER PRIMARY KEY,value TEXT)");
   try{sql.call("sql.batch",new JSONObject().put("queries",new JSONArray().put(new JSONObject().put("sql","INSERT INTO fixture_atomic VALUES(1,?)").put("params",new JSONArray().put("rollback"))).put(new JSONObject().put("sql","INSERT INTO table_missing VALUES(1)"))));throw new AssertionError("batch should fail");}catch(android.database.sqlite.SQLiteException expected){}
   check(sql.call("sql.query",new JSONObject().put("sql","SELECT COUNT(*) n FROM fixture_atomic")).getJSONArray("results").getJSONObject(0).getInt("n")==0,"real rollback after mid-batch failure");
   StringBuilder large=new StringBuilder();for(int i=0;i<1100000;i++)large.append("Ω€");String historical=large.toString();db.execSQL("INSERT INTO fixture_atomic VALUES(?,?)",new Object[]{7,historical});
   JSONObject historicalRow=sql.call("sql.query",new JSONObject().put("sql","SELECT id,value FROM fixture_atomic ORDER BY id")).getJSONArray("results").getJSONObject(0);check(historicalRow.getString("value").equals(historical)&&historicalRow.getInt("id")==7&&Cursor.largeRows>0,"bounded CursorWindow fallback retains historical Unicode exactly");
   check(Cursor.opened==0,"all actual SQL cursors closed");
   runtime.close();runtime=null;
   try{new BusinessRuntime((command,raw)->"{}",code,"00",new JSONObject());throw new AssertionError("corrupt bundle should be rejected");}catch(IOException expected){}
   String looping="globalThis.__fleetInit=function(){};globalThis.__fleetRequest=function(){while(true){}}";
   BusinessRuntime limited=new BusinessRuntime((command,raw)->"{}",looping,BusinessRuntime.sha256(looping.getBytes("UTF-8")),new JSONObject());long start=System.nanoTime();try{limited.request(new JSONObject(),false,100);throw new AssertionError("budget should stop interpreter");}catch(Exception expected){check((System.nanoTime()-start)/1000000<5000,"bounded interpreter budget");}finally{limited.close();}
   System.out.println("PASS actual shared business runtime: sealed Java capabilities, integrity/time budget, schema, PBKDF2 auth, staff mutation/permissions/immediate revocation, typed binds, real atomic rollback, >5 MiB historical Unicode/CursorWindow fallback and cursor cleanup. Queries="+db.queries);
  }catch(Throwable e){System.err.println(e.toString());throw e;}finally{if(runtime!=null)runtime.close();db.close();}
 }
}`);
 const names=['BusinessRuntime','BusinessPrimitives','BusinessSqlite'];files.push(path.join(dir,'BusinessTest.java'),...names.map(n=>path.join(root,'server-android/src/gr/argyrismitsos/fleetserver',n+'.java')));
 const jars=[path.join(root,'vendor/json-java/json-20240303.jar'),path.join(root,'.build/runtime-deps/rhino-1.9.1.jar')].join(path.delimiter);
 execFileSync('java',['-jar',path.join(root,'.android-toolchain/usr/share/java/eclipse-jdt-core-3.32.0.jar'),'-proc:none','-source','8','-target','8','-nowarn','-encoding','UTF-8','-classpath',jars,'-d',dir,...files],{stdio:'inherit'});
 execFileSync('java',['-Xmx384m','-Dfixture.rpc='+path.join(dir,'sqlite_rpc.py'),'-cp',dir+path.delimiter+jars,'gr.argyrismitsos.fleetserver.BusinessTest',path.join(dir,'business.sqlite'),path.join(root,'.build/business-runtime/runtime.js'),path.join(root,'.build/business-runtime/manifest.json')],{stdio:'inherit',timeout:90000});
}finally{fs.rmSync(dir,{recursive:true,force:true});}

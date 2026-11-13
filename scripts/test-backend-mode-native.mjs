import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';
const dir=path.resolve('.build/backend-mode-native');fs.mkdirSync(dir,{recursive:true});
const write=(name,text)=>{const p=path.join(dir,name);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,text);return p;};
const files=[write('android/content/pm/ApplicationInfo.java','package android.content.pm;public class ApplicationInfo{public String dataDir;}'),write('android/content/Context.java',`package android.content;public class Context{private final android.content.pm.ApplicationInfo info=new android.content.pm.ApplicationInfo();public Context(String dir){info.dataDir=dir;new java.io.File(dir,"files").mkdirs();}public Context getApplicationContext(){return this;}public android.content.pm.ApplicationInfo getApplicationInfo(){return info;}}`),write('android/system/OsConstants.java','package android.system;public class OsConstants{public static final int O_RDONLY=0;}'),write('android/system/Os.java','package android.system;public class Os{public static java.io.FileDescriptor open(String path,int flags,int mode){return new java.io.FileDescriptor();}public static void fsync(java.io.FileDescriptor fd){}public static void close(java.io.FileDescriptor fd){}}'),write('BackendModeChecks.java',String.raw`
package gr.argyrismitsos.fleetserver;
import android.content.Context;import org.json.*;import java.io.*;import java.nio.file.*;import java.util.concurrent.*;
public class BackendModeChecks {
 static void check(boolean v,String message){if(!v)throw new AssertionError(message);}
 public static void main(String[] args)throws Exception{
  Context c=new Context(args[0]);BackendMode.initialize(c);
  if(args.length>1){try(BackendMode.Guard held=BackendMode.guard(c)){System.out.println("LOCKED");System.out.flush();System.in.read();}return;}
  check(BackendMode.read(c).getString("activeMode").equals("cloudflare"),"regular update defaults Cloudflare without any HTTP");
  JSONObject preparing=BackendMode.select(c,"direct",0,false,"Synthetic certificate failure");check(preparing.getBoolean("pending")&&!BackendMode.direct(c),"failed Direct readiness preserves active cloud and records requested preparation");
  boolean conflict=false;try{BackendMode.select(c,"direct",0,true,"");}catch(IOException expected){conflict=true;}check(conflict,"duplicate old command rejected");
  String java=new File(System.getProperty("java.home"),"bin/java").getPath();Process child=new ProcessBuilder(java,"-cp",System.getProperty("java.class.path"),BackendModeChecks.class.getName(),args[0],"hold").redirectError(ProcessBuilder.Redirect.INHERIT).start();
  check(new BufferedReader(new InputStreamReader(child.getInputStream())).readLine().equals("LOCKED"),"separate process holds actual OS shared lock");
  ExecutorService pool=Executors.newSingleThreadExecutor();Future<JSONObject> change=pool.submit(()->BackendMode.select(c,"direct",1,true,""));Thread.sleep(100);check(!change.isDone(),"mode waits for an in-flight operation in the other process");child.getOutputStream().write(1);child.getOutputStream().flush();check(child.waitFor(5,TimeUnit.SECONDS),"other process released");check(change.get(5,TimeUnit.SECONDS).getString("activeMode").equals("direct"),"atomic persistent activation");pool.shutdownNow();
  boolean fenced=false;try(BackendMode.Guard cloud=BackendMode.cloudRequest()){}catch(IOException expected){fenced=true;}check(fenced,"old cloud request blocked before send");
  check(new JSONObject(new String(Files.readAllBytes(Paths.get(args[0],"files/backend-mode.json")),"UTF-8")).getLong("revision")==2,"restart reads persisted revision");
  check(BackendMode.select(c,"cloudflare",2,true,"").getString("activeMode").equals("cloudflare"),"manual rollback makes zero backend requests");
  Files.write(Paths.get(args[0],"files/backend-mode.json"),"corrupt".getBytes("UTF-8"));check(BackendMode.direct(c),"corrupt selection must never resume cloud writes");
  System.out.println("PASS actual Java/file-lock mode storage: default, preparation, CAS/duplicate, cross-process commit drain, restart, offline manual return, fail-closed corruption. Android directory fsync is exercised separately in instrumentation.");
 }
}`)];
const json=path.resolve('vendor/json-java/json-20240303.jar'),ecj=path.resolve('.android-toolchain/usr/share/java/eclipse-jdt-core-3.32.0.jar');
const compiler=fs.existsSync(ecj)?['java',['-jar',ecj]]:['javac',[]];
files.push(write('android/content/SharedPreferences.java',`package android.content;import java.util.*;public class SharedPreferences{private final Map<String,String> values=new HashMap<>();public String getString(String key,String fallback){return values.containsKey(key)?values.get(key):fallback;}public Editor edit(){return new Editor();}public class Editor{public Editor putString(String key,String value){values.put(key,value);return this;}public boolean commit(){return true;}}}`));
write('android/content/Context.java',`package android.content;import java.util.*;public class Context{public static final int MODE_PRIVATE=0;private final android.content.pm.ApplicationInfo info=new android.content.pm.ApplicationInfo();private final Map<String,SharedPreferences> prefs=new HashMap<>();public Context(String dir){info.dataDir=dir;new java.io.File(dir,"files").mkdirs();}public Context getApplicationContext(){return this;}public android.content.pm.ApplicationInfo getApplicationInfo(){return info;}public SharedPreferences getSharedPreferences(String name,int mode){if(!prefs.containsKey(name))prefs.put(name,new SharedPreferences());return prefs.get(name);}}`);
files.push(write('DirectOnlyChecks.java',String.raw`
package gr.argyrismitsos.fleetserver;
import android.content.Context;import org.json.*;import java.nio.file.*;import java.io.*;
public class DirectOnlyChecks{
 static void check(boolean v,String m){if(!v)throw new AssertionError(m);}
 public static void main(String[] args)throws Exception{
  Context c=new Context(args[0]);BackendMode.initialize(c);Path file=Paths.get(args[0],"files/backend-mode.json");
  check(BackendMode.direct(c)&&BackendMode.read(c).getBoolean("directOnly")&&BackendMode.read(c).getBoolean("pending")&&!BackendMode.approved(c),"Fresh normal update selects Direct preparation without approving business writes");
  JSONObject old=new JSONObject().put("schema",1).put("revision",7).put("activeMode","cloudflare").put("selectedMode","cloudflare").put("cloudUrl",BackendMode.CLOUD).put("directUrl",BackendMode.DIRECT);
  Files.write(file,old.toString().getBytes("UTF-8"));byte[] preserved=Files.readAllBytes(file);
  check(BackendMode.read(c).getString("activeMode").equals("direct")&&!BackendMode.approved(c),"Old persisted Cloud selection cannot start Cloud work or approve Direct");
  check(java.util.Arrays.equals(preserved,Files.readAllBytes(file)),"Reading effective policy preserves dormant selection bytes");
  try{BackendMode.select(c,"cloudflare",7,true,"");throw new AssertionError("Cloud option accepted");}catch(IOException expected){}
  check(java.util.Arrays.equals(preserved,Files.readAllBytes(file)),"Rejected Cloud command does not rewrite stored state");
  try(BackendMode.Guard ignored=BackendMode.cloudRequest()){throw new AssertionError("Cloud request sent");}catch(IOException expected){}
  BackendMode.select(c,"direct",7,true,"");check(BackendMode.approved(c)&&!BackendMode.read(c).getBoolean("pending"),"Explicit trusted readiness is atomic/persistent");
  old.put("activeMode","direct").put("selectedMode","direct");Files.write(file,old.toString().getBytes("UTF-8"));check(BackendMode.approved(c),"Previously owner-approved Direct stays approved across the update");
  Files.write(file,"corrupt".getBytes("UTF-8"));check(BackendMode.direct(c)&&!BackendMode.approved(c),"Corrupt control state fails closed without Cloud or trusted business writes");
  System.out.println("PASS actual native Direct-only policy: fresh/legacy defaults, dormant state preservation, disabled Cloud, approval/restart and fail-closed corruption.");
 }
}`));
files.push(write('ClientPolicyChecks.java',String.raw`
package gr.argyrismitsos.fleetcontrol;
import android.content.*;import org.json.*;
public class ClientPolicyChecks{
 static void check(boolean v,String m){if(!v)throw new AssertionError(m);}
 public static void main(String[] args)throws Exception{
  Context c=new Context(args[0]);check(BackendSelection.direct(c)&&BackendSelection.apiBase(c).equals(BackendSelection.DIRECT),"Fresh Client defaults Direct without a network request");
  String old=new JSONObject().put("schema",1).put("revision",4).put("activeMode","cloudflare").put("selectedMode","cloudflare").put("cloudUrl","https://fleet-control.pavlosargyris.workers.dev").put("directUrl",BackendSelection.DIRECT).toString();
  SharedPreferences prefs=c.getSharedPreferences("fleet_backend_selection",0);prefs.edit().putString("selection",old).commit();
  c.getSharedPreferences("sessions",0).edit().putString("auth_token","cloud-token-sentinel").commit();
  check(BackendSelection.direct(c)&&new JSONObject(BackendSelection.read(c)).getString("activeMode").equals("direct")&&BackendSelection.tokenKey(c).equals("auth_token_direct"),"Stored Cloud metadata never selects Cloud or borrows its token");
  try{BackendSelection.save(c,old);throw new AssertionError("Cloud selection accepted");}catch(SecurityException expected){}
  check(prefs.getString("selection","").equals(old)&&c.getSharedPreferences("sessions",0).getString("auth_token","").equals("cloud-token-sentinel"),"Dormant selection and Cloud session remain intact");
  System.out.println("PASS actual native Client Direct-only routing, legacy metadata/token separation and rejected Cloud selection.");
 }
}`));
const mode='server-android/src/gr/argyrismitsos/fleetserver/BackendMode.java',client='client-android/src/gr/argyrismitsos/fleetcontrol/BackendSelection.java';
const compile=(output,policy)=>execFileSync(compiler[0],[...compiler[1],'-proc:none','-source','8','-target','8','-nowarn','-cp',json,'-d',output,...files,mode,client,policy],{stdio:'inherit'});
const run=(output,name)=>execFileSync('java',['-cp',output+path.delimiter+json,name,fs.mkdtempSync(path.join(dir,'state-'))],{stdio:'inherit'});
compile(dir,'common-android/src/gr/argyrismitsos/fleetupdates/BackendPolicy.java');
run(dir,'gr.argyrismitsos.fleetserver.DirectOnlyChecks');run(dir,'gr.argyrismitsos.fleetcontrol.ClientPolicyChecks');
// Exercise the retained switch with an explicitly dormant test build policy.
// The released APK and the two tests above always use the production class.
const legacy=path.join(dir,'dormant');fs.mkdirSync(legacy,{recursive:true});
compile(legacy,write('fixture-policy/BackendPolicy.java','package gr.argyrismitsos.fleetupdates;public final class BackendPolicy{public static final boolean DIRECT_ONLY=false;}'));
run(legacy,'gr.argyrismitsos.fleetserver.BackendModeChecks');

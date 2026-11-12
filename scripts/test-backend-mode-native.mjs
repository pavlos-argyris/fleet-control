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
execFileSync(compiler[0],[...compiler[1],'-proc:none','-source','8','-target','8','-nowarn','-cp',json,'-d',dir,...files,'server-android/src/gr/argyrismitsos/fleetserver/BackendMode.java'],{stdio:'inherit'});
const data=fs.mkdtempSync(path.join(dir,'state-'));execFileSync('java',['-cp',dir+path.delimiter+json,'gr.argyrismitsos.fleetserver.BackendModeChecks',data],{stdio:'inherit'});

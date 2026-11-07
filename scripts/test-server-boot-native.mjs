import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {inspectAndroidManifest} from './android-manifest-audit.mjs';
const root=process.cwd(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-boot-guard-'));
try {
  const files={
    'BroadcastReceiver.java':'package android.content;public abstract class BroadcastReceiver{public abstract void onReceive(Context context,Intent intent);}',
    'Intent.java':'package android.content;public class Intent{public static final String ACTION_BOOT_COMPLETED="android.intent.action.BOOT_COMPLETED",ACTION_MY_PACKAGE_REPLACED="android.intent.action.MY_PACKAGE_REPLACED";private String action;public Intent(String s){action=s;}public Intent(Context c,Class<?> cls){}public String getAction(){return action;}}',
    'Context.java':'package android.content;public class Context{public static final int MODE_PRIVATE=0;public boolean automatic=true;public int reads,background,foreground;public SharedPreferences getSharedPreferences(String n,int mode){reads++;return new SharedPreferences(this);}public void startService(Intent intent){background++;}public void startForegroundService(Intent intent){foreground++;}}',
    'SharedPreferences.java':'package android.content;public class SharedPreferences{final Context c;public SharedPreferences(Context c){this.c=c;}public boolean getBoolean(String name,boolean fallback){if(!name.equals("automatic_start"))throw new AssertionError(name);return c.automatic;}}',
    'Build.java':'package android.os;public class Build{public static class VERSION{public static int SDK_INT=23;}}',
    'BackupManager.java':'package gr.argyrismitsos.fleetserver;public class BackupManager{public static final String PREFS="fixture";}',
    'SyncService.java':'package gr.argyrismitsos.fleetserver;public class SyncService{}',
    'NativeColdRuntime.java':'package gr.argyrismitsos.fleetserver;import android.content.Context;public class NativeColdRuntime{public static boolean pending;public static boolean blocked(Context c){return pending;}}',
    'BootTest.java':String.raw`import android.content.*;import android.os.Build;import gr.argyrismitsos.fleetserver.BootReceiver;
public class BootTest{
 static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 public static void main(String[] args){BootReceiver receiver=new BootReceiver();
  for(Intent intent:new Intent[]{null,new Intent((String)null),new Intent("untrusted.START_SERVER"),new Intent("android.intent.action.PACKAGE_REPLACED")}){
   Context c=new Context();receiver.onReceive(c,intent);check(c.reads==0&&c.background==0&&c.foreground==0,"Unknown/null broadcasts must not access preferences or start Server");
  }
  for(int sdk:new int[]{23,34})for(String action:new String[]{Intent.ACTION_BOOT_COMPLETED,Intent.ACTION_MY_PACKAGE_REPLACED}){
   Build.VERSION.SDK_INT=sdk;Context c=new Context();receiver.onReceive(c,new Intent(action));
   check(c.reads==1,"known boot action reads the stored preference");
   check(sdk>=26?c.foreground==1&&c.background==0:c.background==1&&c.foreground==0,"correct service API for SDK "+sdk);
   c=new Context();c.automatic=false;receiver.onReceive(c,new Intent(action));check(c.background+c.foreground==0,"automatic start off remains off");
  }
  gr.argyrismitsos.fleetserver.NativeColdRuntime.pending=true;Context blocked=new Context();receiver.onReceive(blocked,new Intent(Intent.ACTION_BOOT_COMPLETED));check(blocked.background+blocked.foreground==0,"pending cold restore never starts a foreground service before verified apply");
  System.out.println("PASS native boot guard: only boot/own-package replacement, null/unknown actions rejected before any side effect, pending cold restore blocks service launch, existing automatic-start preference and SDK23/34 service branches preserved.");
 }
}`
  };
  for(const [name,body]of Object.entries(files))fs.writeFileSync(path.join(dir,name),body);
  execFileSync('java',['-jar',path.join(root,'.android-toolchain/usr/share/java/eclipse-jdt-core-3.32.0.jar'),'-proc:none','-source','8','-target','8','-nowarn','-encoding','UTF-8','-d',dir,...Object.keys(files).map(f=>path.join(dir,f)),path.join(root,'server-android/src/gr/argyrismitsos/fleetserver/BootReceiver.java')],{stdio:'inherit'});
  execFileSync('java',['-cp',dir,'BootTest'],{stdio:'inherit',timeout:10000});
  for(const p of ['server-android/AndroidManifest.xml','client-android/AndroidManifest.xml']){
    const exported=inspectAndroidManifest(fs.readFileSync(p,'utf8')).exportedComponents;
    assert.deepEqual(exported,[{type:'activity',name:'.MainActivity'}],p+': only launcher is externally exported');
  }
} finally {fs.rmSync(dir,{recursive:true,force:true});}

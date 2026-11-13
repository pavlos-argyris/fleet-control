package gr.argyrismitsos.fleetdirect;
import android.content.*;import android.net.Uri;import org.json.*;import java.io.*;import java.util.*;import java.util.zip.*;
import gr.argyrismitsos.fleetserver.BackendMode;

/** Disposable emulator-only tests of the shipped native Direct controls. */
public final class UnifiedNativeChecks{
    private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    private static String read(InputStream input)throws Exception{try(InputStream in=input;ByteArrayOutputStream out=new ByteArrayOutputStream()){byte[] b=new byte[8192];int n;while((n=in.read(b))!=-1){if(out.size()+n>2*1024*1024)throw new IOException("Fixture response too large");out.write(b,0,n);}return out.toString("UTF-8");}}
    private static MainActivity fixtureActivity(Context base)throws Exception{
        // Android Activity construction belongs to its main Looper, even when
        // no window/WebView is needed for a real compiled bridge invocation.
        java.util.concurrent.FutureTask<MainActivity> task=new java.util.concurrent.FutureTask<>(()->{
            MainActivity activity=new MainActivity();java.lang.reflect.Method attach=MainActivity.class.getDeclaredMethod("attachBaseContext",Context.class);attach.setAccessible(true);attach.invoke(activity,base);return activity;
        });
        new android.os.Handler(android.os.Looper.getMainLooper()).post(task);
        return task.get(20,java.util.concurrent.TimeUnit.SECONDS);
    }
    static void checkFreshDashboard(Context base,Context scope)throws Exception{
        MainActivity activity=fixtureActivity(base);
        java.lang.reflect.Field prefs=MainActivity.class.getDeclaredField("preferences");prefs.setAccessible(true);prefs.set(activity,activity.getSharedPreferences(BackupManager.PREFS,0));
        JSONObject dashboard=new JSONObject(activity.new ServerBridge().getDashboard());
        check(dashboard.optBoolean("settingsLoaded")&&dashboard.optBoolean("directPreparing")&&!dashboard.has("dashboardError"),"Fresh Direct dashboard loads preparation without a database or owner credentials: "+dashboard.optString("dashboardError"));
        check(!scope.getDatabasePath(NativeColdRestore.DATABASE_NAME).exists(),"Opening the fresh Server UI must not create an empty database that blocks first backup import");
        stopFixtureProvider(base);
        android.util.Log.i("FleetSqliteTest","PASS fresh real generated dashboard before first import: Direct preparation, real provider and no premature database");
    }
    private static void stopFixtureProvider(Context base)throws Exception{
        android.app.ActivityManager manager=(android.app.ActivityManager)base.getSystemService(Context.ACTIVITY_SERVICE);
        if(manager!=null&&manager.getRunningAppProcesses()!=null)for(android.app.ActivityManager.RunningAppProcessInfo process:manager.getRunningAppProcesses())if(process.uid==android.os.Process.myUid()&&process.processName.equals(base.getPackageName()+":direct")){android.os.Process.killProcess(process.pid);Thread.sleep(150);}
    }
    static void run(Context base,Context target,Uri manifest,JSONObject owner,String password)throws Exception{
        android.content.SharedPreferences sessions=base.getSharedPreferences("issue95_session_vault",0);String sample="synthetic-client-session-2026-only";
        sessions.edit().putString("cloud",sample).commit();
        check(gr.argyrismitsos.fleetupdates.SessionVault.read(base,sessions,"cloud",gr.argyrismitsos.fleetupdates.SessionVault.CLOUD).equals(sample)&&!sessions.contains("cloud"),"Legacy remembered token migrates atomically to Android Keystore ciphertext");
        gr.argyrismitsos.fleetupdates.SessionVault.save(base,sessions,"direct",gr.argyrismitsos.fleetupdates.SessionVault.DIRECT,sample+"-direct");
        check(!sessions.getString("direct.sealed","").contains(sample),"No plaintext Direct token in preferences");
        check(gr.argyrismitsos.fleetupdates.SessionVault.read(base,sessions,"direct",gr.argyrismitsos.fleetupdates.SessionVault.DIRECT).equals(sample+"-direct"),"Real Android Keystore token survives reopen");
        sessions.edit().putString("direct.sealed",sessions.getString("cloud.sealed","")).commit();
        check(gr.argyrismitsos.fleetupdates.SessionVault.read(base,sessions,"direct",gr.argyrismitsos.fleetupdates.SessionVault.DIRECT).isEmpty(),"Ciphertext copied across realms/names fails closed");
        check(gr.argyrismitsos.fleetupdates.SessionVault.read(base,sessions,"cloud",gr.argyrismitsos.fleetupdates.SessionVault.CLOUD).equals(sample),"Wrong-realm attempt does not clear the other realm");
        check(gr.argyrismitsos.fleetupdates.SessionVault.pageRealm("file:///android_asset/www/portal.html").equals(gr.argyrismitsos.fleetupdates.SessionVault.CLOUD)&&gr.argyrismitsos.fleetupdates.SessionVault.pageRealm("https://fleet-control.duckdns.org/fleet.html").equals(gr.argyrismitsos.fleetupdates.SessionVault.DIRECT)&&gr.argyrismitsos.fleetupdates.SessionVault.pageRealm("https://fleet-control.duckdns.org.attacker.invalid/").isEmpty(),"Page-bound token realm accepts only the two trusted origins/assets");
        String sealedName="issue95.scope.fixture",sealedAlias="fleet.issue95.scope.fixture";
        gr.argyrismitsos.fleetserver.SealedLocalState.write(base,sealedName,sealedAlias,new JSONObject().put("value","cloud-secret"));
        SealedLocalState.write(target,sealedName,sealedAlias,new JSONObject().put("value","direct-secret"));
        java.security.KeyStore keys=java.security.KeyStore.getInstance("AndroidKeyStore");keys.load(null);
        check(keys.containsAlias(sealedAlias)&&keys.containsAlias("fleet.unified-direct."+sealedAlias),"Cloud and Direct use different actual Android Keystore wrapping keys");
        target.getSharedPreferences("fleet_sealed_runtime_v1",0).edit().putString(sealedName,base.getSharedPreferences("fleet_sealed_runtime_v1",0).getString(sealedName,"")).commit();
        try{SealedLocalState.read(target,sealedName,sealedAlias);throw new AssertionError("Direct decrypted Cloud ciphertext with a shared key");}catch(java.security.GeneralSecurityException expected){}
        check(gr.argyrismitsos.fleetserver.SealedLocalState.read(base,sealedName,sealedAlias).getString("value").equals("cloud-secret"),"Direct cannot read or invalidate the Cloud secret");
        try{IndependentConfig.read(base);throw new AssertionError("Direct accepted unscoped Cloud context");}catch(SecurityException expected){}
        check(BackendMode.direct(base)&&!BackendMode.approved(base),"Normal update defaults Direct preparation without approving business writes");
        try(android.database.sqlite.SQLiteDatabase db=base.openOrCreateDatabase("issue95-cloud-sentinel.db",0,null)){db.execSQL("CREATE TABLE keep(value TEXT)");db.execSQL("INSERT INTO keep VALUES('cloud-intact')");}
        SharedPreferences root=base.getSharedPreferences(BackupManager.PREFS,0),prefs=target.getSharedPreferences(BackupManager.PREFS,0);
        root.edit().putString("worker_url","https://cloud-sentinel.invalid").putInt(BackupManager.KEY_HOUR,22).putBoolean("automatic_backup",false).commit();
        prefs.edit().putBoolean("automatic_start",false).putBoolean("automatic_ota",false).commit();
        check(BackupProtection.state(target).getBoolean("enabled"),"Import installs a Keystore-wrapped backup key for unattended backups without storing the password");
        IndependentRuntime runtime=IndependentRuntime.get(target);
        try{
            try{DirectHost.confirmReadiness(target,runtime);throw new AssertionError("Untrusted TLS/local probe approved business writes");}catch(IOException expected){}
            check(!BackendMode.approved(base),"Direct-only default never bypasses TLS/external owner proof");
            // Internal backup operations work while Cloudflare is unavailable;
            // the synthetic selected-mode command does not exercise TLS readiness.
            BackendMode.select(base,"direct",BackendMode.read(base).getLong("revision"),true,"");
            long transfersBefore;
            try(FleetDataStore store=new FleetDataStore(target)){transfersBefore=new BusinessSqlite(store.getReadableDatabase()).call("sql.query",new JSONObject().put("sql","SELECT count(*) n FROM native_file_transfers")).getJSONArray("results").getJSONObject(0).getLong("n");}
            InputStream changingSource=new ByteArrayInputStream("synthetic invoice".getBytes("UTF-8")){
                private boolean changed;
                @Override public synchronized int read(byte[] bytes,int offset,int length){
                    if(!changed){changed=true;try{BackendMode.select(base,"direct",BackendMode.read(base).getLong("revision"),true,"");BackendMode.select(base,"direct",BackendMode.read(base).getLong("revision"),true,"");}catch(Exception e){throw new IllegalStateException(e);}}
                    return super.read(bytes,offset,length);
                }
            };
            try{runtime.request(runtime.realm()+"/api/fixture-upload","POST",null,null,changingSource,17,"application/pdf",null,null);throw new AssertionError("Upload from an old mode revision reached the file importer");}catch(IOException expected){check(expected.getMessage()!=null&&expected.getMessage().contains("Η λειτουργία άλλαξε"),"Stale upload rejected by the mode fence before the business request: "+expected.getMessage());}
            try(FleetDataStore store=new FleetDataStore(target)){check(transfersBefore==new BusinessSqlite(store.getReadableDatabase()).call("sql.query",new JSONObject().put("sql","SELECT count(*) n FROM native_file_transfers")).getJSONArray("results").getJSONObject(0).getLong("n"),"Mode switch while reading an upload creates no private transfer/financial write");}
            try(FleetDataStore store=new FleetDataStore(target)){
                String manual=BackupManager.createBackup(target,store);
                check(manual.endsWith(".fcbackup"),"Normal native manual backup exports a full FCB3 packet through real SAF");
                String first=prefs.getString(BackupManager.KEY_LAST_URI,"");check(!first.isEmpty(),"Backup export records the Direct URI/ledger");
                JSONObject verified=BackupManager.verifyAndRemember(target,Uri.parse(first),password);
                check(verified.getBoolean("readable")&&verified.getBoolean("complete")&&verified.getBoolean("documentsVerified"),"Exported backup read-back verification succeeds");
                prefs.edit().putBoolean("automatic_backup",true).putInt(BackupManager.KEY_HOUR,0).putString(BackupManager.KEY_FREQUENCY,"daily").putString(BackupManager.KEY_LAST_DAY,"").putLong("backup_automatic_attempt",0).commit();
                BackupManager.maybeAutomatic(target,store);
                check(!prefs.getString(BackupManager.KEY_LAST_DAY,"").isEmpty()&&!first.equals(prefs.getString(BackupManager.KEY_LAST_URI,"")),"Scheduled automatic Direct backup exports and records another verified packet");
            }
            check(root.getInt(BackupManager.KEY_HOUR,0)==22&&!root.getBoolean("automatic_backup",true)&&root.getString("worker_url","").equals("https://cloud-sentinel.invalid"),"Native Direct settings/backups never rewrite Cloud preferences");
            JSONObject preview=NativeRecoveryController.preview(target,manifest,password);
            check(preview.getBoolean("restoreVerified")&&preview.getBoolean("documentsVerified"),"Normal full-recovery preview actually restores encrypted database/documents");
            String ownerId="";JSONArray accounts=preview.getJSONArray("accounts");for(int i=0;i<accounts.length();i++)if(accounts.getJSONObject(i).optString("role").equals("owner"))ownerId=accounts.getJSONObject(i).getString("id");
            String previousGeneration=IndependentConfig.read(target).getString("generation");
            JSONObject prepared=NativeRecoveryController.prepare(target,new JSONObject().put("previewId",preview.getString("previewId")).put("ownerId",ownerId).put("accountsReviewed",true).put("backupCodeSaved",true).put("replaceConfirmed",true));
            check(prepared.getBoolean("restartRequired")&&DirectHost.paused(target),"Prepared replacement fences further writes until explicit cold restart");
            try{BackendMode.select(base,"cloudflare",BackendMode.read(base).getLong("revision"),true,"");throw new AssertionError("Dormant Cloud mode was selectable");}catch(IOException expected){}
            runtime.close();runtime=null;
            NativeColdRuntime.applyIfPending(target);check(!NativeColdRuntime.blocked(target)&&NativeColdRuntime.core(target).state().getString("phase").equals("installed"),"Cold apply installs only scoped Direct directories");
            check(!IndependentConfig.read(target).getString("generation").equals(previousGeneration),"Recovery rotates Direct generation");
            File oldDb=new File(NativeColdRuntime.core(target).directory(preview.getString("previewId")),"old-databases/"+NativeColdRestore.DATABASE_NAME);check(oldDb.isFile(),"Previous Direct database retained after replacement");
            runtime=IndependentRuntime.get(target);
            JSONObject finished=NativeRecoveryController.finish(target);check(finished.getBoolean("newBackupVerified")&&!DirectHost.paused(target),"Recovery completes only after a new portable full backup/proof");
            check(BackendMode.direct(base),"Recovery keeps Direct; dormant Cloud selection stays disabled");
            JSONObject login=runtime.localLogin(owner.getString("username"),owner.getString("password"));check(login.getInt("status")==200,"Original owner password still works after recovery; new sessions required");
            try(android.database.sqlite.SQLiteDatabase db=base.openOrCreateDatabase("issue95-cloud-sentinel.db",0,null);android.database.Cursor cursor=db.rawQuery("SELECT value FROM keep",null)){check(cursor.moveToFirst()&&cursor.getString(0).equals("cloud-intact"),"Cold Direct replacement leaves actual Cloud database directory intact");}
            BackendMode.select(base,"direct",BackendMode.read(base).getLong("revision"),true,"");
            JSONObject catalogue=UpdateManager.listReleases(target);check(catalogue.getJSONArray("releases").length()>=3,"Normal Updates controls show bundled Client/Web/Server in Direct");
            JSONObject client=UpdateManager.uploadClientApk(target,Uri.fromFile(new File(target.getFilesDir(),"direct-releases/bundled-client.apk")));
            JSONObject published=UpdateManager.localClientInfo(target);check(published.getBoolean("available")&&published.getString("sha256").equals(client.getString("sha256"))&&published.getString("downloadUrl").equals(BackendMode.DIRECT+"/download/client.apk"),"Uploaded original-signed Client is the public Direct update selection");
            UpdateManager.activateRelease(target,"bundled-client");check(UpdateManager.localClientInfo(target)==null,"Bundled Client restores the independent public release channel");
            File zip=new File(target.getCacheDir(),"fixture-direct-web.zip");
            try(ZipOutputStream out=new ZipOutputStream(new FileOutputStream(zip))){for(String name:new String[]{"index.html","portal.html","fleet-config.js"}){out.putNextEntry(new ZipEntry(name));out.write((name.endsWith(".html")?"<html><head><script src='/backend-mode.js'></script><script src='/primary-transport.js'></script></head><body>Synthetic Direct</body></html>":"window.FLEET_CONFIG={apiBase:'https://wrong.invalid'};").getBytes("UTF-8"));out.closeEntry();}}
            JSONObject uploaded=UpdateManager.uploadWebPackage(target,Uri.fromFile(zip));check(uploaded.getString("kind").equals("web"),"Web upload uses local immutable Direct catalogue");
            check(read(UpdateManager.asset(target,"portal.html")).contains("independent-owner.js"),"Uploaded Web preserves owner tools");
            check(read(UpdateManager.asset(target,"fleet-config.js")).contains("independent:true"),"Uploaded Web cannot replace same-origin independent routing");
            UpdateManager.activateRelease(target,"bundled-web");
            check(root.getString("worker_url","").equals("https://cloud-sentinel.invalid"),"Release management never calls or changes Cloud backend");
            String savedToken=RememberedOwner.login(target,owner.getString("username"),owner.getString("password")).getString("token");
            check(RememberedOwner.username(target).equals(owner.getString("username")),"Owner credentials survive protected storage reopen");
            RememberedOwner.rememberBackupCode(target,password);
            String wrapped=target.getSharedPreferences("fleet_sealed_runtime_v1",0).getAll().toString();
            check(!wrapped.contains(owner.getString("password"))&&!wrapped.contains(password)&&!wrapped.contains(owner.getString("username")),"No plaintext owner or portable-backup password in preferences");
            check(RememberedOwner.backupCode(target,"").equals(password),"Remembered portable code is read from Android Keystore wrapping");
            try{RememberedOwner.login(target,owner.getString("username"),"synthetic-wrong-password");throw new AssertionError("Wrong owner password accepted");}catch(IOException expected){}
            check(RememberedOwner.username(target).equals(owner.getString("username")),"A failed login never replaces valid stored credentials");
            savedToken=RememberedOwner.session(target);
            try(FleetDataStore authStore=new FleetDataStore(target)){authStore.getWritableDatabase().execSQL("UPDATE auth_sessions SET revoked_at=1 WHERE revoked_at IS NULL");}
            String renewed=RememberedOwner.session(target);check(!renewed.isEmpty()&&!renewed.equals(savedToken),"Expired/revoked local session refreshes through real owner authentication without asking again");
            runtime.close();runtime=null;
            checkGeneratedBridge(base);
            RememberedOwner.clear(target);RememberedOwner.clearBackupCode(target);
            check(RememberedOwner.username(target).isEmpty()&&RememberedOwner.backupCode(target,"").isEmpty(),"Administrator can remove remembered credentials without deleting business data");
        }finally{
            if(runtime!=null)runtime.close();BackendMode.select(base,"direct",BackendMode.read(base).getLong("revision"),true,"");
        }
        android.util.Log.i("FleetSqliteTest","PASS unified native settings separation, real SAF manual/automatic FCB3, cold recovery before/new backups and Cloud sentinel preservation, immutable local Web release/routing");
    }
    private static void checkGeneratedBridge(Context base)throws Exception{
        // Cold replacement in the fixture must model the real Direct restart,
        // including Android's per-process SharedPreferences cache.
        stopFixtureProvider(base);
        android.content.pm.ProviderInfo provider=base.getPackageManager().resolveContentProvider(BackendMode.CONTROL_AUTHORITY,0);
        check(provider!=null&&!provider.exported&&provider.processName.equals(base.getPackageName()+":direct"),"Physical private same-APK control authority resolves to the Direct process");
        try{base.getContentResolver().call(Uri.parse("content://gr.argyrismitsos.fleetdirect.direct-control"),"status","",null);throw new AssertionError("Old renamed authority unexpectedly resolved");}catch(IllegalArgumentException expected){}
        android.os.Bundle remembered=base.getContentResolver().call(Uri.parse("content://"+BackendMode.CONTROL_AUTHORITY),"login","",new android.os.Bundle());
        check(remembered.getBoolean("ok")&&!remembered.getString("token","").isEmpty(),"Fresh real Direct process reauthenticates remembered owner with Android Keystore; no password is supplied by the caller: "+remembered.getString("errorType","")+" · "+remembered.getString("errorStage","")+" · "+remembered.getString("errorAt","")+" · "+remembered.getString("error",""));
        MainActivity activity=fixtureActivity(base);
        // Exercise the actual compiled/generated JavaScript bridge and Android
        // ContentResolver, with real scoped data. No browser response is mocked.
        try(FleetDataStore uiStore=new FleetDataStore(activity)){
            java.lang.reflect.Field store=MainActivity.class.getDeclaredField("store"),prefs=MainActivity.class.getDeclaredField("preferences");store.setAccessible(true);prefs.setAccessible(true);store.set(activity,uiStore);prefs.set(activity,activity.getSharedPreferences(BackupManager.PREFS,0));
            MainActivity.ServerBridge bridge=activity.new ServerBridge();
            JSONObject mode=new JSONObject(bridge.getBackendMode());check(!mode.has("error")&&mode.getBoolean("directOnly")&&mode.getString("activeMode").equals("direct"),"Generated ServerBridge resolves the real provider, not the renamed Java package");
            JSONObject dashboard=new JSONObject(bridge.getDashboard());check(dashboard.optBoolean("settingsLoaded")&&!dashboard.has("dashboardError"),"Actual generated Direct dashboard loads instead of Unknown authority: "+dashboard.optString("dashboardError"));
            check(dashboard.getString("workerUrl").equals(BackendMode.DIRECT)&&dashboard.getJSONObject("health").getString("androidVersion").equals(android.os.Build.VERSION.RELEASE),"Real bridge returns Direct authority and device health");
        }
        android.util.Log.i("FleetSqliteTest","PASS actual compiled generated ServerBridge dashboard, physical authority, real Android ContentResolver/provider and device health");
    }
}

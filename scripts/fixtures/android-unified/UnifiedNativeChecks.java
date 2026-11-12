package gr.argyrismitsos.fleetdirect;
import android.content.*;import android.net.Uri;import org.json.*;import java.io.*;import java.util.*;import java.util.zip.*;
import gr.argyrismitsos.fleetserver.BackendMode;

/** Disposable emulator-only tests of the shipped native Direct controls. */
public final class UnifiedNativeChecks{
    private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    private static String read(InputStream input)throws Exception{try(InputStream in=input;ByteArrayOutputStream out=new ByteArrayOutputStream()){byte[] b=new byte[8192];int n;while((n=in.read(b))!=-1){if(out.size()+n>2*1024*1024)throw new IOException("Fixture response too large");out.write(b,0,n);}return out.toString("UTF-8");}}
    static void run(Context base,Context target,Uri manifest,JSONObject owner,String password)throws Exception{
        check(!BackendMode.direct(base),"Normal update defaults Cloudflare before every synthetic activation");
        try(android.database.sqlite.SQLiteDatabase db=base.openOrCreateDatabase("issue95-cloud-sentinel.db",0,null)){db.execSQL("CREATE TABLE keep(value TEXT)");db.execSQL("INSERT INTO keep VALUES('cloud-intact')");}
        SharedPreferences root=base.getSharedPreferences(BackupManager.PREFS,0),prefs=target.getSharedPreferences(BackupManager.PREFS,0);
        root.edit().putString("worker_url","https://cloud-sentinel.invalid").putInt(BackupManager.KEY_HOUR,22).putBoolean("automatic_backup",false).commit();
        prefs.edit().putBoolean("automatic_start",false).putBoolean("automatic_ota",false).commit();
        BackupProtection.configure(target,password);
        IndependentRuntime runtime=IndependentRuntime.get(target);
        try{
            // Internal backup operations work while Cloudflare is unavailable;
            // the synthetic selected-mode command does not exercise TLS readiness.
            BackendMode.select(base,"direct",BackendMode.read(base).getLong("revision"),true,"");
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
            runtime.close();runtime=null;
            NativeColdRuntime.applyIfPending(target);check(!NativeColdRuntime.blocked(target)&&NativeColdRuntime.core(target).state().getString("phase").equals("installed"),"Cold apply installs only scoped Direct directories");
            check(!IndependentConfig.read(target).getString("generation").equals(previousGeneration),"Recovery rotates Direct generation");
            File oldDb=new File(NativeColdRuntime.core(target).directory(preview.getString("previewId")),"old-databases/"+NativeColdRestore.DATABASE_NAME);check(oldDb.isFile(),"Previous Direct database retained after replacement");
            runtime=IndependentRuntime.get(target);
            JSONObject finished=NativeRecoveryController.finish(target);check(finished.getBoolean("newBackupVerified")&&!DirectHost.paused(target),"Recovery completes only after a new portable full backup/proof");
            JSONObject login=runtime.localLogin(owner.getString("username"),owner.getString("password"));check(login.getInt("status")==200,"Original owner password still works after recovery; new sessions required");
            try(android.database.sqlite.SQLiteDatabase db=base.openOrCreateDatabase("issue95-cloud-sentinel.db",0,null);android.database.Cursor cursor=db.rawQuery("SELECT value FROM keep",null)){check(cursor.moveToFirst()&&cursor.getString(0).equals("cloud-intact"),"Cold Direct replacement leaves actual Cloud database directory intact");}
            JSONObject catalogue=UpdateManager.listReleases(target);check(catalogue.getJSONArray("releases").length()>=3,"Normal Updates controls show bundled Client/Web/Server in Direct");
            File zip=new File(target.getCacheDir(),"fixture-direct-web.zip");
            try(ZipOutputStream out=new ZipOutputStream(new FileOutputStream(zip))){for(String name:new String[]{"index.html","portal.html","fleet-config.js"}){out.putNextEntry(new ZipEntry(name));out.write((name.endsWith(".html")?"<html><head><script src='/backend-mode.js'></script><script src='/primary-transport.js'></script></head><body>Synthetic Direct</body></html>":"window.FLEET_CONFIG={apiBase:'https://wrong.invalid'};").getBytes("UTF-8"));out.closeEntry();}}
            JSONObject uploaded=UpdateManager.uploadWebPackage(target,Uri.fromFile(zip));check(uploaded.getString("kind").equals("web"),"Web upload uses local immutable Direct catalogue");
            check(read(UpdateManager.asset(target,"portal.html")).contains("independent-owner.js"),"Uploaded Web preserves owner tools");
            check(read(UpdateManager.asset(target,"fleet-config.js")).contains("independent:true"),"Uploaded Web cannot replace same-origin independent routing");
            UpdateManager.activateRelease(target,"bundled-web");
            check(root.getString("worker_url","").equals("https://cloud-sentinel.invalid"),"Release management never calls or changes Cloud backend");
        }finally{
            if(runtime!=null)runtime.close();BackendMode.select(base,"cloudflare",BackendMode.read(base).getLong("revision"),true,"");
        }
        android.util.Log.i("FleetSqliteTest","PASS unified native settings separation, real SAF manual/automatic FCB3, cold recovery before/new backups and Cloud sentinel preservation, immutable local Web release/routing");
    }
}

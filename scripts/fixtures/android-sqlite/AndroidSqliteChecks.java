package gr.argyrismitsos.fleetserver;

import android.app.*;
import android.content.*;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.provider.DocumentsContract;
import org.json.*;
import org.sqlite.database.sqlite.SQLiteDatabase;
import java.io.*;
import java.security.KeyPair;
import java.nio.file.Files;
import java.util.*;

/** Runs against the actual staged/dexed APK, JNI, Android Keystore and fsync. */
public final class AndroidSqliteChecks extends Instrumentation {
    private static final String AUTHORITY="gr.argyrismitsos.fleetserver.sqlitetest.backup";
    private static final String PASSWORD="Synthetic-portable-backup-2026!";
    private static final String REALM="https://fixture.duckdns.org",GENERATION="11111111-1111-4111-8111-111111111111";
    private static final String FIXTURE_KEY="synthetic-independent-server-key-2026",PEPPER="synthetic-independent-pepper-2026";
    private void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    @Override public void onCreate(Bundle arguments){super.onCreate(arguments);start();}
    @Override public void onStart(){Bundle result=new Bundle();try{runChecks();result.putString("stream","PASS actual Android bundled SQLite, JSON indexes, savepoints, WAL, FCB3 SAF import, Keystore/fsync, owner login and source preservation\n");finish(Activity.RESULT_OK,result);}catch(Throwable failure){android.util.Log.e("FleetSqliteTest","Synthetic Android regression failed",failure);StringWriter trace=new StringWriter();failure.printStackTrace(new PrintWriter(trace));result.putString("stream","FAIL "+trace.toString()+"\n");finish(Activity.RESULT_CANCELED,result);}}
    private JSONObject request(NativeBusinessEngine engine,String path,String method,JSONObject body,String token,boolean internal)throws Exception{
        JSONObject headers=new JSONObject().put("Content-Type","application/json").put("X-Fleet-Operation",UUID.randomUUID().toString());if(token!=null)headers.put("Authorization","Bearer "+token);if(internal)headers.put("X-Fleet-Server-Key",FIXTURE_KEY);
        JSONObject req=new JSONObject().put("url",REALM+path).put("method",method).put("headers",headers);if(body!=null)req.put("body",body.toString());return engine.request(req,internal,60000);
    }
    private void upload(Context context,File source,String name)throws Exception{
        boolean first=true;try(InputStream input=new FileInputStream(source)){byte[] bytes=new byte[32768];int n;while((n=input.read(bytes))!=-1){Bundle bundle=new Bundle();bundle.putByteArray("data",Arrays.copyOf(bytes,n));bundle.putBoolean("first",first);context.getContentResolver().call(DocumentsContract.buildTreeDocumentUri(AUTHORITY,"root"),"append",name,bundle);first=false;}}
    }
    private void runChecks()throws Exception {
        waitForIdleSync();final Context target=getTargetContext();IndependentConfig.require(target);IndependentSqlite.initialize(target);IndependentSqlite.requireReady();
        // startInstrumentation force-stops the target and revokes transient URI
        // grants. Grant this real SAF tree after instrumentation has started.
        getContext().startActivity(new Intent(getContext(),SyntheticBackupActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        Uri fixtureTree=DocumentsContract.buildTreeDocumentUri(AUTHORITY,"root");long grantDeadline=System.currentTimeMillis()+10000;
        while(target.checkUriPermission(fixtureTree,android.os.Process.myPid(),android.os.Process.myUid(),Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION)!=android.content.pm.PackageManager.PERMISSION_GRANTED&&System.currentTimeMillis()<grantDeadline)Thread.sleep(25);
        check(target.checkUriPermission(fixtureTree,android.os.Process.myPid(),android.os.Process.myUid(),Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION)==android.content.pm.PackageManager.PERMISSION_GRANTED,"Actual SAF tree read/write permission must be granted after the target process starts");
        AcmeProtocolChecks.run(IndependentAcme.generate(),"synthetic-CA-protocol-only",false);
        check(!target.getDatabasePath(NativeColdRestore.DATABASE_NAME).exists(),"Emulator target must start empty");
        // API30's stock SQLite has the same missing JSON capability as the photo.
        boolean stockJson=false;try(android.database.sqlite.SQLiteDatabase stock=android.database.sqlite.SQLiteDatabase.create(null)){try(Cursor c=stock.rawQuery("SELECT json_extract('{\"n\":1}','$.n')",null)){stockJson=c.moveToFirst();}catch(android.database.sqlite.SQLiteException expected){}}
        check(!stockJson,"Regression image must reproduce stock SQLite without JSON");
        final File fixture=new File(target.getCacheDir(),"android-sqlite-fixture");fixture.mkdirs();
        Context source=new ContextWrapper(target){@Override public File getFilesDir(){File f=new File(fixture,"files");f.mkdirs();return f;}@Override public File getCacheDir(){File f=new File(fixture,"cache");f.mkdirs();return f;}};
        File packet=new File(source.getFilesDir(),"packet");packet.mkdirs();
        String databaseName="fleet-recovery-probe-"+UUID.randomUUID()+".db";
        final JSONObject owner=new JSONObject().put("username","android.owner").put("password","Synthetic-Owner-2026!").put("fullName","Synthetic Android owner");
        JSONObject parts;
        try(FleetDataStore store=new FleetDataStore(source,databaseName)){
            SQLiteDatabase db=store.getWritableDatabase();check(db.isWriteAheadLoggingEnabled(),"Every staged helper enables WAL on first open");IndependentDatabase.configure(db);new StoreBillingStore(store);check(db.isWriteAheadLoggingEnabled()&&IndependentSqlite.text(db,"PRAGMA journal_mode").equals("wal"),"Bundled writable DB uses actual WAL");NativeDatabaseSnapshot.requireCapabilities(db);
            db.execSQL("CREATE TABLE json_regression(payload TEXT)");db.execSQL("CREATE INDEX json_regression_index ON json_regression(json_extract(payload,'$.n'))");db.execSQL("INSERT INTO json_regression VALUES('{\"n\":17}')");
            check(IndependentSqlite.text(db,"PRAGMA integrity_check").equals("ok"),"Exact photographed PRAGMA accepts JSON expression index");
            BusinessSqlite sql=new BusinessSqlite(db);
            db.beginTransaction();try{
                db.execSQL("INSERT INTO json_regression VALUES('{\"n\":18}')");
                JSONArray batch=new JSONArray().put(new JSONObject().put("sql","INSERT INTO json_regression VALUES('{\"n\":19}')")).put(new JSONObject().put("sql","INSERT INTO missing_fixture_table VALUES(1)"));
                try{sql.call("sql.batch",new JSONObject().put("queries",batch));throw new AssertionError("Failing nested batch accepted");}catch(org.sqlite.database.sqlite.SQLiteException expected){}
                check(db.inTransaction()&&IndependentSqlite.text(db,"SELECT count(*) FROM json_regression").equals("2"),"Failed nested batch preserves outer transaction");
                sql.call("sql.run",new JSONObject().put("sql","SAVEPOINT dynamic_probe"));sql.call("sql.run",new JSONObject().put("sql","INSERT INTO json_regression VALUES('{\"n\":20}')"));sql.call("sql.run",new JSONObject().put("sql","ROLLBACK TO SAVEPOINT dynamic_probe"));sql.call("sql.run",new JSONObject().put("sql","RELEASE SAVEPOINT dynamic_probe"));
                check(db.inTransaction()&&IndependentSqlite.text(db,"SELECT count(*) FROM json_regression").equals("2"),"Dynamic savepoint only rolls back its own work");
            }finally{db.endTransaction();}
            check(IndependentSqlite.text(db,"SELECT count(*) FROM json_regression").equals("1"),"Outer rollback still works");
            db.execSQL("BEGIN");db.execSQL("INSERT INTO json_regression VALUES('{\"n\":21}')");db.execSQL("ROLLBACK");check(!db.inTransaction()&&IndependentSqlite.text(db,"SELECT count(*) FROM json_regression").equals("1"),"Explicit full ROLLBACK retains Android transaction semantics");
            JSONObject config=new JSONObject().put("standalone",true).put("realm",REALM).put("generation",GENERATION).put("serverKey",FIXTURE_KEY).put("authPepper",PEPPER).put("eventSigningKey","synthetic-events-key-2026");
            try(NativeBusinessEngine engine=new NativeBusinessEngine(db,new File(source.getFilesDir(),"service-documents"),new File(source.getCacheDir(),"temporary"),config,IndependentRuntime.asset(target,"business-runtime/runtime.js"),new JSONObject(IndependentRuntime.asset(target,"business-runtime/manifest.json")).getString("bundleSha256"),new NativeBusinessEngine.Authority(){public void beforeRequest(JSONObject r,boolean internal){}public void beforeCommit(JSONObject r,boolean internal){}},(command,value,objects)->{if(command.equals("health.snapshot"))return new JSONObject();if(command.equals("store.context"))return new JSONObject().put("configured",false);throw new IOException("Unexpected outbound capability: "+command);})){
                check(request(engine,"/api/status","GET",null,null,false).getInt("status")==200,"Actual Rhino engine creates full schema on Android");
                JSONObject bootstrap=request(engine,"/api/auth/bootstrap","POST",owner,null,true);check(bootstrap.getInt("status")<300,"Synthetic owner bootstrap: "+bootstrap);
                JSONObject login=request(engine,"/api/auth/user-login","POST",owner,null,false);check(login.getInt("status")==200,"Synthetic owner login");String ownerId=new JSONObject(login.getString("body")).getJSONObject("user").getString("id");
                NativePrimaryState.phase(db,"active",REALM,GENERATION,ownerId,"");
                byte[] document="Synthetic invoice · Ελληνικά 🛵".getBytes("UTF-8");String key="service-documents/android-fixture.pdf",sha=BusinessRuntime.sha256(document),local=BusinessRuntime.sha256(key.getBytes("UTF-8"))+"-"+sha+".pdf";
                File docs=new File(source.getFilesDir(),"service-documents");docs.mkdirs();Files.write(new File(docs,local).toPath(),document);
                db.execSQL("INSERT INTO native_objects VALUES(?,?,?,?,?,?, '{}','{}',datetime('now'),NULL)",new Object[]{key,local,"Synthetic invoice.pdf","application/pdf",document.length,sha});
                JSONObject recovery=new JSONObject().put("schemaVersion",1).put("realm",REALM).put("authPepper",PEPPER).put("recoveryToken","rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr").put("ownerId",ownerId).put("sourceGeneration",GENERATION).put("sourceFingerprint",BusinessRuntime.sha256("synthetic".getBytes("UTF-8")));
                try(BackupEnvelope envelope=new BackupEnvelope(PortableBackupCipher.create(PASSWORD),new byte[32])){parts=NativeBackupBuilder.prepare(source,db,packet,UUID.randomUUID().toString(),new JSONObject().put("workerUrl",REALM),recovery,envelope,(stage,done,total)->{});}
                check(parts.getJSONObject("nativeProof").getBoolean("restoreVerified"),"Actual encrypted full FCB3 backup and isolated recovery");
            }
        }
        Map<File,String> originals=new HashMap<File,String>();
        for(String kind:new String[]{"data","database","docs"}){File file=new File(packet,parts.getString(kind+"Path"));originals.put(file,NativeDatabaseSnapshot.digest(file));String name="FleetControl_"+(kind.equals("data")?"backup":kind.equals("database")?"database":"documents")+"_20261111_120000."+(kind.equals("data")?"fcbackup":kind.equals("database")?"fcdb":"fcdocs");upload(target,file,name);}
        Uri tree=DocumentsContract.buildTreeDocumentUri(AUTHORITY,"root"),manifest=DocumentsContract.buildDocumentUriUsingTree(tree,"FleetControl_backup_20261111_120000.fcbackup");target.getSharedPreferences(BackupManager.PREFS,Context.MODE_PRIVATE).edit().putString(BackupManager.KEY_FOLDER_URI,tree.toString()).commit();
        try{IndependentRestore.importBackup(target,manifest,"Wrong-fixture-password!");throw new AssertionError("Wrong backup password accepted");}catch(IOException expected){}
        check(!target.getDatabasePath(NativeColdRestore.DATABASE_NAME).exists(),"Wrong password leaves target empty");
        JSONObject proof=IndependentRestore.importBackup(target,manifest,PASSWORD);check(proof.getBoolean("imported")&&proof.getBoolean("restoreVerified")&&proof.getInt("documentsRestored")==1,"Actual SAF import, Android Keystore and cold directory fsync");
        check(IndependentConfig.read(target).getString("mode").equals("test")&&!IndependentConfig.read(target).getBoolean("testOrdexa"),"Imported mode stays test with source polling OFF");
        try(FleetDataStore restored=new FleetDataStore(target)){SQLiteDatabase db=restored.getWritableDatabase();check(IndependentSqlite.text(db,"PRAGMA integrity_check").equals("ok")&&IndependentSqlite.text(db,"SELECT json_extract(payload,'$.n') FROM json_regression").equals("17"),"Imported JSON indexes/data remain intact");}
        IndependentRuntime runtime=IndependentRuntime.get(target);
        try{JSONObject req=new JSONObject().put("url",runtime.realm()+"/api/auth/user-login").put("method","POST").put("headers",new JSONObject().put("Content-Type","application/json").put("X-Fleet-Operation",UUID.randomUUID().toString())).put("body",owner.toString());JSONObject login=runtime.external(req);check(login.getInt("status")==200,"Original owner credentials work after actual Android restore");String token=new JSONObject(login.getString("body")).getString("token");check(runtime.localProbe(token).getInt("status")==200,"Actual owner readiness savepoint succeeds after restore");}finally{runtime.close();}
        // Real API30 Android Keystore: previous ACME encrypted state survives
        // an explicit account-version switch without any live CA/DuckDNS I/O.
        JSONObject preservedConfig=IndependentConfig.read(target);
        KeyPair oldAccount=IndependentAcme.accountKey(target,preservedConfig);
        KeyPair reused=IndependentAcme.accountKey(target,preservedConfig);
        check(Arrays.equals(oldAccount.getPublic().getEncoded(),reused.getPublic().getEncoded()),"Legacy ACME key persists on Android");
        String originalAccountCipher=target.getSharedPreferences("fleet_sealed_runtime_v1",Context.MODE_PRIVATE).getString(IndependentAcme.NAME,"");
        JSONObject prepared=new JSONObject(preservedConfig.toString()).put("acmeTermsAccepted",true).put("hostname","fixture.duckdns.org");
        IndependentConfig.save(target,prepared);
        android.content.SharedPreferences ui=target.getSharedPreferences("independent_ui",Context.MODE_PRIVATE);
        ui.edit().putString("certificate","Synthetic persistent [CERT_STORAGE_STORAGE]").commit();
        IndependentAcme.prepareFreshAccount(target);
        JSONObject activated=IndependentConfig.read(target);
        check(activated.getInt("acmeAccountVersion")==2
            &&activated.getString("backupSha256").equals(preservedConfig.getString("backupSha256")),"Opt-in ACME v2 preserves imported backup/config");
        KeyPair rotated=IndependentAcme.accountKey(target,activated);
        check(!Arrays.equals(oldAccount.getPublic().getEncoded(),rotated.getPublic().getEncoded()),"ACME v2 identity uses a distinct key");
        check(originalAccountCipher.equals(target.getSharedPreferences("fleet_sealed_runtime_v1",Context.MODE_PRIVATE).getString(IndependentAcme.NAME,"")),"Old encrypted ACME identity preserved byte-for-byte");
        check(Arrays.equals(rotated.getPublic().getEncoded(),IndependentAcme.accountKey(target,activated).getPublic().getEncoded()),"New account survives Android Keystore reopen");
        try{IndependentAcme.prepareFreshAccount(target);throw new AssertionError("Repeated account change allowed");}catch(IOException expected){}
        IndependentConfig.save(target,preservedConfig);
        ui.edit().remove("certificate").remove("certificateRetryRequested").commit();
        String installed=NativeDatabaseSnapshot.digest(target.getDatabasePath(NativeColdRestore.DATABASE_NAME));try{IndependentRestore.importBackup(target,manifest,PASSWORD);throw new AssertionError("Second import overwrote DB");}catch(IOException expected){}check(installed.equals(NativeDatabaseSnapshot.digest(target.getDatabasePath(NativeColdRestore.DATABASE_NAME))),"Existing independent installation preserved");
        for(Map.Entry<File,String> item:originals.entrySet())check(item.getValue().equals(NativeDatabaseSnapshot.digest(item.getKey())),"Original encrypted parts remain byte-exact");
        // Real Activity lifecycle/preferences notification, with no hostname or live CA.
        check(IndependentConfig.read(target).optString("hostname").isEmpty(),"UI fixture cannot start live CA");
        final Activity activity=startActivitySync(new Intent(target,IndependentActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));waitForIdleSync();
        try{String diagnostic="Synthetic certificate progress CERT_ORDER_CAA";target.getSharedPreferences("independent_ui",Context.MODE_PRIVATE).edit().putString("certificate",diagnostic).commit();waitForIdleSync();
            java.lang.reflect.Field field=IndependentActivity.class.getDeclaredField("status");field.setAccessible(true);final String[] displayed={""};runOnMainSync(()->displayed[0]=((android.widget.TextView)readField(field,activity)).getText().toString());check(displayed[0].contains(diagnostic),"Actual owner Activity refreshes certificate progress without manual action");
        }finally{runOnMainSync(()->activity.finish());waitForIdleSync();}
    }
    private static Object readField(java.lang.reflect.Field field,Object value){try{return field.get(value);}catch(Exception error){throw new AssertionError(error);}}
}

#!/usr/bin/env python3
"""Compile the proven independent backend in its own namespace/process/storage.

Production classes, SQLite provider and cloud preferences are never rewritten.
The generated source is reproducible from the complete repository archive.
"""
from pathlib import Path
import re, shutil, sys, json

root=Path(__file__).resolve().parents[1]
out=Path(sys.argv[1]);assets=Path(sys.argv[2])
old='gr.argyrismitsos.fleetserver';new='gr.argyrismitsos.fleetdirect'
destination=out/Path(new.replace('.','/'));destination.mkdir(parents=True,exist_ok=True)
sources={p.name:p for p in (root/'server-android/src'/Path(old.replace('.','/'))).glob('*.java')
         if p.stem not in ('FleetApplication','BootReceiver','BackendMode')}
sources.update({p.name:p for p in (root/'independent-android/src'/Path(old.replace('.','/'))).glob('*.java')})

def change(value,old,new):
    if value.count(old)!=1:raise RuntimeError('Unified source integration drift: '+old[:100])
    return value.replace(old,new)

for name,p in sources.items():
    value=p.read_text().replace('"'+old+'.','"__FLEET_ROOT__.').replace(old,new).replace('"__FLEET_ROOT__.','"'+old+'.')
    value=value.replace('android.database.sqlite.','org.sqlite.database.sqlite.')
    value=value.replace('import android.database.SQLException;','import org.sqlite.database.SQLException;')
    value=value.replace('import android.database.DatabaseErrorHandler;','import org.sqlite.database.DatabaseErrorHandler;')
    value=value.replace('"ROLLBACK TO ','"/* fleet savepoint */ ROLLBACK TO ')
    if name!='MainActivity.java':value=re.sub(r'(?<![.\w])MainActivity\b',old+'.MainActivity',value)
    imports=('\nimport '+old+'.R;' if re.search(r'\bR\.',value) else '')+('\nimport '+old+'.BackendMode;' if 'BackendMode.' in value or name in ('IndependentRuntime.java','IndependentService.java','IndependentActivity.java') else '')
    value=value.replace('package '+new+';','package '+new+';'+imports)
    if name=='MainActivity.java':
        value=change(value,'public final class MainActivity extends Activity {','''public final class MainActivity extends Activity {
    @Override protected void attachBaseContext(Context base){super.attachBaseContext(new ScopedContext(base));}
''')
        value=change(value,'        preferences = getSharedPreferences(BackupManager.PREFS, MODE_PRIVATE);','''        if(!BackendMode.direct(this)){startActivity(new Intent().setClassName(this,"gr.argyrismitsos.fleetserver.MainActivity"));finish();return;}
        preferences = getSharedPreferences(BackupManager.PREFS, MODE_PRIVATE);
        DirectHost.initialize(this);
''')
        value=value.replace('NativePrimaryService.install(getApplicationContext());','DirectHost.initialize(getApplicationContext());')
        value=change(value,'result.put("primary",NativePrimaryService.get(this).status());','result.put("primary",DirectHost.primary(this));')
        value=change(value,'if(BackendMode.direct(this))stopService(new Intent().setClassName(this,"gr.argyrismitsos.fleetdirect.IndependentService"));','stopService(new Intent(this,IndependentService.class));')
        value=value.replace('stopService(new Intent(this, SyncService.class));','')
        value=change(value,'String lane="action:"+event;','''critical=!event.startsWith("primaryRecovery")&&critical||event.startsWith("ordexa")||event.equals("pin");
                String lane="action:"+event;''')
        value=change(value,'                JSONObject input = new JSONObject(json);','                if(DirectHost.paused(MainActivity.this))throw new IllegalStateException("Ολοκλήρωσε την ενημέρωση ή ανάκτηση πριν αλλάξεις ρυθμίσεις.");\n                JSONObject input = new JSONObject(json);')
        value=change(value,'JSONObject primary=NativePrimaryState.read(store.getReadableDatabase());if(!primary.optString("phase","cloud").equals("cloud")&&!workerUrl.equals(primary.optString("realm")))throw new IllegalStateException("Η διεύθυνση της κύριας βάσης αλλάζει μόνο μέσα από ελεγχόμενη μεταφορά ή ανάκτηση.");','if(!BackendMode.DIRECT.equals(workerUrl))throw new IllegalStateException("Η διεύθυνση Direct είναι https://fleet-control.duckdns.org. Ο διακόπτης επιλέγει ξεχωριστά το Cloudflare.");')
        value=value.replace('NativeRestartActivity.class','DirectRestartActivity.class')
        value=value.replace('new Intent(MainActivity.this,SyncService.class).setAction(action)','new Intent(MainActivity.this,IndependentService.class).setAction(action)')
        # Legacy cloud transfer remains available in its own original mode only.
        for name_ in ('NativeMigrationController','CloudReturnController'):
            value=value.replace('return '+name_+'.migrate(', 'DirectHost.cloudOnly();return '+name_+'.migrate(')
        value=value.replace('return NativeMigrationController.abort(', 'DirectHost.cloudOnly();return NativeMigrationController.abort(')
        value=value.replace('return DirectServer.state(getApplicationContext(),store).toString();','return DirectHost.access(thisContext()).toString();')
        value=value.replace('DirectServer.configure(getApplicationContext(),store,enabled);','DirectHost.cloudOnly();DirectServer.configure(getApplicationContext(),store,enabled);')
        value=value.replace('return NativeRecoveryController.preview(', 'return NativeRecoveryController.preview(')
        # Full FCB3 recovery uses the common verified preview/restart UI.
        begin=value.index('        public void chooseBackupFile(String adminPin) {')
        end=value.index('        @JavascriptInterface public void cancelBackupRestore()',begin)
        value=value[:begin]+'''        public void chooseBackupFile(String adminPin) {
            try{emit("useFullRecovery",new JSONObject().put("ok",true));}catch(Exception ignored){}
        }

'''+value[end:]
        value=change(value,'    private Bundle directControl(', '    private Context thisContext(){return MainActivity.this;}\n    private Bundle directControl(')
    if name=='ServerConfig.java':value=value.replace('https://fleet-control.pavlosargyris.workers.dev','https://fleet-control.duckdns.org')
    if name=='SealedLocalState.java':
        value=change(value,'    private static SecretKey key(String alias)throws Exception{','''    static String scopeAlias(String alias){return "fleet.unified-direct."+alias;}
    private static SecretKey key(String alias)throws Exception{
        alias=scopeAlias(alias);''')
    if name=='IndependentAcme.java':value=change(value,'keys.containsAlias(alias)','keys.containsAlias(SealedLocalState.scopeAlias(alias))')
    if name=='OrdexaSync.java':value=change(value,'KEY="fleet.ordexa.session.v1"','KEY="fleet.unified-direct.ordexa.session.v1"')
    if name=='DirectIdentity.java':value=change(value,'ALIAS="fleet.direct.identity.v1"','ALIAS="fleet.unified-direct.identity.v1"')
    if name=='OtaManager.java':value=change(value,'private static final boolean DIRECT_SCOPE=false;','private static final boolean DIRECT_SCOPE=true;')
    if name=='NativeBackupPreparation.java':
        begin=value.index('        boolean cloud=');end=value.index('\n    }',begin)
        value=value[:begin]+'''        return DirectHost.prepareBackup(context,store,directory,id,envelope,progress);'''+value[end:]
    if name=='FleetDataStore.java':
        value=value.replace('import org.sqlite.database.sqlite.SQLiteDatabase;','import org.sqlite.database.sqlite.SQLiteDatabase;\nimport org.sqlite.database.sqlite.SQLiteException;')
        value=change(value,'    @Override\n    public void onCreate(SQLiteDatabase db) {','''    @Override public void onConfigure(SQLiteDatabase db) {
        if(db.isReadOnly())return;
        try{IndependentDatabase.configure(db);}catch(Exception error){throw new SQLiteException("Direct SQLite configuration failed");}
    }
    @Override
    public void onCreate(SQLiteDatabase db) {''')
    if name=='BusinessSqlite.java':
        for a,b in [('},sql,null,null);','},IndependentSqlite.statement(sql),null,null);'),('db.execSQL(sql,args);','db.execSQL(IndependentSqlite.statement(sql),args);'),('db.execSQL(line);','db.execSQL(IndependentSqlite.statement(line));')]:value=change(value,a,b)
    if name=='IndependentConfig.java':
        start='if(!PACKAGE.equals(c.getPackageName()))'
        value=change(value,start,'if(!"'+old+'".equals(c.getPackageName())||!ScopedContext.owns(c))')
    if name=='IndependentRestore.java':
        value=change(value,'IndependentConfig.save(c,SealedLocalState.read(c,PENDING,ALIAS).getJSONObject("configuration"));','JSONObject pending=SealedLocalState.read(c,PENDING,ALIAS);IndependentConfig.save(c,pending.getJSONObject("configuration"));if(pending.has("backupProtection"))BackupProtection.restore(c,pending.getJSONObject("backupProtection"));')
        value=change(value,'SealedLocalState.remove(c,IndependentConfig.NAME);','SealedLocalState.remove(c,IndependentConfig.NAME);JSONObject pending=SealedLocalState.read(c,PENDING,ALIAS);if(pending.has("oldProtection"))BackupProtection.restore(c,pending.getJSONObject("oldProtection"));')
        value=change(value,'new JSONObject().put("id",id).put("configuration",config);','new JSONObject().put("id",id).put("configuration",config).put("backupProtection",password==null?BackupProtection.snapshot(c):BackupProtection.candidate(password)).put("oldProtection",BackupProtection.snapshot(c));')
    if name in ('IndependentActivity.java','IndependentService.java'):
        declaration='public final class '+p.stem+' extends '+('Activity' if 'Activity' in name else 'Service')+' {'
        value=change(value,declaration,declaration+'\n    @Override protected void attachBaseContext(Context base){super.attachBaseContext(new ScopedContext(base));}\n')
    if name=='IndependentActivity.java':
        value=change(value,'IndependentConfig.require(this);build();','IndependentConfig.require(this);try{DirectHost.startup(this);}catch(Exception error){getSharedPreferences("independent_ui",MODE_PRIVATE).edit().putString("blocked","Η ασφαλής προετοιμασία Direct χρειάζεται έλεγχο.").commit();}build();')
        value=change(value,'}build();','}OtaManager.resumeAfterRestart(this);build();')
        value=change(value,'        text("Ασφαλές αντίγραφο",20);','''        // These owner tools remain reachable from Cloudflare after a manual
        // recovery. They finish an explicit pending operation, never the switch.
        try{
            if(NativeColdRuntime.core(this).state().optString("phase").equals("ready")){
                text("Συνέχεια έτοιμης ανάκτησης Direct",20);
                button("Επανεκκίνηση για την έτοιμη ανάκτηση",v->task(()->{requireOwner();if(!NativeColdRuntime.core(this).state().optString("phase").equals("ready"))throw new Exception("Δεν υπάρχει έτοιμη ανάκτηση Direct.");runOnUiThread(()->startActivity(new Intent(this,DirectRestartActivity.class)));return "Η έτοιμη ανάκτηση θα εφαρμοστεί με ασφαλή επανεκκίνηση Direct. Η επιλογή λειτουργίας δεν αλλάζει.";}));
            }
            if(getSharedPreferences(BackupManager.PREFS,0).getBoolean("native_recovery_pending",false)){
                text("Έλεγχος νέου backup μετά την ανάκτηση Direct",20);
                button("Ολοκλήρωση ανάκτησης Direct",v->task(()->{requireOwner();JSONObject result=NativeRecoveryController.finish(this);if(!result.optBoolean("newBackupVerified"))throw new Exception("Το νέο backup δεν επιβεβαιώθηκε.");return "Η ανάκτηση Direct ολοκληρώθηκε με νέο επαληθευμένο backup. Η επιλογή λειτουργίας διατηρήθηκε. Συνδέσου ξανά ως ιδιοκτήτης.";}));
            }
            if(getSharedPreferences(BackupManager.PREFS,0).getBoolean("ota_quiescing",false)){
                text("Εκκρεμής ενημέρωση Direct",20);
                button("Αναβολή εκκρεμούς ενημέρωσης Direct",v->task(()->{requireOwner();if(OtaManager.installationPending(this))throw new Exception("Η εγκατάσταση εκκρεμεί στο Android. Ολοκλήρωσέ την ή ακύρωσέ την από το παράθυρο εγκατάστασης.");OtaManager.cancelWait(this);return "Η ενημέρωση Direct αναβλήθηκε. Τα δεδομένα και η επιλογή λειτουργίας διατηρήθηκαν.";}));
            }
        }catch(Exception error){text("Η κατάσταση της εκκρεμούς ανάκτησης χρειάζεται έλεγχο πριν συνεχιστεί.",14);}
        text("Ασφαλές αντίγραφο",20);''')
        value=value.replace('Fleet Independent Server','Fleet — Προετοιμασία Direct')
        value=value.replace('Νέα ανεξάρτητη εγκατάσταση / Δοκιμή','Προετοιμασία Direct')
        value=change(value,'Η υπάρχουσα εγκατάσταση παραμένει ανέπαφη. Εισήγαγε το πλήρες τελευταίο backup στη δεύτερη συσκευή.','Τα δεδομένα Cloudflare διατηρούνται χωριστά. Επίλεξε τον φάκελο με το πλήρες backup για την αρχική βάση Direct.')
        value=value.replace('στη δοκιμαστική εγκατάσταση','στη χωριστή βάση Direct').replace('το backup που θα δοκιμαστεί','το backup για την αρχική βάση Direct')
        value=value.replace('Άνοιγμα Web δοκιμής','Άνοιγμα Web Direct').replace('Ενεργοποίηση δοκιμαστικού Ordexa read-only','Ενεργοποίηση Ordexa στο Direct (μόνο ανάγνωση)')
        value=change(value,'Uri.parse("https://"+host)','Uri.parse("https://"+host+(BackendMode.direct(this)?"/":"/?fleetSetup=1"))')
        value=change(value,'Αρχικά ανενεργό. Ενεργοποίησέ το συνειδητά για τη δοκιμή ώστε να αποφευχθεί δεύτερος παράλληλος reader. Ασφαλής αρχική συχνότητα 5 λεπτών· τα καταστήματα ανά ώρα. Το ~15s απαιτεί πραγματική μέτρηση και άδεια πλατφόρμας.','Αρχικά ανενεργό. Ρύθμισε τον λογαριασμό και την πόλη για τη βάση Direct. Παρουσίες κάθε 5 λεπτά και καταστήματα ανά ώρα, μόνο όσο είναι επιλεγμένο Direct.')
        value=change(value,'Γίνεται μόνο από τον ιδιοκτήτη στη Web οθόνη μετά από πραγματικό HTTPS έλεγχο με 4G/5G και ρητή επιβεβαίωση. Η εφαρμογή δεν αλλάζει το Cloudflare και δεν μεταφέρει αυτόματα τους παλιούς Clients.','Στο Web κάνε μόνο τον έλεγχο σύνδεσης με 4G/5G. Έπειτα επέστρεψε στις Ρυθμίσεις Server, συνδέσου ως ιδιοκτήτης και άλλαξε τον ενιαίο μοχλό Cloudflare / Direct. Δεν χρειάζεται επιπλέον παράθυρο επιβεβαίωσης και τα δύο σύνολα δεδομένων παραμένουν χωριστά.')
        value=change(value,'IndependentConfig.save(this,IndependentConfig.read(this).put("testOrdexa",false));','OrdexaSync.configure(this,new JSONObject().put("cityId",OrdexaSync.status(this).getString("cityId")).put("enabled",false));IndependentConfig.save(this,IndependentConfig.read(this).put("testOrdexa",false));')
        value=value.replace('Παύση δοκιμαστικού Ordexa','Παύση Ordexa στο Direct').replace('Ενεργοποιήθηκε ο δοκιμαστικός reader.','Ενεργοποιήθηκε ο reader Direct.').replace('δοκιμαστικό συγχρονισμό','συγχρονισμό Direct').replace('Ο δοκιμαστικός συγχρονισμός σταμάτησε.','Ο συγχρονισμός Direct σταμάτησε.')
        value=value.replace('getSharedPreferences("independent_ui",MODE_PRIVATE).getString("mode","test").equals("primary")?"Κύριο":"Δοκιμαστικό"','BackendMode.direct(this)?"Direct":"Προετοιμασία Direct"')
        value=change(value,'hostname=field("Το δικό σου όνομα .duckdns.org",false);','hostname=field("fleet-control.duckdns.org",false);hostname.setText("fleet-control.duckdns.org");hostname.setEnabled(false);')
        # The only production switch is in the existing Server settings.
        value=re.sub(r'        button\("Ενεργοποίηση Android ως κύριου Server".*?(?=\n)', '', value)
    if name=='IndependentRuntime.java':
        value=change(value,'.put("server","independent-1")','.put("server",ServerConfig.SERVER_VERSION)')
        value=change(value,'    JSONObject localLogin(', '    void barrier()throws Exception{serialized(()->null);}\n    JSONObject localLogin(')
        value=change(value,'        URI uri=new URI(address);if(!address.startsWith(','''        final long uploadRevision=input==null?-1:BackendMode.read(context).getLong("revision");
        if(input!=null&&(!BackendMode.direct(context)||DirectHost.paused(context)))throw new IOException("Η λειτουργία άλλαξε. Το αρχείο δεν αποθηκεύτηκε.");
        URI uri=new URI(address);if(!address.startsWith(''')
        value=change(value,'return checked(uploaded==null?dispatch(request,true):engine.requestWithFile(request,uploaded,fileField,"invoice.pdf",contentType));','''if(uploaded==null)return checked(dispatch(request,true));
            // File imports bypass dispatch(), so hold the same cross-process
            // mode fence through their import and commit. Do not hold it while
            // reading a potentially slow source stream on another thread.
            try(BackendMode.Guard ignored=BackendMode.guard(context)){
                if(!BackendMode.direct(context)||DirectHost.paused(context)||uploadRevision!=BackendMode.read(context).getLong("revision"))throw new IOException("Η λειτουργία άλλαξε. Το αρχείο δεν αποθηκεύτηκε.");
                return checked(engine.requestWithFile(request,uploaded,fileField,"invoice.pdf",contentType));
            }''')
        value=change(value,'if(!IndependentConfig.read(context).optBoolean("testOrdexa"))return;','if(!BackendMode.direct(context))return;')
        value=change(value,'.put("testOrdexa",saved.optBoolean("testOrdexa"))','.put("testOrdexa",OrdexaSync.status(context).optBoolean("enabled"))')
        value=change(value,'if(state.optString("phase").equals("needs_recovery"))','if(state.optString("phase").equals("needs_recovery")||state.optString("phase").equals("recovering")&&NativeColdRuntime.core(c).state().optString("phase").equals("installed"))')
        value=change(value,'    JSONObject localLogin(','''    JSONObject dashboard()throws Exception{return serialized(()->store.getStats());}
    JSONObject switchReadiness()throws Exception{return serialized(()->{
        JSONArray rows=query("SELECT created_at,actor_id FROM independent_readiness WHERE id=1");
        long now=System.currentTimeMillis();boolean ready=rows.length()==1&&rows.getJSONObject(0).optString("actor_id").equals(config.getString("ownerId"))&&now>=rows.getJSONObject(0).optLong("created_at")&&now-rows.getJSONObject(0).optLong("created_at")<600000;
        return new JSONObject().put("ready",ready);
    });}
    JSONObject localLogin(''')
        value=change(value,'JSONObject result=engine.request(request,internal,30000);','''JSONObject result;
        try(BackendMode.Guard ignored=BackendMode.guard(context)){
            String path=new URI(request.getString("url")).getPath();
            boolean preflight=path.startsWith("/api/auth/")||path.startsWith("/api/independent/");
            if(!preflight&&!BackendMode.direct(context)&&!(internal&&path.equals("/api/status")))return IndependentHttps.error(409,"Επιλεγμένο Cloudflare. Δεν έγινε εγγραφή στη βάση Direct.");
            if(!preflight&&DirectHost.paused(context)&&!path.equals("/api/status"))return IndependentHttps.error(503,"Ο Server προετοιμάζει ασφαλή ενημέρωση ή ανάκτηση. Επανάλαβε μετά την ολοκλήρωση.");
            String epoch=request.getJSONObject("headers").optString("x-fleet-backend-revision",request.getJSONObject("headers").optString("X-Fleet-Backend-Revision"));
            if(!internal&&!preflight&&!epoch.equals(String.valueOf(BackendMode.read(context).getLong("revision"))))return IndependentHttps.error(409,"Η λειτουργία άλλαξε. Ανανέωσε πριν αποθηκεύσεις.");
            if(path.equals("/api/independent/activate"))return IndependentHttps.error(403,"Χρησιμοποίησε τον διακόπτη στις Ρυθμίσεις Server.");
            result=engine.request(request,internal,30000);
        }''')
        value=change(value,'void jobs()throws Exception{','void jobs()throws Exception{if(!BackendMode.direct(context)||DirectHost.paused(context))return;')
    if name=='IndependentService.java':
        value=change(value,'@Override public void onCreate(){super.onCreate();live=this;','@Override public void onCreate(){super.onCreate();DirectHost.initialize(this);live=this;')
        value=change(value,'if(runtime==null)runtime=IndependentRuntime.get(this);','if(runtime==null)runtime=IndependentRuntime.get(this);if(BackendMode.direct(this))DirectHost.maintenance(this,runtime);')
        value=value.replace('invoiceWorker.tick();','if(BackendMode.direct(thisContext())&&!DirectHost.paused(thisContext()))invoiceWorker.tick();')
        value=value.replace('if(blocked())return;IndependentRuntime backend=','if(blocked()||!BackendMode.direct(thisContext()))return;IndependentRuntime backend=')
        value=change(value,'    private boolean blocked()','    private Context thisContext(){return this;}\n    private boolean blocked()')
        value=value.replace('new Intent(this,IndependentActivity.class)','new Intent(this,gr.argyrismitsos.fleetserver.MainActivity.class)')
        value=value.replace('Δοκιμαστική βάση · HTTPS και συγχρονισμοί στη συσκευή','Direct · HTTPS και επεξεργασία στη συσκευή')
        value=change(value,'IndependentConfig.read(this);','IndependentConfig.read(this);')
        value=change(value,'public JSONObject api(JSONObject request)throws Exception{return backend.external(request);}', 'public JSONObject api(JSONObject request)throws Exception{return backend.external(request);}public JSONObject routing()throws Exception{return BackendMode.read(thisContext());}public JSONObject update()throws Exception{JSONObject selected=UpdateManager.localClientInfo(thisContext());return selected!=null?selected:gr.argyrismitsos.fleetupdates.PublicReleaseFeed.latest("client");}')
        value=change(value,'return getAssets().open("independent-www/"+path);','return UpdateManager.asset(thisContext(),path);')
    if name=='IndependentPolicy.java':
        value=value.replace('"x-fleet-local-ocr"','"x-fleet-local-ocr","x-fleet-backend-revision"')
    (destination/name).write_text(value)

(destination/'BuildSecrets.java').write_text('package '+new+';final class BuildSecrets {static final String SERVER_KEY=IndependentConfig.random();}\n')
shutil.copytree(root/'unified-android/src',out,dirs_exist_ok=True)
# Same business UI and uploads, with the independent same-origin transport.
www=assets/'independent-www'
shutil.copytree(root/'cloudflare-worker/public',www,ignore=shutil.ignore_patterns('assets'),dirs_exist_ok=True)
versions=set()
for html in www.glob('*.html'):versions.update(re.findall(r'assets/(v[^/"\s]+)/',html.read_text()))
(www/'download').mkdir(exist_ok=True)
for version in versions:shutil.copytree(root/'cloudflare-worker/public/assets'/version,www/'assets'/version,dirs_exist_ok=True)
for directory in [www]+[www/'assets'/v for v in versions]:
    for source,target in [('transport.js','primary-transport.js'),('live.js','live-changes.js'),('ota-disabled.js','client-ota.js')]:shutil.copy2(root/'independent-web'/source,directory/target)
(www/'fleet-config.js').write_text('window.FLEET_CONFIG=Object.freeze({apiBase:location.origin,legacyApiBase:"",independent:true});\n')
(www/'independent-owner.js').write_text((root/'independent-web/owner.js').read_text().replace("(value.mode==='primary'?'Κύριο':'Δοκιμαστικό')","(root.FleetBackend?.selection.activeMode==='direct'?'Direct':'Προετοιμασία Direct')").replace("activate.hidden=user.role!=='owner'||value.mode==='primary';","activate.hidden=true;").replace("probe.hidden=activate.hidden=user?.role!=='owner';","probe.hidden=user?.role!=='owner';activate.hidden=true;").replace('Ανεξάρτητη δοκιμή','Direct Android Server'))
for html in www.rglob('*.html'):
    value=html.read_text().replace('</head>','<script src="/independent-owner.js" defer></script></head>').replace('./index.html?embedded=1','./fleet.html?embedded=1')
    html.write_text(value)
for file in www.rglob('portal.js'):file.write_text(file.read_text().replace('./index.html?embedded=1','./fleet.html?embedded=1'))
shell={'/','/portal.html','/fleet.html','/fleet-config.js','/backend-mode.js','/backend-mode.css','/independent-owner.js'}
for html in (www/'index.html',www/'portal.html'):
    for ref in re.findall(r'(?:src|href)=["\']([^"\']+)',html.read_text()):
        path=ref.removeprefix('./').split('?',1)[0].split('#',1)[0].lstrip('/')
        if path and '://' not in path and '..' not in path and (www/path).is_file() and not path.startswith('download/'):
            shell.add('/'+path)
version=json.loads((root/'release-config.json').read_text())
sw=(root/'unified-android/assets/direct-service-worker.js').read_text().replace('__FLEET_VERSION__',version['server']['version']+'-'+version['web']['version']).replace('__FLEET_SHELL__',json.dumps(sorted(shell)))
(www/'service-worker.js').write_text(sw)
print('Prepared namespaced Direct backend, separate storage, same APK identity')

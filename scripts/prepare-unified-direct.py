#!/usr/bin/env python3
"""Compile the proven independent backend in its own namespace/process/storage.

Production classes, SQLite provider and cloud preferences are never rewritten.
The generated source is reproducible from the complete repository archive.
"""
from pathlib import Path
import re, shutil, sys

root=Path(__file__).resolve().parents[1]
out=Path(sys.argv[1]);assets=Path(sys.argv[2])
old='gr.argyrismitsos.fleetserver';new='gr.argyrismitsos.fleetdirect'
destination=out/Path(new.replace('.','/'));destination.mkdir(parents=True,exist_ok=True)
sources={p.name:p for p in (root/'server-android/src'/Path(old.replace('.','/'))).glob('*.java')
         if p.stem not in ('MainActivity','FleetApplication','BootReceiver','BackendMode')}
sources.update({p.name:p for p in (root/'independent-android/src'/Path(old.replace('.','/'))).glob('*.java')})

def change(value,old,new):
    if value.count(old)!=1:raise RuntimeError('Unified source integration drift: '+old[:100])
    return value.replace(old,new)

for name,p in sources.items():
    value=p.read_text().replace(old,new)
    value=value.replace('android.database.sqlite.','org.sqlite.database.sqlite.')
    value=value.replace('import android.database.SQLException;','import org.sqlite.database.SQLException;')
    value=value.replace('import android.database.DatabaseErrorHandler;','import org.sqlite.database.DatabaseErrorHandler;')
    value=value.replace('"ROLLBACK TO ','"/* fleet savepoint */ ROLLBACK TO ')
    value=re.sub(r'\bMainActivity\b',old+'.MainActivity',value)
    imports=('\nimport '+old+'.R;' if re.search(r'\bR\.',value) else '')+('\nimport '+old+'.BackendMode;' if 'BackendMode.' in value or name in ('IndependentRuntime.java','IndependentService.java','IndependentActivity.java') else '')
    value=value.replace('package '+new+';','package '+new+';'+imports)
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
        value=change(value,start,'if(!"'+old+'".equals(c.getPackageName()))')
    if name in ('IndependentActivity.java','IndependentService.java'):
        declaration='public final class '+p.stem+' extends '+('Activity' if 'Activity' in name else 'Service')+' {'
        value=change(value,declaration,declaration+'\n    @Override protected void attachBaseContext(Context base){super.attachBaseContext(new ScopedContext(base));}\n')
    if name=='IndependentActivity.java':
        value=change(value,'IndependentConfig.require(this);build();','IndependentConfig.require(this);try{IndependentSqlite.initialize(this);IndependentRestore.startup(this);}catch(Exception error){getSharedPreferences("independent_ui",MODE_PRIVATE).edit().putString("blocked","Η ασφαλής προετοιμασία Direct χρειάζεται έλεγχο.").commit();}build();')
        value=value.replace('Fleet Independent Server','Fleet — Προετοιμασία Direct')
        value=value.replace('getSharedPreferences("independent_ui",MODE_PRIVATE).getString("mode","test").equals("primary")?"Κύριο":"Δοκιμαστικό"','BackendMode.direct(this)?"Direct":"Προετοιμασία Direct"')
        value=change(value,'hostname=field("Το δικό σου όνομα .duckdns.org",false);','hostname=field("fleet-control.duckdns.org",false);hostname.setText("fleet-control.duckdns.org");hostname.setEnabled(false);')
        # The only production switch is in the existing Server settings.
        value=re.sub(r'        button\("Ενεργοποίηση Android ως κύριου Server".*?(?=\n)', '', value)
    if name=='IndependentRuntime.java':
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
            if(!internal&&!preflight&&!BackendMode.direct(context))return IndependentHttps.error(409,"Επιλεγμένο Cloudflare. Δεν έγινε εγγραφή στη βάση Direct.");
            String epoch=request.getJSONObject("headers").optString("x-fleet-backend-revision",request.getJSONObject("headers").optString("X-Fleet-Backend-Revision"));
            if(!internal&&!preflight&&!epoch.equals(String.valueOf(BackendMode.read(context).getLong("revision"))))return IndependentHttps.error(409,"Η λειτουργία άλλαξε. Ανανέωσε πριν αποθηκεύσεις.");
            if(path.equals("/api/independent/activate"))return IndependentHttps.error(403,"Χρησιμοποίησε τον διακόπτη στις Ρυθμίσεις Server.");
            result=engine.request(request,internal,30000);
        }''')
        value=change(value,'void jobs()throws Exception{','void jobs()throws Exception{try(BackendMode.Guard jobGuard=BackendMode.guard(context)){if(!BackendMode.direct(context))return;')
        value=change(value,'CashSync.tick(context,store);}','CashSync.tick(context,store);}}')
    if name=='IndependentService.java':
        value=change(value,'boolean valid=IndependentTls.valid(this,host);','if(BackendMode.direct(this))OtaManager.check(this,false);boolean valid=IndependentTls.valid(this,host);')
        value=value.replace('invoiceWorker.tick();','try(BackendMode.Guard invoiceGuard=BackendMode.guard(thisContext())){if(BackendMode.direct(thisContext()))invoiceWorker.tick();}')
        value=value.replace('if(blocked())return;IndependentRuntime backend=','if(blocked()||!BackendMode.direct(thisContext()))return;IndependentRuntime backend=')
        value=change(value,'    private boolean blocked()','    private Context thisContext(){return this;}\n    private boolean blocked()')
        value=change(value,'public JSONObject api(JSONObject request)throws Exception{return backend.external(request);}', 'public JSONObject api(JSONObject request)throws Exception{return backend.external(request);}public JSONObject routing()throws Exception{return BackendMode.read(thisContext());}public JSONObject update()throws Exception{return gr.argyrismitsos.fleetupdates.PublicReleaseFeed.latest("client");}')
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
(www/'independent-owner.js').write_text((root/'independent-web/owner.js').read_text().replace("(value.mode==='primary'?'Κύριο':'Δοκιμαστικό')","(root.FleetBackend?.selection.activeMode==='direct'?'Direct':'Προετοιμασία Direct')").replace("activate.hidden=user.role!=='owner'||value.mode==='primary';","activate.hidden=true;").replace("probe.hidden=activate.hidden=user?.role!=='owner';","probe.hidden=user?.role!=='owner';activate.hidden=true;"))
for html in www.rglob('*.html'):
    value=html.read_text().replace('</head>','<script src="/independent-owner.js" defer></script></head>').replace('./index.html?embedded=1','./fleet.html?embedded=1')
    html.write_text(value)
for file in www.rglob('portal.js'):file.write_text(file.read_text().replace('./index.html?embedded=1','./fleet.html?embedded=1'))
(www/'service-worker.js').write_text("self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',event=>event.waitUntil(self.registration.unregister()));\n")
print('Prepared namespaced Direct backend, separate storage, same APK identity')

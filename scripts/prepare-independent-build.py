#!/usr/bin/env python3
"""Build input isolation: never modify production manifests/assets/release configuration."""
import json, pathlib, shutil, re, sys, subprocess
root=pathlib.Path(__file__).resolve().parents[1]
destination=root/'.build/independent-source'
if destination.exists(): shutil.rmtree(destination)
destination.mkdir(parents=True)
for name in ('server-android','client-android','common-android','scripts','cloudflare-worker','server-runtime','android-build-support','third-party','vendor'):
    shutil.copytree(root/name,destination/name,ignore=shutil.ignore_patterns('node_modules','.wrangler','__pycache__'))
shutil.copy2(root/'release-config.json',destination/'release-config.json')
(destination/'cloudflare-worker/node_modules').symlink_to(root/'cloudflare-worker/node_modules',target_is_directory=True)
shutil.copytree(root/'independent-android/src',destination/'server-android/src',dirs_exist_ok=True)
shutil.copy2(root/'independent-android/AndroidManifest.xml',destination/'server-android/AndroidManifest.xml')
# The production source stays on Android's provider. Every staged Server SQL
# open/helper/cursor/exception uses the same bundled engine, including restore.
for java in (destination/'server-android/src').rglob('*.java'):
    value=java.read_text().replace('android.database.sqlite.', 'org.sqlite.database.sqlite.')
    value=value.replace('import android.database.SQLException;', 'import org.sqlite.database.SQLException;')
    value=value.replace('import android.database.DatabaseErrorHandler;', 'import org.sqlite.database.DatabaseErrorHandler;')
    value=value.replace('"ROLLBACK TO ', '"/* fleet savepoint */ ROLLBACK TO ')
    java.write_text(value)
sql=destination/'server-android/src/gr/argyrismitsos/fleetserver/BusinessSqlite.java'
value=sql.read_text()
for old,new in [('},sql,null,null);','},IndependentSqlite.statement(sql),null,null);'),
                ('db.execSQL(sql,args);','db.execSQL(IndependentSqlite.statement(sql),args);'),
                ('db.execSQL(line);','db.execSQL(IndependentSqlite.statement(line));')]:
    if value.count(old)!=1:raise SystemExit('Independent SQLite SQL adapter staging drift: '+old)
    value=value.replace(old,new)
sql.write_text(value)
# These official bindings record the helper WAL preference but do not apply
# it on first open. Configure every independent helper connection explicitly.
store=destination/'server-android/src/gr/argyrismitsos/fleetserver/FleetDataStore.java'
value=store.read_text()
marker='    @Override\\n    public void onCreate(SQLiteDatabase db) {'
if value.count(marker)!=1:raise SystemExit('Independent SQLite helper staging drift')
configure='''    @Override public void onConfigure(SQLiteDatabase db) {
        if(db.isReadOnly())return;
        try{IndependentDatabase.configure(db);}
        catch(Exception error){SQLiteException failure=new SQLiteException("Independent SQLite configuration failed");failure.initCause(error);throw failure;}
    }

'''
value=value.replace(marker,configure+marker).replace('import org.sqlite.database.sqlite.SQLiteDatabase;', 'import org.sqlite.database.sqlite.SQLiteDatabase;\\nimport org.sqlite.database.sqlite.SQLiteException;')
store.write_text(value)
attrs=destination/'android-build-support/fgs-extension/res/values/attrs.xml'
attrs.write_text(attrs.read_text().replace('<flag name="dataSync" value="0x00000001" />','<flag name="dataSync" value="0x00000001" /><flag name="specialUse" value="0x40000000" />'))
# Dedicated Client: remote Android-hosted WebView, distinct package and no production OTA.
shutil.rmtree(destination/'client-android/src')
shutil.copytree(root/'independent-client/src',destination/'client-android/src')
shutil.copy2(root/'independent-client/AndroidManifest.xml',destination/'client-android/AndroidManifest.xml')
shutil.rmtree(destination/'client-android/assets')
(destination/'client-android/assets').mkdir()
www=destination/'server-android/assets/independent-www'
subprocess.run([sys.executable,str(destination/'scripts/prepare-pdf-viewer.py')],check=True,stdout=subprocess.PIPE)
shutil.copytree(destination/'cloudflare-worker/public',www,ignore=shutil.ignore_patterns('assets'))
# Copy only immutable asset versions actually referenced by HTML; do not ship historical releases.
versions=set()
for html in www.glob('*.html'): versions.update(re.findall(r'assets/(v[^/"\s]+)/',html.read_text()))
for version in versions: shutil.copytree(root/'cloudflare-worker/public/assets'/version,www/'assets'/version)
for directory in [www]+[www/'assets'/version for version in versions]:
    for source,target in [('transport.js','primary-transport.js'),('live.js','live-changes.js'),('ota-disabled.js','client-ota.js')]: shutil.copy2(root/'independent-web'/source,directory/target)
(www/'fleet-config.js').write_text('window.FLEET_CONFIG=Object.freeze({apiBase:location.origin,legacyApiBase:"",independent:true});\n')
shutil.copy2(root/'independent-web/owner.js',www/'independent-owner.js')
# Avoid /index.html embedding itself. The fleet module remains the current business UI.
for html in www.rglob('*.html'):
    value=html.read_text().replace('</head>','<script src="/independent-owner.js" defer></script></head>')
    value=value.replace('./index.html?embedded=1','./fleet.html?embedded=1')
    value=re.sub(r'<a\b[^>]*href="\./direct\.html"[^>]*>.*?</a>', '', value)
    html.write_text(value)
for file in www.rglob('portal.js'): file.write_text(file.read_text().replace('./index.html?embedded=1','./fleet.html?embedded=1'))
(www/'service-worker.js').write_text("self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',event=>event.waitUntil(self.registration.unregister()));\n")
# Copy the resulting Web into the APK. Build script's legacy asset preparation is disabled only for this staged tree.
(destination/'ISOLATED_BUILD.json').write_text(json.dumps({'schema':1,'issue':90,'serverApplicationId':'gr.argyrismitsos.fleetserver.independent','clientApplicationId':'gr.argyrismitsos.fleetindependentclient','productionChanged':False},indent=2)+'\n')
print(destination)

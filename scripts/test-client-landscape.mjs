import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url));
const {JSDOM}=require('jsdom');
const xml=new JSDOM(fs.readFileSync('client-android/AndroidManifest.xml','utf8'),{contentType:'text/xml'}).window.document;
const ns='http://schemas.android.com/apk/res/android';
const activity=[...xml.querySelectorAll('activity')].find(n=>n.getAttributeNS(ns,'name')==='.MainActivity');
assert.ok(activity,'Client main activity exists');
assert.ok(['','unspecified','fullUser','user'].includes(activity.getAttributeNS(ns,'screenOrientation')||''),'Client must follow user orientation rather than force portrait/landscape');
for(const element of [xml.querySelector('application'),activity]){
 assert.notEqual(element.getAttributeNS(ns,'resizeableActivity'),'false','Do not opt into a fixed compatibility window');
 assert.ok(!element.hasAttributeNS(ns,'maxAspectRatio'),'Do not constrain the available screen aspect ratio');
}
const changes=new Set((activity.getAttributeNS(ns,'configChanges')||'').split('|'));
for(const change of ['orientation','screenSize','smallestScreenSize','screenLayout','keyboardHidden'])assert.ok(changes.has(change),'Keep live WebView across '+change);
const java=fs.readFileSync('client-android/src/gr/argyrismitsos/fleetcontrol/MainActivity.java','utf8');
const handler=java.match(/public void onConfigurationChanged\(Configuration newConfig\)\s*\{([\s\S]*?)\n    \}/)?.[1];
assert.ok(handler,'Configuration callback present');
assert.match(handler,/super\.onConfigurationChanged\(newConfig\)/);
assert.match(handler,/webView\.requestLayout\(\)/);
assert.doesNotMatch(handler,/loadUrl|reload\(|new WebView|setContentView/,'Rotation must not discard unsaved inputs/dialogs');
assert.match(java,/setUseWideViewPort\(true\)/);
for(const root of ['client-android/assets/www','cloudflare-worker/public']){
 const page=new JSDOM(fs.readFileSync(root+'/portal.html','utf8')).window.document;
 assert.match(page.querySelector('meta[name="viewport"]').content,/width=device-width/);
}
console.log('PASS Client orientation/resizing contract: no portrait/aspect lock; existing WebView retained; device-width Client/Web viewport. Physical Android rotation remains a separate acceptance check.');

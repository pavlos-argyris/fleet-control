// Static manifest inventory only. Does not determine Play Protect verdicts
// or validate signed APK bytes; real-device review remains mandatory.
import fs from 'node:fs';
const permissionPattern=/<uses-permission\b[^>]*android:name="([^"]+)"[^>]*\/?\s*>/g;
const attribute=(tag,name)=>new RegExp('\\bandroid:'+name+'="([^"]*)"').exec(tag)?.[1]??null;
export function inspectAndroidManifest(xml){
 if(typeof xml!=='string'||!xml.includes('<manifest'))throw new TypeError('Invalid Android manifest');
 const app=xml.match(/<application\b[^>]*>/)?.[0];
 if(!app)throw new TypeError('Missing application element');
 const sdk=xml.match(/<uses-sdk\b[^>]*>/)?.[0]||'';
 const permissions=[...xml.matchAll(permissionPattern)].map(m=>m[1]).sort();
 const componentPattern=/<(activity|service|receiver|provider)\b[^>]*>/g;
 const exported=[...xml.matchAll(componentPattern)].filter(m=>attribute(m[0],'exported')==='true').map(m=>({type:m[1],name:attribute(m[0],'name')||'(unnamed)'}));
 const hardening={allowBackupDisabled:attribute(app,'allowBackup')==='false',cleartextTrafficDisabled:attribute(app,'usesCleartextTraffic')==='false',minSdkVersion:attribute(sdk,'minSdkVersion'),targetSdkVersion:attribute(sdk,'targetSdkVersion')};
 const installerPermissions=permissions.filter(p=>/\.(?:REQUEST_INSTALL_PACKAGES|UPDATE_PACKAGES_WITHOUT_USER_ACTION)$/.test(p));
 return {hardening,permissionCount:permissions.length,permissions,installerPermissions,exportedComponents:exported,verdict:'undetermined—requires signed APK and real Play Protect diagnosis'};
}
if(process.argv[1]&&process.argv[1].endsWith('/android-manifest-audit.mjs')){
 const files=['server-android/AndroidManifest.xml','client-android/AndroidManifest.xml'];
 for(const file of files){const result=inspectAndroidManifest(fs.readFileSync(file,'utf8'));console.log(JSON.stringify({file,...result},null,2));if(!result.hardening.allowBackupDisabled||!result.hardening.cleartextTrafficDisabled)process.exitCode=1;}
}

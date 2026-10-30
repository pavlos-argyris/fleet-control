import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {storeSqliteFixture} from './fixtures/native-store-sqlite.mjs';
await import('../cloudflare-worker/public/direct-crypto.js');
const cryptoApi=globalThis.FleetDirectCrypto;
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-direct-')),jar=path.resolve('vendor/json-java/json-20240303.jar');
const now=Date.parse('2026-10-30T10:00:00Z'),password='Έλεγχος 🔑 direct1!';
const user=(id,role,permissions='[]')=>({id,username:id,email:id+'@example.invalid',full_name:'Synthetic '+id,password_salt:'synthetic-salt',password_hash:crypto.pbkdf2Sync(password,'synthetic-salt',100000,32,'sha256').toString('hex'),password_iterations:100000,role,permissions,active:1,login_enabled:1,deleted_at:null});
const snapshot={directCityId:'c',directStoreScope:'scope',workforce:{app_users:[user('owner','owner'),user('manager','manager','["!employees.view"]'),user('employee','employee','["*","employees.view","fleet.view"]')],schedules:[{id:'schedule',employee_id:'owner',start_at:'2026-10-30T10:00:00Z',end_at:'2026-10-30T18:00:00Z',secret:'private'}],ordexa_sessions:[{id:'source',city_id:'c',rider_id:'r',in_at:'2026-10-30T08:00:00Z',out_at:null,raw_json:'private source'}],ordexa_riders:[{city_id:'c',rider_id:'r',employee_id:'owner',name:'Provider label'}],store_billing_records:[{id:'store',scope:'scope',kind:'store',data:'{"name":"Synthetic shop"}'},{id:'order',scope:'scope',kind:'order',data:'{"customer":"PRIVATE"}'}]}};
snapshot.workforce.store_billing_records[0].revision=1;
snapshot.workforce.store_billing_records.push({id:'publication',scope:'scope',kind:'publication',day:'2026-10-30',data:JSON.stringify({complete:true,activeRun:'published',sourceLastSuccessAt:'2026-10-30T09:00:00Z'})},{id:'day',scope:'scope',kind:'day',store_id:'store',day:'2026-10-30',data:JSON.stringify({runId:'published',storeRevision:1,orderCount:3,totalChargeCents:600})},{id:'staging',scope:'scope',kind:'day',store_id:'store',day:'2026-10-30',data:JSON.stringify({runId:'unpublished',storeRevision:1,orderCount:999,totalChargeCents:999999})});
let process;
try{
 const files=storeSqliteFixture(dir);
 fs.writeFileSync(path.join(dir,'Base64.java'),'package android.util;public class Base64{public static final int URL_SAFE=8,NO_WRAP=2,NO_PADDING=1;public static String encodeToString(byte[] b,int f){return java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(b);}public static byte[] decode(String s,int f){return java.util.Base64.getUrlDecoder().decode(s);}}');
 fs.writeFileSync(path.join(dir,'DirectTest.java'),String.raw`import org.json.*;import java.io.*;import android.database.sqlite.*;import gr.argyrismitsos.fleetserver.DirectAccess;
 public class DirectTest{
 public static void main(String[] args)throws Exception{
 final SQLiteDatabase db=new SQLiteDatabase();db.execSQL("CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT)");
 final JSONObject[] snapshot={new JSONObject()},fleet={new JSONObject().put("bikes",new JSONArray().put(new JSONObject().put("id","bike").put("name","Synthetic").put("currentKm",12000).put("secret","hidden")))};
 final String[] at={"2026-10-30T10:00:00Z"};final boolean[] enabled={true};
 DirectAccess.Storage storage=new DirectAccess.Storage(){public JSONObject state()throws Exception{SQLiteStatement q=db.compileStatement("SELECT value FROM settings WHERE key='direct'");String raw;try{raw=q.simpleQueryForString();}catch(SQLiteDoneException e){raw="{}";}finally{q.close();}return new JSONObject(raw).put("enabled",enabled[0]);}public void save(JSONObject value){db.execSQL("INSERT INTO settings(key,value) VALUES('direct',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",new Object[]{value.toString()});}public JSONObject snapshot(JSONObject request){return snapshot[0];}public JSONObject fleet(){return fleet[0];}public String snapshotAt(){return at[0];}};
 JSONObject rules=new JSONObject(new String(java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(args[0])),"UTF-8"));DirectAccess core=new DirectAccess(storage,rules);
 BufferedReader in=new BufferedReader(new InputStreamReader(System.in,"UTF-8"));String line;
 try{while((line=in.readLine())!=null){try{JSONObject command=new JSONObject(line);if(command.optBoolean("createIdentity")){System.out.println(gr.argyrismitsos.fleetserver.DirectCipher.identity());continue;}if(command.has("snapshot"))snapshot[0]=command.getJSONObject("snapshot");if(command.has("at"))at[0]=command.getString("at");if(command.has("enabled"))enabled[0]=command.getBoolean("enabled");if(command.optBoolean("restart"))core=new DirectAccess(storage,rules);if(command.optBoolean("state")){System.out.println(storage.state());continue;}if(command.has("packet")){JSONObject packet=command.getJSONObject("packet"),identity=command.getJSONObject("identity"),clear=gr.argyrismitsos.fleetserver.DirectCipher.open(identity,packet);JSONObject result=core.claimRequest(packet.getString("nonce"),System.currentTimeMillis())?core.handle(clear,command.getLong("now")):new JSONObject().put("status",409).put("body","{}");System.out.println(gr.argyrismitsos.fleetserver.DirectCipher.seal(identity,packet,result));}else System.out.println(core.handle(command.getJSONObject("request"),command.getLong("now")));}catch(Exception e){System.out.println(new JSONObject().put("fixtureError",e.toString()));}}}finally{db.close();}
 }}
 `);
 const compile=['-proc:none','-source','8','-target','8','-encoding','UTF-8','-cp',jar,'-d',dir,...files,path.join(dir,'Base64.java'),path.join(dir,'DirectTest.java'),'server-android/src/gr/argyrismitsos/fleetserver/DirectAccess.java','server-android/src/gr/argyrismitsos/fleetserver/DirectCipher.java'];
 const ecj=path.resolve('.android-toolchain/usr/share/java/eclipse-jdt-core-3.32.0.jar');
 try{if(fs.existsSync(ecj))execFileSync('java',['-jar',ecj,...compile],{stdio:'pipe'});else execFileSync('javac',compile,{stdio:'pipe'});}catch(error){throw Error(String(error.stderr||error));}
 process=spawn('java',['-Dfixture.rpc='+path.join(dir,'sqlite_rpc.py'),'-Dfixture.db='+path.join(dir,'state.sqlite'),'-cp',dir+path.delimiter+jar,'DirectTest',path.resolve('server-android/assets/direct-permissions.json')],{stdio:['pipe','pipe','inherit']});
 const lines=createInterface({input:process.stdout});let waiters=[];lines.on('line',line=>waiters.shift()?.(JSON.parse(line)));
 const command=async (c,expectedError=false)=>{const reply=new Promise(resolve=>waiters.push(resolve));process.stdin.write(JSON.stringify(c)+'\n');const value=await reply;if(expectedError)assert.ok(value.fixtureError);else assert.equal(value.fixtureError,undefined,JSON.stringify(value));return value;};
 const identity=await command({createIdentity:true}),pair=identity.secret+'.'+identity.publicKey;
 const request=async(path,method='GET',body=null,token='',extra={})=>{const exchange=await cryptoApi.request(pair,{path,method,body,headers:token?{Authorization:'Bearer '+token}:{}});const encrypted=await command({now,packet:exchange.packet,identity,...extra});assert.ok(!JSON.stringify(encrypted).includes(password));const r=await exchange.open(encrypted);return {...r,data:JSON.parse(r.body)};};
 let r=await request('/api/direct-local/login','POST',{username:'owner',password},'',{snapshot});assert.equal(r.status,200);const owner=r.data.token;assert.match(owner,/^[A-Za-z0-9_-]{43}$/);
 const secure=await cryptoApi.request(pair,{path:'/api/direct-local/me',method:'GET',headers:{Authorization:'Bearer '+owner}});
 const encrypted=await command({now,identity,packet:secure.packet});assert.equal((await secure.open(encrypted)).status,200);
 assert.equal((await secure.open(await command({now,identity,packet:secure.packet,restart:true}))).status,409,'encrypted replay is rejected after restart');
 const forged={...encrypted,ciphertext:(encrypted.ciphertext[0]==='A'?'B':'A')+encrypted.ciphertext.slice(1)};await assert.rejects(()=>secure.open(forged),/ταυτότητα/);
 const other=await command({createIdentity:true});await command({now,identity:other,packet:secure.packet},true);
 const tampered={...secure.packet,ciphertext:(secure.packet.ciphertext[0]==='A'?'B':'A')+secure.packet.ciphertext.slice(1)};await command({now,identity,packet:tampered},true);
 const stored=await command({state:true});assert.ok(stored.sessions[crypto.createHash('sha256').update(owner).digest('hex')]);assert.ok(!JSON.stringify(stored).includes(owner));assert.ok(!JSON.stringify(stored).includes(password));assert.equal(stored.audit[0].action,'login');
 r=await request('/api/direct-local/me','GET',null,owner,{restart:true});assert.equal(r.status,200,'session survives runtime restart in actual SQLite');assert.deepEqual(r.data.views,['fleet','employees','schedules','shifts','stores']);
 r=await request('/api/direct-local/view/employees','GET',null,owner);assert.equal(r.status,200);assert.equal(r.data.rows.length,3);assert.ok(!r.body.includes('password_'));assert.ok(!r.body.includes('permissions'));
 r=await request('/api/direct-local/view/fleet','GET',null,owner);assert.equal(r.data.rows[0].currentKm,12000);assert.ok(!r.body.includes('hidden'));
 r=await request('/api/direct-local/view/shifts','GET',null,owner);assert.equal(r.data.rows[0].employee_name,'Synthetic owner');assert.equal(r.data.rows[0].in_at,'2026-10-30T08:00:00Z');assert.ok(!r.body.includes('raw_json'));
 r=await request('/api/direct-local/view/stores','GET',null,owner);assert.equal(r.data.rows.length,2);assert.equal(r.data.rows.find(row=>row.day).orderCount,3);assert.ok(!r.body.includes('999999'));assert.ok(!r.body.includes('PRIVATE'));
 const employee=(await request('/api/direct-local/login','POST',{username:'employee',password})).data.token;
 assert.deepEqual((await request('/api/direct-local/me','GET',null,employee)).data.views,[]);
 assert.equal((await request('/api/direct-local/view/employees','GET',null,employee)).status,403,'employee overrides cannot grant management');
 const manager=(await request('/api/direct-local/login','POST',{username:'manager',password})).data.token;
 assert.equal((await request('/api/direct-local/view/employees','GET',null,manager)).status,403,'denied override is preserved');
 assert.equal((await request('/api/direct-local/view/fleet','GET',null,manager)).status,200);
 assert.equal((await request('/api/direct-local/view/fleet','POST',{},owner)).status,409,'no unjournaled offline business writes');
 assert.equal((await request('/api/server/snapshot','GET',null,owner)).status,404,'encrypted transport cannot open private Server APIs');
 assert.equal((await request('/api/direct-local/view/employees')).status,401);
 assert.equal((await request('/api/direct-local/me','GET',null,owner,{now:now+4*3600000+1})).status,401,'session expiry');
 assert.equal((await request('/api/direct-local/me','GET',null,owner,{at:'2026-10-28T10:00:00Z'})).status,503,'stale authorization is rejected');
 assert.equal((await request('/api/direct-local/me','GET',null,owner,{at:'2026-10-30T12:00:00+02:00'})).status,200,'timezone-equivalent snapshot is fresh');
 const changed=structuredClone(snapshot);changed.workforce.app_users[0].active=0;
 assert.equal((await request('/api/direct-local/me','GET',null,owner,{snapshot:changed})).status,401,'deactivation revokes local access');
 changed.workforce.app_users[0].active=1;changed.workforce.app_users[0].password_hash='new credential';
 assert.equal((await request('/api/direct-local/me','GET',null,owner,{snapshot:changed})).status,401,'password change revokes old local sessions');
 await request('/api/direct-local/me','GET',null,owner,{snapshot});
 assert.equal((await request('/api/direct-local/logout','POST',{},owner)).status,200);
 assert.equal((await request('/api/direct-local/me','GET',null,owner)).status,401);
 for(let i=0;i<8;i++)assert.equal((await request('/api/direct-local/login','POST',{username:'owner',password:'wrong'})).status,401);
 assert.equal((await request('/api/direct-local/login','POST',{username:'owner',password})).status,429,'brute-force state survives');
 assert.equal((await request('/api/direct-local/login','POST',{username:'owner',password},'',{now:now+16*60000,restart:true})).status,200);
 assert.equal((await request('/api/direct-local/login','POST',{username:'owner',password},'',{enabled:false})).status,503);
 process.stdin.end();await new Promise(resolve=>process.once('exit',resolve));process=null;
 console.log('OK actual Java/SQLite: pinned ECDH/AES-GCM browser parity, wrong identity/tamper/replay rejection, UTF-8 PBKDF2, restart, expiry/revocation, throttle, scoped views and no cloud I/O.');
}finally{process?.kill();fs.rmSync(dir,{recursive:true,force:true});}

// One small control record and an opaque relay in the existing Durable Object.
// Business rows, credentials, clear requests and response receipts stay on Server.
import {MIRROR_TABLES} from './mirror-delta.js';
import {validDirectPacket,directHash} from './direct-relay.js';

export const PRIMARY_TABLES=[...new Set([...MIRROR_TABLES,
  'fleet_settings','fleet_snapshot','fleet_operations','fleet_sessions','fleet_pin_attempts',
  'auth_sessions','auth_login_attempts','idempotency_keys','ordexa_server_views'
])].sort();
export const PRIMARY_DATA_TABLES=PRIMARY_TABLES.filter(t=>!['auth_sessions','auth_login_attempts','fleet_sessions','fleet_pin_attempts'].includes(t));
const utf8=new TextEncoder(),ID=/^[a-f0-9-]{36}$/,HASH=/^[a-f0-9]{64}$/;
export const primaryJson=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'private, no-store','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type, Authorization, X-Fleet-Server-Key, X-Fleet-Primary-Ticket, X-Fleet-Primary-Proof','Access-Control-Allow-Methods':'GET, POST, OPTIONS','X-Content-Type-Options':'nosniff'}});
const failure=(status,error)=>primaryJson({error},status);
const coordinator=env=>env.FLEET_EVENTS?.get(env.FLEET_EVENTS.idFromName('fleet'));
const invoke=(env,path,body)=>coordinator(env).fetch(new Request('https://events.internal/primary/'+path,{method:'POST',body:JSON.stringify(body||{})}));
async function smallBody(request,max=16384){
  let size=0,text='';const reader=request.body?.getReader(),decoder=new TextDecoder();
  if(reader)for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>max){await reader.cancel();throw Error('body-limit');}text+=decoder.decode(chunk.value,{stream:true});}
  text+=decoder.decode();return JSON.parse(text||'{}');
}
async function serverAllowed(request,env){const v=request.headers.get('X-Fleet-Server-Key')||'';return v.length>=24&&v.length<=512&&env.SERVER_KEY&&await directHash(v)===await directHash(env.SERVER_KEY);}
async function ticket(request,env){const raw=request.headers.get('X-Fleet-Primary-Ticket')||'';if(!/^[A-Za-z0-9_-]{43}$/.test(raw))return null;const r=await invoke(env,'verify',{ticketHash:await directHash(raw)});return r.ok?r.json():null;}
const rows=result=>result.results||[];
const publicDescriptor=state=>({mode:state.mode,generation:state.generation||'',realm:state.realm||'',publicKey:state.publicKey||'',publicSalt:state.publicSalt||'',fingerprint:state.fingerprint||'',connected:!!state.connected});

export async function primaryState(env){if(!env.FLEET_EVENTS)return {mode:'cloud'};const r=await invoke(env,'state');if(!r.ok)throw Error('Authority coordinator unavailable');return r.json();}
async function ownerPassword(env,body){
  if(typeof body.username!=='string'||body.username.length>160||typeof body.password!=='string'||body.password.length>500)return null;
  const user=await env.DB.prepare("SELECT id,username,role,active,login_enabled,deleted_at,password_hash,password_salt,password_iterations FROM app_users WHERE username=? COLLATE NOCASE").bind(body.username.trim()).first();
  if(!user||user.role!=='owner'||!Number(user.active)||Number(user.login_enabled??1)!==1||user.deleted_at)return null;
  const iterations=Number(user.password_iterations||100000);if(iterations<1||iterations>100000)return null;
  const material=await crypto.subtle.importKey('raw',utf8.encode(body.password),'PBKDF2',false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:utf8.encode(user.password_salt),iterations},material,256);
  const hash=[...new Uint8Array(bits)].map(b=>b.toString(16).padStart(2,'0')).join('');
  return HASH.test(user.password_hash)&&await directHash(hash)===await directHash(user.password_hash)?user:null;
}
// The original table allowlist is not an exhaustive inventory of mutable D1
// tables. Fence every business table, including previously unknown tables.
// Release distribution and D1's own migration metadata stay cloud-managed.
const PRIMARY_CLOUD_CONTROL=new Set(['fleet_primary_fence','fleet_releases','d1_migrations']);
const PRIMARY_NON_EXPORT=new Set(['fleet_mirror_state','fleet_mirror_changes','auth_sessions','auth_login_attempts','fleet_sessions','fleet_pin_attempts']);
const SQL_NAME=/^[A-Za-z_][A-Za-z0-9_]{0,120}$/;
async function existingTables(env){
  const names=rows(await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()).map(r=>r.name);
  if(names.some(name=>!SQL_NAME.test(name)))throw Error('Unsupported D1 table name: migration refused');
  return names.filter(name=>!PRIMARY_CLOUD_CONTROL.has(name)&&!name.startsWith('_cf_'));
}
async function exportTables(env){return (await existingTables(env)).filter(name=>!PRIMARY_NON_EXPORT.has(name));}
async function exportColumns(env,table){
  const columns=rows(await env.DB.prepare(`PRAGMA table_info(${table})`).all());
  if(!columns.length||columns.some(c=>!SQL_NAME.test(c.name)||['_primaryRowid','_primaryOversize'].includes(c.name)))throw Error('Unsupported D1 column name: migration refused');
  return columns;
}

async function fence(env,user,ticketHash){
  const tables=await existingTables(env),commands=[
    env.DB.prepare("CREATE TABLE IF NOT EXISTS fleet_primary_fence(id INTEGER PRIMARY KEY CHECK(id=1),mode TEXT NOT NULL DEFAULT 'cloud',ticket_hash TEXT NOT NULL DEFAULT '')"),
    env.DB.prepare("INSERT OR IGNORE INTO fleet_primary_fence(id) VALUES(1)")
  ];
  for(const table of tables)for(const event of ['INSERT','UPDATE','DELETE'])commands.push(env.DB.prepare(`CREATE TRIGGER IF NOT EXISTS primary_fence_${table}_${event.toLowerCase()} BEFORE ${event} ON ${table} WHEN (SELECT mode FROM fleet_primary_fence WHERE id=1) IN ('fenced','active') BEGIN SELECT RAISE(ABORT,'fleet_primary_writer_fenced'); END;`));
  // A table created between enumeration and the atomic D1 batch must prevent
  // activation of a partial fence, even if the owner's password is unchanged.
  commands.push(env.DB.prepare("UPDATE fleet_primary_fence SET mode='fenced',ticket_hash=? WHERE id=1 AND mode='cloud' AND ticket_hash<>? AND EXISTS(SELECT 1 FROM app_users WHERE id=? AND role='owner' AND active=1 AND login_enabled=1 AND deleted_at IS NULL AND password_hash=? AND password_salt=?) AND NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*' AND name NOT IN ('fleet_primary_fence','fleet_releases','d1_migrations') AND name NOT IN (SELECT value FROM json_each(?)))").bind(ticketHash,'cancelled:'+ticketHash,user.id,user.password_hash,user.password_salt,JSON.stringify(tables)));
  const result=await env.DB.batch(commands);return !!result[result.length-1]?.meta?.changes;
}

/** Runs before ensureSchema. No normal D1 access after a committed handover. */
export async function routePrimary(request,env,helpers={}){
  if(env.LOCAL_PRIMARY)return null;
  const url=new URL(request.url),path=url.pathname,isControl=path.startsWith('/api/primary/');
  if(!env.FLEET_EVENTS)return isControl?failure(503,'Η πύλη Server δεν είναι διαθέσιμη.'):null;
  if(isControl&&request.method==='OPTIONS')return primaryJson({});
  // No control lookup for old emergency direct paths; FleetEvents blocks those
  // once primary authority is preparing/active, including an old open socket.
  if(path.startsWith('/api/direct/')||path==='/direct.html')return null;
  const state=await primaryState(env);
  if(path==='/api/primary/descriptor'&&request.method==='GET')return primaryJson(publicDescriptor(state));
  if(path==='/api/primary/request'&&request.method==='POST'){
    if(state.mode!=='active')return failure(503,'Η κύρια βάση Server δεν είναι ενεργή.');
    let packet;try{packet=await smallBody(request,2*1024*1024);}catch{return failure(413,'Το ασφαλές αίτημα είναι μεγάλο ή μη έγκυρο.');}
    if(!validDirectPacket(packet))return failure(400,'Μη έγκυρο ασφαλές αίτημα.');
    return invoke(env,'request',{generation:state.generation,packet});
  }
  if(isControl){
    if(!await serverAllowed(request,env))return failure(401,'Χρειάζεται ο τοπικός Server.');
    if(path==='/api/primary/challenge'&&request.method==='POST')return invoke(env,'challenge',await smallBody(request));
    if(path==='/api/primary/connect'&&request.method==='GET'){
      if(request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return failure(400,'Χρειάζεται ασφαλής σύνδεση Server.');
      return coordinator(env).fetch(new Request('https://events.internal/primary/connect',{headers:{Upgrade:'websocket','X-Fleet-Primary-Proof':request.headers.get('X-Fleet-Primary-Proof')||''}}));
    }
    if(path==='/api/primary/prepare'&&request.method==='POST'){
      const body=await smallBody(request),ticketHash=await directHash(body.ticket||'');
      if(!/^[A-Za-z0-9_-]{43}$/.test(body.ticket||'')||!ID.test(body.generation||'')||!/^[A-Za-z0-9_-]{122}$/.test(body.publicKey||'')||!/^[A-Za-z0-9_-]{43}$/.test(body.publicSalt||'')||!HASH.test(body.recoveryHash||''))return failure(400,'Μη έγκυρη προετοιμασία Server.');
      const resume=await invoke(env,'verify',{ticketHash});
      let resuming=false;
      if(resume.ok){const saved=await resume.json();if(saved.generation!==body.generation||saved.publicKey!==body.publicKey)return failure(409,'Διαφορετική προετοιμασία βρίσκεται σε εξέλιξη.');if(saved.fenced||saved.mode==='active')return primaryJson(saved);resuming=saved.mode==='preparing';}
      if(state.mode!=='cloud'&&!resuming)return failure(409,'Υπάρχει ήδη ενεργή ή εκκρεμής μεταφορά.');
      const throttle=await invoke(env,'attempt',{key:await directHash(request.headers.get('CF-Connecting-IP')||'server')});if(!throttle.ok)return throttle;
      const user=await ownerPassword(env,body);if(!user)return failure(401,'Επιβεβαίωσε τον λογαριασμό ιδιοκτήτη.');
      if(!resuming){const begin=await invoke(env,'begin',{ticketHash,generation:body.generation,publicKey:body.publicKey,publicSalt:body.publicSalt,recoveryHash:body.recoveryHash,realm:url.origin,ownerId:user.id});if(!begin.ok)return begin;}
      const prior=rows(await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fleet_primary_fence'").all());
      if(prior.length){const value=await env.DB.prepare('SELECT mode,ticket_hash FROM fleet_primary_fence WHERE id=1').first();if(value?.mode==='fenced'&&value.ticket_hash===ticketHash)return invoke(env,'fenced',{ticketHash});}
      // This is the only D1 write phase. The final conditional update rechecks
      // the owner in the same transaction as all write-denial triggers.
      if(!await fence(env,user,ticketHash))return failure(409,'Ο λογαριασμός άλλαξε. Η μεταφορά παραμένει σε προετοιμασία· επανάλαβε ή ακύρωσέ την.');
      return invoke(env,'fenced',{ticketHash});
    }
    const verified=await ticket(request,env);if(!verified)return failure(403,'Η άδεια μεταφοράς δεν ισχύει.');
    if(path==='/api/primary/abort'&&request.method==='POST'){
      const reserve=await invoke(env,'start-abort',{ticketHash:verified.ticketHash});if(!reserve.ok)return reserve;
      const result=await env.DB.prepare("UPDATE fleet_primary_fence SET mode='cloud',ticket_hash=? WHERE id=1 AND ticket_hash=? AND mode='fenced'").bind('cancelled:'+verified.ticketHash,verified.ticketHash).run();
      if(!result.meta?.changes){const old=await env.DB.prepare('SELECT mode,ticket_hash FROM fleet_primary_fence WHERE id=1').first();if(old?.mode!=='cloud'||old.ticket_hash!=='cancelled:'+verified.ticketHash)return failure(409,'Δεν επιβεβαιώθηκε η άρση της παλιάς φραγής.');}
      return invoke(env,'abort',{ticketHash:verified.ticketHash});
    }
    if(path==='/api/primary/activate'&&request.method==='POST'){
      const b=await smallBody(request);if(!HASH.test(b.contentHash||'')||b.restoreVerified!==true||b.documentsVerified!==true)return failure(409,'Χρειάζεται πλήρης σύγκριση και πραγματική δοκιμή ανάκτησης.');
      return invoke(env,'activate',{ticketHash:verified.ticketHash,contentHash:b.contentHash,restoreVerified:true,documentsVerified:true});
    }
    if(verified.mode!=='preparing'||!verified.fenced)return failure(409,'Η τελική εξαγωγή απαιτεί ολοκληρωμένη φραγή παλιών εγγραφών.');
    const frozen=await env.DB.prepare("SELECT mode,ticket_hash FROM fleet_primary_fence WHERE id=1").first();if(frozen?.mode!=='fenced'||frozen.ticket_hash!==verified.ticketHash)return failure(409,'Δεν επιβεβαιώθηκε η παλιά βάση.');
    if(path==='/api/primary/inventory'&&request.method==='GET'){
      const names=await exportTables(env),results=await env.DB.batch(names.flatMap(name=>[env.DB.prepare(`PRAGMA table_info(${name})`),env.DB.prepare(`SELECT COUNT(*) rows,COALESCE(MAX(rowid),0) lastRow FROM ${name}`)]));
      const tables=names.map((name,index)=>({name,columns:rows(results[index*2]).map(c=>({name:c.name,type:c.type,notnull:c.notnull,pk:c.pk})),...rows(results[index*2+1])[0]}));
      return primaryJson({schemaVersion:2,generation:verified.generation,realm:verified.realm,tables,excludedTables:[...PRIMARY_NON_EXPORT,...PRIMARY_CLOUD_CONTROL]});
    }
    if(path==='/api/primary/rows'&&request.method==='GET'){
      const table=url.searchParams.get('table'),after=Number(url.searchParams.get('after')||0),limit=Number(url.searchParams.get('limit')||10);
      if(!(await exportTables(env)).includes(table)||!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>25)return failure(400,'Μη έγκυρη σελίδα μεταφοράς.');
      const columns=await exportColumns(env,table);
      // Large text/BLOB values travel in bounded byte slices. A separate
      // descriptor distinguishes a real NULL from a deferred cell.
      const large=c=>`typeof("${c.name}") IN ('text','blob') AND length(CAST("${c.name}" AS BLOB))>4096`;
      const fields=columns.map(c=>`CASE WHEN ${large(c)} THEN NULL ELSE "${c.name}" END AS "${c.name}"`).join(',');
      const metadata=columns.map(c=>`CASE WHEN ${large(c)} THEN json_object('name','${c.name}','bytes',length(CAST("${c.name}" AS BLOB)),'type',typeof("${c.name}")) ELSE NULL END`).join(',');
      const data=rows(await env.DB.prepare(`SELECT rowid AS _primaryRowid,${fields},json_array(${metadata}) AS _primaryOversize FROM ${table} WHERE rowid>? ORDER BY rowid LIMIT ?`).bind(after,limit+1).all());
      const page=data.slice(0,limit);
      if(page.some(r=>!Number.isSafeInteger(r._primaryRowid)||r._primaryRowid<=after))return failure(409,'Η ταυτότητα εγγραφής δεν μεταφέρεται με ασφάλεια.');
      const result={schemaVersion:2,generation:verified.generation,table,rows:page,next:page.length?page[page.length-1]._primaryRowid:after,hasMore:data.length>limit};
      if(utf8.encode(JSON.stringify(result)).length>1500000)return failure(413,'Η σελίδα είναι μεγάλη. Επανάλαβε με μικρότερο limit.');
      return primaryJson(result);
    }
    if(path==='/api/primary/cell'&&request.method==='GET'){
      const table=url.searchParams.get('table'),column=url.searchParams.get('column'),rowid=Number(url.searchParams.get('rowid')),offset=Number(url.searchParams.get('offset')),size=Number(url.searchParams.get('size')||32768);
      if(!(await exportTables(env)).includes(table)||!Number.isSafeInteger(rowid)||rowid<=0||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(size)||size<1||size>32768||offset>Number.MAX_SAFE_INTEGER-size)return failure(400,'Μη έγκυρο τμήμα μεταφοράς.');
      if(!(await exportColumns(env,table)).some(c=>c.name===column))return failure(400,'Μη έγκυρη στήλη μεταφοράς.');
      const value=await env.DB.prepare(`SELECT typeof("${column}") kind,length(CAST("${column}" AS BLOB)) bytes,hex(substr(CAST("${column}" AS BLOB),?,?)) chunk FROM ${table} WHERE rowid=?`).bind(offset+1,size,rowid).first();
      if(!value)return failure(404,'Η εγγραφή μεταφοράς δεν βρέθηκε.');
      if(!['text','blob'].includes(value.kind))return failure(400,'Η στήλη δεν είναι κείμενο ή δυαδικά δεδομένα.');
      if(offset>=value.bytes)return failure(416,'Το τμήμα είναι εκτός ορίων.');
      return primaryJson({schemaVersion:2,generation:verified.generation,table,rowid,column,offset,bytes:value.bytes,kind:value.kind,hex:value.chunk,complete:offset+value.chunk.length/2>=value.bytes});
    }
    if(path==='/api/primary/document'&&request.method==='POST'){
      const b=await smallBody(request);if(typeof b.key!=='string'||b.key.length>500)return failure(400,'Μη έγκυρο τιμολόγιο.');
      const object=await env.SERVICE_DOCS?.get(b.key);if(!object)return failure(404,'Δεν βρέθηκε το αρχείο του τιμολογίου.');const headers=new Headers({'Cache-Control':'no-store','Content-Type':'application/octet-stream'});return new Response(object.body,{headers});
    }
    return failure(404,'Η ενέργεια μεταφοράς δεν βρέθηκε.');
  }
  if(state.mode==='cloud')return null;
  if(helpers.distribution&&(/^\/api\/(deploy\/releases\/|client-update$|server-update$)/.test(path)||path.startsWith('/download/')))return helpers.distribution();
  if(!path.startsWith('/api/'))return env.ASSETS.fetch(request);
  if(path==='/api/events'&&request.method==='GET'&&helpers.events)return helpers.events(state.eventKey);
  return primaryJson({error:state.mode==='preparing'?'Η βάση μεταφέρεται στον Server. Οι αλλαγές δεν έχουν αποθηκευτεί· διατήρησε το προσχέδιο.':'Η ενέργεια χρειάζεται την ασφαλή σύνδεση με τον Server.',code:'primary_transport_required',mode:state.mode,generation:state.generation},503);
}

const decode=s=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
export class PrimaryAuthority {
  constructor(ctx){this.ctx=ctx;this.pending=new Map();this.challenges=new Map();this.ready=ctx.blockConcurrencyWhile(async()=>{this.state=await ctx.storage.get('primary.authority.v1')||{mode:'cloud'};});}
  async change(fn){await this.ready;return this.ctx.storage.transaction(async tx=>{const state=await tx.get('primary.authority.v1')||{mode:'cloud'},result=await fn(state);if(result.save){await tx.put('primary.authority.v1',state);this.state=state;}return result.response;});}
  socket(){return this.ctx.getWebSockets('primary-server').find(ws=>ws.readyState===1&&ws.deserializeAttachment()?.generation===this.state.generation);}
  closeAll(){for(const ws of this.ctx.getWebSockets('primary-server'))try{ws.close(1000,'authority changed');}catch{}this.failPending();}
  async fetch(request){
    await this.ready;const path=new URL(request.url).pathname.slice('/primary/'.length),body=request.method==='POST'?await request.json():{};
    if(path==='state')return primaryJson({...this.state,connected:!!this.socket()});
    if(path==='verify')return ['preparing','aborting','active'].includes(this.state.mode)&&this.state.ticketHash===body.ticketHash?primaryJson(this.state):failure(403,'Η άδεια μεταφοράς δεν ισχύει.');
    if(path==='attempt')return this.change(s=>{const now=Date.now(),attempt=s.attempt||{since:now,count:0};if(now-attempt.since>900000){attempt.since=now;attempt.count=0;}if(attempt.count>=8)return{response:failure(429,'Περίμενε 15 λεπτά πριν επαναλάβεις επιβεβαίωση ιδιοκτήτη.')};attempt.count++;s.attempt=attempt;return{save:true,response:primaryJson({allowed:true})};});
    if(path==='begin')return this.change(s=>{if(s.mode!=='cloud')return{response:failure(409,'Υπάρχει άλλη μεταφορά.')};Object.assign(s,body,{mode:'preparing',fenced:false,eventKey:crypto.randomUUID()+crypto.randomUUID(),fingerprint:''});return{save:true,response:primaryJson({prepared:true})};});
    if(path==='fenced')return this.change(s=>{if(s.mode!=='preparing'||s.ticketHash!==body.ticketHash)return{response:failure(409,'Η μεταφορά άλλαξε.')};s.fenced=true;return{save:true,response:primaryJson(s)};});
    if(path==='start-abort')return this.change(s=>{if(!['preparing','aborting'].includes(s.mode)||!s.fenced||s.ticketHash!==body.ticketHash)return{response:failure(409,'Χρειάζεται πρώτα επιβεβαιωμένη φραγή. Η ενεργή κύρια βάση δεν ακυρώνεται.')};s.mode='aborting';return{save:true,response:primaryJson({reserved:true})};});
    if(path==='abort')return this.change(s=>{if(s.mode!=='aborting'||s.ticketHash!==body.ticketHash)return{response:failure(409,'Η μεταφορά δεν μπορεί να ακυρωθεί.')};for(const k of Object.keys(s))delete s[k];s.mode='cloud';return{save:true,response:primaryJson({aborted:true})};});
    if(path==='activate'){
      const result=await this.change(async s=>{if(s.mode==='active'&&s.ticketHash===body.ticketHash&&s.contentHash===body.contentHash)return{response:primaryJson({active:true,generation:s.generation,contentHash:s.contentHash})};if(s.mode!=='preparing'||!s.fenced||s.ticketHash!==body.ticketHash)return{response:failure(409,'Η μεταφορά άλλαξε.')};s.mode='active';s.contentHash=body.contentHash;s.fingerprint=await directHash(s.publicKey);s.activatedAt=new Date().toISOString();return{save:true,response:primaryJson({active:true,generation:s.generation,contentHash:s.contentHash})};});
      if(result.ok){for(const ws of this.ctx.getWebSockets('direct-server'))try{ws.close(1000,'primary authority active');}catch{}this.closeAll();}return result;
    }
    if(path==='challenge'){
      if(!['preparing','active'].includes(this.state.mode)||body.generation!==this.state.generation)return failure(409,'Η ταυτότητα Server άλλαξε.');
      const nonce=crypto.randomUUID();this.challenges.set(nonce,Date.now()+60000);for(const [id,expires]of this.challenges)if(expires<Date.now())this.challenges.delete(id);if(this.challenges.size>8)this.challenges.delete(this.challenges.keys().next().value);
      return primaryJson({nonce,message:'fleet-primary-connect-v1|'+this.state.realm+'|'+this.state.generation+'|'+nonce});
    }
    if(path==='connect'){
      let proof;try{proof=JSON.parse(request.headers.get('X-Fleet-Primary-Proof')||'');}catch{return failure(401,'Μη έγκυρη ταυτότητα Server.');}
      const expires=this.challenges.get(proof.nonce);this.challenges.delete(proof.nonce);if(!expires||expires<Date.now()||proof.generation!==this.state.generation)return failure(401,'Η επιβεβαίωση Server έληξε.');
      try{const key=await crypto.subtle.importKey('spki',decode(this.state.publicKey),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);if(!await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,decode(proof.signature),utf8.encode('fleet-primary-connect-v1|'+this.state.realm+'|'+this.state.generation+'|'+proof.nonce)))return failure(401,'Δεν επιβεβαιώθηκε ο Server.');}catch{return failure(401,'Δεν επιβεβαιώθηκε ο Server.');}
      this.closeAll();const pair=new WebSocketPair(),server=pair[1];this.ctx.acceptWebSocket(server,['primary-server']);server.serializeAttachment({primary:true,generation:this.state.generation});server.send(JSON.stringify({type:'ready',generation:this.state.generation,leaseMs:30000}));return new Response(null,{status:101,webSocket:pair[0]});
    }
    if(path==='request'){
      if(this.state.mode!=='active'||body.generation!==this.state.generation)return failure(409,'Η κύρια βάση άλλαξε.');const server=this.socket();if(!server)return failure(503,'Ο Server δεν είναι συνδεδεμένος. Το προσχέδιο διατηρείται.');if(this.pending.size>=16)return failure(429,'Ο Server εξυπηρετεί άλλες εργασίες.');
      const id=crypto.randomUUID();return new Promise(resolve=>{const timer=setTimeout(()=>{this.pending.delete(id);resolve(failure(504,'Δεν επιβεβαιώθηκε αποθήκευση. Έλεγξε την κατάσταση πριν επαναλάβεις.'));},25000);this.pending.set(id,{server,packet:body.packet,resolve,timer});try{server.send(JSON.stringify({type:'request',id,generation:this.state.generation,request:body.packet}));}catch{clearTimeout(timer);this.pending.delete(id);resolve(failure(503,'Η σύνδεση Server διακόπηκε.'));}});
    }
    return failure(404,'Η ενέργεια δεν βρέθηκε.');
  }
  message(ws,raw){
    if(typeof raw!=='string'||raw.length>4*1024*1024){try{ws.close(1009,'too large');}catch{}return;}
    const saved=ws.deserializeAttachment();if(saved?.generation!==this.state.generation||this.state.mode!=='active'){try{ws.close(1008,'authority changed');}catch{}return;}
    let value;try{value=JSON.parse(raw);}catch{return;}
    if(value.type==='lease'){ws.send(JSON.stringify({type:'lease',nonce:value.nonce,generation:this.state.generation,leaseMs:30000}));return;}
    const item=this.pending.get(value.id);if(!item||item.server!==ws||!validDirectPacket(value.response)||value.response.nonce!==item.packet.nonce||value.response.epk!==item.packet.epk)return;
    clearTimeout(item.timer);this.pending.delete(value.id);item.resolve(primaryJson(value.response));
  }
  failPending(ws){for(const [id,item]of this.pending)if(!ws||item.server===ws){clearTimeout(item.timer);this.pending.delete(id);item.resolve(failure(503,'Η σύνδεση Server διακόπηκε. Έλεγξε πριν επαναλάβεις αποθήκευση.'));}}
}

(function(root){
  'use strict';
  const rawFetch=root.fetch.bind(root),cipher=root.FleetPrimaryCrypto,storage=root.FleetPrimaryStorage;
  const states=new Map(),flights=new Map(),registered=new Set(),encoder=new TextEncoder(),UUID=/^[a-f0-9-]{36}$/,HASH=/^[a-f0-9]{64}$/;
  const safeHeaders=['authorization','content-type','x-fleet-operation','x-fleet-pin-session','x-admin-pin','x-fleet-pin','x-fleet-client-key','x-fleet-local-ocr','x-idempotency-key'];
  const exempt=/^\/api\/(primary\/|deploy\/releases(?:\/|$)|client-update(?:\/|$)|server-update(?:\/|$))/;
  const withoutReceipt=/^\/api\/(auth|events|native\/files)\//;
  const mutation=method=>!['GET','HEAD','OPTIONS'].includes(method);
  const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
  const failure=(status,error,code)=>new Response(JSON.stringify({error,code}),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  const originKey=origin=>'pin:'+origin;
  const sameIdentity=(a,b)=>a&&b&&['realm','generation','publicKey','publicSalt','fingerprint'].every(key=>a[key]===b[key]);
  function stateFor(origin){if(!states.has(origin))states.set(origin,{origin,mode:'unknown',at:0,descriptor:null,pin:null,cloudPin:null,loading:null,trust:null,bindings:new Map(),intents:new Map(),epoch:0});return states.get(origin);}
  function target(url){
    if(url.protocol!=='https:'||!url.pathname.startsWith('/api/')||exempt.test(url.pathname))return false;
    const config=root.FLEET_CONFIG||{},origins=[config.apiBase,config.legacyApiBase,root.location.origin].filter(Boolean).map(v=>{try{return new URL(v,root.location.href).origin;}catch{return '';}});
    return origins.includes(url.origin)||registered.has(url.origin);
  }
  function report(kind,message,detail={}){
    api.status={kind,message,at:Date.now(),...detail};root.dispatchEvent(new CustomEvent('fleet-primary-state',{detail:api.status}));
    if(!root.document?.body)return;
    try{if(root.parent!==root&&root.parent.document.getElementById('fleetModuleFrame')?.contentWindow===root&&root.parent.FleetPrimary?.frameState){root.parent.FleetPrimary.frameState(api.status,root);return;}}catch{}
    const portal=document.getElementById('portal'),mount=portal&&!portal.classList.contains('is-hidden')?portal.querySelector('.main-shell')||document.body:document.body;
    let banner=document.getElementById('fleetPrimaryStatus');if(!banner){banner=document.createElement('div');banner.id='fleetPrimaryStatus';banner.className='fleet-primary-status';banner.setAttribute('role','status');banner.setAttribute('aria-live','polite');}if(banner.parentNode!==mount)mount.prepend(banner);
    banner.dataset.state=kind;banner.textContent=message;banner.hidden=kind==='cloud';
  }
  function trustDialog(identity,previous){
    return new Promise((resolve,reject)=>{
      const dialog=document.createElement('dialog');dialog.className='app-dialog fleet-primary-trust';dialog.setAttribute('aria-labelledby','fleetPrimaryTrustTitle');
      const form=document.createElement('form');form.method='dialog';
      const title=document.createElement('h2');title.id='fleetPrimaryTrustTitle';title.textContent=previous?'Επιβεβαίωση νέου Server':'Επιβεβαίωση κύριου Server';
      const copy=document.createElement('p');copy.textContent='Στον Server άνοιξε Ρυθμίσεις → Κύρια βάση Server. Σύγκρινε το αποτύπωμα και επικόλλησέ το εδώ πριν συνδεθείς.';
      const fingerprint=document.createElement('code');fingerprint.className='fleet-primary-fingerprint';fingerprint.textContent=identity.fingerprint.match(/.{1,8}/g).join(' ');
      const label=document.createElement('label');label.className='field';const caption=document.createElement('span');caption.textContent='Αποτύπωμα από τον Server';const input=document.createElement('input');input.autocomplete='off';input.spellcheck=false;input.maxLength=100;input.required=true;input.setAttribute('aria-label',caption.textContent);label.append(caption,input);
      const error=document.createElement('p');error.className='form-error';error.setAttribute('role','alert');
      const actions=document.createElement('div');actions.className='dialog-actions';const cancel=document.createElement('button');cancel.type='button';cancel.className='ghost-button';cancel.textContent='Άκυρο';const accept=document.createElement('button');accept.type='submit';accept.className='primary-button';accept.textContent='Επιβεβαίωση σύνδεσης';actions.append(cancel,accept);form.append(title,copy,fingerprint,label,error,actions);dialog.append(form);document.body.append(dialog);
      let completed=false;const close=(ok)=>{if(completed)return;completed=true;dialog.close();dialog.remove();if(ok)resolve();else{const error=Error('Δεν επιβεβαιώθηκε η ταυτότητα Server. Το προσχέδιο διατηρήθηκε.');error.userAction=true;reject(error);}};
      cancel.onclick=()=>close(false);dialog.addEventListener('cancel',event=>{event.preventDefault();close(false);});
      form.onsubmit=event=>{event.preventDefault();if(input.value.replace(/\s/g,'').toLowerCase()!==identity.fingerprint){error.textContent='Το αποτύπωμα δεν συμφωνεί. Έλεγξε την οθόνη του Server.';return;}close(true);};
      dialog.showModal();input.focus();
    });
  }
  async function ensureTrust(state,identity){
    const previous=state.pin||(await storage.read(originKey(state.origin)))?.identity;
    if(sameIdentity(previous,identity)){state.pin=previous;return false;}
    const confirm=async()=>{
      const saved=(await storage.read(originKey(state.origin)))?.identity;if(sameIdentity(saved,identity)){if(state.pin&&!sameIdentity(state.pin,saved)){state.epoch++;state.bindings.clear();await storage.clearReads(state.origin);}state.pin=saved;return;}
      report('trust','Χρειάζεται επιβεβαίωση της ταυτότητας Server. Τα προσχέδια διατηρούνται.');
      await trustDialog(identity,previous);await storage.write({id:originKey(state.origin),kind:'pin',origin:state.origin,identity:{realm:identity.realm,generation:identity.generation,publicKey:identity.publicKey,publicSalt:identity.publicSalt,fingerprint:identity.fingerprint}},true);
      state.pin=identity;state.epoch++;state.bindings.clear();await storage.clearReads(state.origin);root.dispatchEvent(new CustomEvent('fleet-primary-authority',{detail:{origin:state.origin,generation:identity.generation,changed:!!previous}}));
    };
    if(!state.trust)state.trust=(root.navigator?.locks?.request?root.navigator.locks.request('fleet-primary-trust:'+state.origin,confirm):confirm()).finally(()=>{state.trust=null;});
    await state.trust;if(!sameIdentity(state.pin,identity))throw Error('Η ταυτότητα Server άλλαξε στη διάρκεια της επιβεβαίωσης.');return !!previous;
  }
  async function descriptor(state,force=false){
    if(!force&&state.descriptor&&Date.now()-state.at<30000)return state.descriptor;
    if(state.loading)return state.loading;
    state.loading=(async()=>{
      const accepted=await storage.read(originKey(state.origin));state.pin=accepted?.kind==='pin'?accepted.identity:null;state.cloudPin=accepted?.kind==='cloud-pin'?accepted:null;
      const response=await rawFetch(state.origin+'/api/primary/descriptor',{cache:'no-store',credentials:'omit',signal:AbortSignal.timeout?AbortSignal.timeout(10000):undefined});
      let value;try{value=await response.json();}catch{}
      if((response.status===404||response.ok&&!value?.mode)&&!response.headers.get('X-Fleet-Primary-Protocol')&&!state.pin)value={mode:'cloud',legacy:true};
      else if(!response.ok)throw Error('Δεν επιβεβαιώθηκε η κύρια βάση Server.');
      await cipher.descriptor(value,state.origin);
      if(value.mode==='cloud'&&(state.pin||state.cloudPin||value.backend==='cloud-sqlite')){
        const identity=state.pin||state.cloudPin?.identity||{realm:value.realm,generation:value.generation,publicKey:value.publicKey,publicSalt:value.publicSalt,fingerprint:value.fingerprint};
        if(identity.realm!==state.origin||!await cipher.cloudReturn(value,identity)||state.cloudPin&&state.cloudPin.targetId!==value.cloudBusiness)throw Error('Δεν επαληθεύτηκε η υπογεγραμμένη επιστροφή στο Cloudflare. Το προσχέδιο διατηρήθηκε.');
        if(!state.cloudPin){const record={id:originKey(state.origin),kind:'cloud-pin',origin:state.origin,identity,targetId:value.cloudBusiness,certificate:value.cloudReturn};await storage.write(record,true);state.cloudPin=record;state.pin=null;state.epoch++;state.bindings.clear();await storage.clearReads(state.origin);}
      }
      state.mode=value.mode;state.descriptor=value;state.at=Date.now();return value;
    })().finally(()=>{state.loading=null;});return state.loading;
  }
  function cleanHeaders(input){const result={};for(const name of safeHeaders){const value=input.get(name);if(value)result[name]=value;}return result;}
  async function packet(state,identity,request,signal){
    if(signal?.aborted)throw signal.reason||new DOMException('Aborted','AbortError');
    const secured=await cipher.seal(identity,request),response=await rawFetch(state.origin+'/api/primary/request',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'omit',cache:'no-store',body:JSON.stringify(secured.packet),signal});
    if(!response.ok){const error=Error('Δεν επιβεβαιώθηκε η απάντηση Server. Η ενέργεια μπορεί να έχει αποθηκευτεί· επανάλαβε το ίδιο προσχέδιο.');error.offline=[429,502,503,504].includes(response.status);error.uncertain=true;throw error;}
    return secured.open(await response.json());
  }
  async function binding(state,identity,headers,signal){
    const authorization=headers.get('authorization')||'';if(!authorization)return null;
    const key=await cipher.hash(authorization),known=state.bindings.get(key)||(await storage.read('binding:'+state.origin+':'+identity.generation+':'+key));
    if(known&&Date.now()-known.at<30000){state.bindings.set(key,known);return known;}
    const result=await packet(state,identity,{url:state.origin+'/api/auth/me',method:'GET',headers:cleanHeaders(headers)},signal);
    const actor=result.headers['x-fleet-actor'],principal=result.headers['x-fleet-principal'];
    if(result.status!==200||!actor||!HASH.test(principal||'')){await rememberPrincipal(state,identity,headers,result);const error=Error('Επιβεβαίωσε τη σύνδεσή σου πριν αποθηκεύσεις.');error.response=result;throw error;}
    const value={id:'binding:'+state.origin+':'+identity.generation+':'+key,kind:'binding',origin:state.origin,generation:identity.generation,actor,principal,at:Date.now()};
    if(known&&known.principal!==principal)await storage.clearReads(state.origin,known.actor);await storage.write(value);state.bindings.set(key,value);return value;
  }
  async function rememberPrincipal(state,identity,headers,result){
    const authorization=headers.get('authorization')||'',actor=result.headers['x-fleet-actor'],principal=result.headers['x-fleet-principal'];
    if(!authorization)return null;const key=await cipher.hash(authorization),prior=state.bindings.get(key)||(await storage.read('binding:'+state.origin+':'+identity.generation+':'+key));
    if([401,403].includes(result.status)){await storage.clearReads(state.origin,prior?.actor);state.bindings.delete(key);if(prior)await storage.remove(prior.id);return null;}
    if(!actor||!HASH.test(principal||''))return prior||null;
    if(prior&&prior.principal!==principal)await storage.clearReads(state.origin,prior.actor);
    const value={id:'binding:'+state.origin+':'+identity.generation+':'+key,kind:'binding',origin:state.origin,generation:identity.generation,actor,principal,at:Date.now()};await storage.write(value);state.bindings.set(key,value);return value;
  }
  async function intent(state,identity,who,method,url,body,explicit){
    if(!who)throw Error('Η αποθήκευση χρειάζεται επιβεβαιωμένο λογαριασμό.');
    const hash=await cipher.hash(JSON.stringify([method,url,body])),records=await storage.all(),intentKey=who.actor+'|'+identity.generation+'|'+explicit;
    if(explicit){
      const bound=state.intents.get(intentKey),same=records.find(r=>r.kind==='operation'&&r.origin===state.origin&&r.actor===who.actor&&(r.operation===explicit||bound&&r.id===bound.id));
      if(same&&(same.hash!==hash||same.generation!==identity.generation)){const error=Error('Η αρχική αποθήκευση δεν έχει επιβεβαιωθεί. Έλεγξε το ιστορικό πριν αλλάξεις το περιεχόμενο του προσχεδίου.');error.userAction=true;throw error;}
      if(same){state.intents.set(intentKey,same);return same;}
    }
    if(records.some(r=>r.kind==='operation'&&r.origin===state.origin&&r.actor===who.actor&&r.hash===hash&&r.generation!==identity.generation))throw Error('Αυτή η ενέργεια έμεινε ανεπιβεβαίωτη στον προηγούμενο Server. Έλεγξε το ιστορικό πριν από νέα καταχώριση.');
    const id='operation:'+state.origin+':'+identity.generation+':'+who.actor+':'+hash,prior=await storage.read(id);
    if(prior){if(explicit)state.intents.set(intentKey,prior);return prior;}
    if(explicit&&!UUID.test(explicit))throw Error('Μη έγκυρη ταυτότητα ενέργειας.');
    const value=await storage.claim({id,kind:'operation',origin:state.origin,generation:identity.generation,actor:who.actor,hash,path:new URL(url).pathname.split('/').slice(0,4).join('/'),method,operation:explicit||crypto.randomUUID(),at:Date.now()});if(explicit)state.intents.set(intentKey,value);return value;
  }
  const base64=value=>{let text='';for(const byte of value)text+=String.fromCharCode(byte);return btoa(text);};
  async function checkedPacket(state,identity,request,signal){const result=await packet(state,identity,request,signal);if(result.status<200||result.status>=300){const error=Error(JSON.parse(result.body||'{}').error||'Η μεταφορά αρχείου δεν ολοκληρώθηκε.');error.response=result;throw error;}return JSON.parse(result.body||'{}');}
  async function upload(state,identity,headers,blob,description,signal){
    if(blob.size<1||blob.size>15*1024*1024)throw Error('Το αρχείο πρέπει να είναι από 1 byte έως 15 MB.');
    const bytes=new Uint8Array(await blob.arrayBuffer()),sha256=description.sha256||await cipher.hash(bytes);
    const id='upload:'+state.origin+':'+identity.generation+':'+await cipher.hash(JSON.stringify([headers.authorization,description.name,description.type,blob.size,sha256]));
    let transfer=await storage.read(id);if(!transfer){transfer={id,kind:'upload',origin:state.origin,generation:identity.generation,transfer:crypto.randomUUID(),at:Date.now()};await storage.write(transfer,true);}
    const call=(action,body)=>checkedPacket(state,identity,{url:state.origin+'/api/native/files/'+action,method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body)},signal);
    let current=await call('start',{id:transfer.transfer,name:description.name,type:description.type,size:bytes.length,sha256});
    if(!UUID.test(current.ref||'')||!Number.isSafeInteger(current.received)||current.received<0||current.received>bytes.length)throw Error('Δεν επιβεβαιώθηκε η θέση συνέχισης αρχείου.');
    for(let offset=current.received;offset<bytes.length;offset=current.received){const end=Math.min(bytes.length,offset+262144);current=await call('chunk',{ref:transfer.transfer,offset,data:base64(bytes.subarray(offset,end))});if(current.received!==end)throw Error('Δεν επιβεβαιώθηκε το τμήμα αρχείου.');}
    current=await call('finish',{ref:transfer.transfer});if(current.sha256!==sha256||current.size!==bytes.length)throw Error('Δεν συμφωνεί το αποτύπωμα μεταφοράς.');return current;
  }
  async function payload(request){
    const type=request.headers.get('content-type')||'';if(!mutation(request.method))return {wire:{},normalized:null};
    if(type.includes('multipart/form-data')){
      const form=await request.clone().formData(),entries=[...form.entries()].sort(([a],[b])=>a.localeCompare(b)),normalized={},items=[];
      for(const [key,value]of entries){if(Object.hasOwn(normalized,key))throw Error('Το ίδιο πεδίο αρχείου εμφανίζεται περισσότερες φορές.');if(typeof value==='string'){normalized[key]=value;items.push([key,value]);}else{const info={name:value.name||'document',type:value.type||'application/octet-stream',size:value.size,sha256:await cipher.hash(await value.arrayBuffer())};normalized[key]=info;items.push([key,value,info]);}}
      return {items,normalized:{form:normalized}};
    }
    let body=await request.clone().text();if(type.includes('json')&&body)body=JSON.stringify(canonical(JSON.parse(body)));return {wire:{body},normalized:{body}};
  }
  async function wirePayload(state,identity,headers,value,signal){
    if(value.items){const form={};for(const [name,item,info]of value.items)form[name]=info?{ref:(await upload(state,identity,headers,item,info,signal)).ref}:item;delete headers['content-type'];return {form};}
    const body=value.wire.body;if(body&&encoder.encode(body).length>1000000){const blob=new Blob([body],{type:headers['content-type']||'application/json'});return {bodyFile:(await upload(state,identity,headers,blob,{name:'request.json',type:blob.type},signal)).ref};}return value.wire;
  }
  async function download(state,identity,headers,file,signal){
    if(!file||!UUID.test(file.ref||'')||!Number.isSafeInteger(file.size)||file.size<0||file.size>64*1024*1024||!HASH.test(file.sha256||''))throw Error('Μη έγκυρη αναφορά αρχείου Server.');
    const bytes=new Uint8Array(file.size);for(let offset=0;offset<file.size;){const chunk=await checkedPacket(state,identity,{url:state.origin+'/api/native/files/'+file.ref+'?offset='+offset,method:'GET',headers},signal),part=Uint8Array.from(atob(chunk.data),c=>c.charCodeAt(0));if(chunk.offset!==offset||chunk.size!==file.size||chunk.sha256!==file.sha256||part.length!==chunk.length||part.length<1||part.length>262144||part.length>file.size-offset)throw Error('Δεν συμφωνεί το τμήμα λήψης αρχείου.');bytes.set(part,offset);offset+=part.length;}
    if(await cipher.hash(bytes)!==file.sha256)throw Error('Το αρχείο δεν συμφωνεί με το αποτύπωμα Server.');
    packet(state,identity,{url:state.origin+'/api/native/files/release',method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({ref:file.ref})},signal).catch(()=>{});return bytes;
  }
  async function reconstruct(state,identity,headers,result,signal){
    let body=result.body||'';if(result.bodyFile)body=new TextDecoder('utf-8',{fatal:true}).decode(await download(state,identity,headers,result.bodyFile,signal));else if(result.file)body=await download(state,identity,headers,result.file,signal);
    const responseHeaders=new Headers(result.headers);for(const name of ['set-cookie','content-length','transfer-encoding','connection','content-encoding'])responseHeaders.delete(name);responseHeaders.set('X-Fleet-Primary-Generation',identity.generation);responseHeaders.set('X-Fleet-Verified-At',String(Date.now()));
    return new Response([204,205,304].includes(result.status)?null:body,{status:result.status,headers:responseHeaders});
  }
  async function cacheKey(state,identity,headers,url,who){
    if(!who){const auth=headers.get('authorization');if(!auth)return null;const key=await cipher.hash(auth);who=state.bindings.get(key)||(await storage.read('binding:'+state.origin+':'+identity.generation+':'+key));}
    if(!who)return null;return {who,id:'cache:'+state.origin+':'+identity.generation+':'+who.actor+':'+who.principal+':'+await cipher.hash(url)};
  }
  async function cached(state,identity,request){
    if(request.method!=='GET'||!state.pin||!sameIdentity(identity,state.pin)||request.url.includes('/api/native/files/'))return null;
    const key=await cacheKey(state,identity,request.headers,request.url),saved=key&&await storage.read(key.id);if(!saved||Date.now()-saved.at>7*86400000)return null;
    report('offline','Αποθηκευμένα δεδομένα · μόνο προβολή · '+new Date(saved.at).toLocaleString('el-GR'),{dataAt:saved.at,origin:state.origin,generation:identity.generation});return new Response(saved.body,{status:200,headers:{...saved.headers,'X-Fleet-ReadOnly':'1','X-Fleet-Cache-At':String(saved.at)}});
  }
  async function nativeFetch(state,identity,request){
    let operation;const headers=cleanHeaders(request.headers),write=mutation(request.method)&&!withoutReceipt.test(new URL(request.url).pathname);
    try{
      const changed=await ensureTrust(state,identity);if(changed&&write)return failure(409,'Η ταυτότητα Server άλλαξε. Το προσχέδιο διατηρήθηκε· έλεγξε τα στοιχεία και πάτησε ξανά Αποθήκευση.','authority_changed');
      const epoch=state.epoch,who=write?await binding(state,identity,request.headers,request.signal):null,value=await payload(request);
      if(write){operation=await intent(state,identity,who,request.method,request.url,value.normalized,request.headers.get('X-Fleet-Operation'));headers['x-fleet-operation']=operation.operation;}
      const body=await wirePayload(state,identity,headers,value,request.signal),result=await packet(state,identity,{url:request.url,method:request.method,headers,...body},request.signal);
      if(epoch!==state.epoch||((await storage.read(originKey(state.origin)))?.kind!=='pin'||!sameIdentity((await storage.read(originKey(state.origin)))?.identity,identity)))return failure(409,'Η συνεδρία ή η ταυτότητα Server άλλαξε. Το προσχέδιο διατηρήθηκε· έλεγξε ξανά την καταχώριση.','session_changed');
      const principal=await rememberPrincipal(state,identity,request.headers,result),response=await reconstruct(state,identity,headers,result,request.signal);
      if(epoch!==state.epoch)return failure(409,'Η συνεδρία άλλαξε. Το προσχέδιο διατηρήθηκε· έλεγξε ξανά την καταχώριση.','session_changed');
      let code='';try{code=JSON.parse(result.body||'{}').code||'';}catch{}
      if(operation){if(response.ok||response.status>=400&&response.status<500&&![408,429].includes(response.status)&&!['operation_authorization_changed','operation_conflict'].includes(code))await storage.remove(operation.id);if(response.ok)await storage.clearReads(state.origin);}
      if(request.method==='GET'&&response.status===200&&response.headers.get('Content-Type')?.includes('json')&&!request.url.includes('/api/native/files/')){
        try{const key=await cacheKey(state,identity,request.headers,request.url,principal),body=key&&await response.clone().text();if(key&&body.length<=8*1024*1024){await storage.write({id:key.id,kind:'cache',origin:state.origin,generation:identity.generation,actor:key.who.actor,principal:key.who.principal,at:Date.now(),bytes:encoder.encode(body).length,body,headers:{'Content-Type':'application/json','X-Fleet-Primary-Generation':identity.generation}});await storage.trim();}}catch{/* Read cache is optional; the authenticated response remains usable. */}
      }
      if(epoch!==state.epoch||((await storage.read(originKey(state.origin)))?.kind!=='pin'||!sameIdentity((await storage.read(originKey(state.origin)))?.identity,identity))){await storage.clearReads(state.origin,principal?.actor);return failure(409,'Η συνεδρία ή η ταυτότητα Server άλλαξε. Το προσχέδιο διατηρήθηκε.','session_changed');}
      report('online','Server συνδεδεμένος · '+new Date().toLocaleTimeString('el-GR'),{origin:state.origin,generation:identity.generation});return response;
    }catch(error){
      state.at=0;if(error.response)return reconstruct(state,identity,headers,error.response,request.signal);
      if(error.offline||error instanceof TypeError){const saved=await cached(state,identity,request);if(saved)return saved;}
      report('unconfirmed',operation?'Η αποθήκευση δεν επιβεβαιώθηκε. Το προσχέδιο διατηρήθηκε· επανάλαβε την ίδια ενέργεια.':String(error.message||'Δεν επιβεβαιώθηκε η σύνδεση Server.'),{origin:state.origin,generation:identity.generation});
      return failure(error.userAction?409:error.name==='AbortError'?408:503,error.message||'Δεν ήταν δυνατή η σύνδεση με τον Server.',operation?'operation_unconfirmed':'primary_unavailable');
    }
  }
  async function cloudFetch(state,request){
    if(!state.cloudPin)return rawFetch(request.clone());const identity=state.cloudPin.identity,epoch=state.epoch;let operation;
    try{
      const headers=new Headers(request.headers),write=mutation(request.method)&&!withoutReceipt.test(new URL(request.url).pathname);
      let value;if(write){
        const check=await rawFetch(state.origin+'/api/auth/me',{headers:{Authorization:headers.get('authorization')||''},cache:'no-store',signal:request.signal});
        const who=await rememberPrincipal(state,identity,headers,{status:check.status,headers:Object.fromEntries(check.headers)});if(!check.ok)return check;if(!who?.actor)return failure(401,'Χρειάζεται επιβεβαίωση λογαριασμού.','cloud_auth_required');
        value=await payload(request);operation=await intent(state,identity,who,request.method,request.url,value.normalized,headers.get('x-fleet-operation')||'');headers.set('X-Fleet-Operation',operation.operation);
      }
      const wire=write&&!value.items?new Request(request,{headers,body:value.wire.body}):new Request(request,{headers});
      const response=await rawFetch(wire),principal=await rememberPrincipal(state,identity,headers,{status:response.status,headers:Object.fromEntries(response.headers)});
      const accepted=await storage.read(originKey(state.origin));if(epoch!==state.epoch||accepted?.kind!=='cloud-pin'||accepted.targetId!==state.cloudPin.targetId)return failure(409,'Η συνεδρία ή η κύρια βάση άλλαξε. Το προσχέδιο διατηρήθηκε.','session_changed');
      if(operation){let code='';try{code=(await response.clone().json()).code||'';}catch{}if(response.ok||response.status>=400&&response.status<500&&![408,429].includes(response.status)&&!['operation_authorization_changed','operation_conflict'].includes(code))await storage.remove(operation.id);}
      report('cloud','');return response;
    }catch(error){report('unconfirmed',operation?'Η αποθήκευση στο Cloudflare δεν επιβεβαιώθηκε. Επανάλαβε το ίδιο προσχέδιο.':String(error.message||'Δεν επιβεβαιώθηκε η σύνδεση Cloudflare.'));return failure(503,error.message||'Δεν επιβεβαιώθηκε η σύνδεση Cloudflare.',operation?'operation_unconfirmed':'cloud_unavailable');}
  }
  async function fetchPrimary(input,init){
    const request=new Request(input instanceof Request?input:new URL(String(input),root.location.href),init),url=new URL(request.url);if(!target(url))return rawFetch(input,init);
    const state=stateFor(url.origin);let identity;
    try{identity=await descriptor(state);}catch(error){if(state.pin){const saved=await cached(state,state.pin,request);if(saved)return saved;}return failure(503,error.message,'primary_unavailable');}
    if(identity.mode==='cloud'){
      const response=await cloudFetch(state,request);if(response.status===503){let data;try{data=await response.clone().json();}catch{}if(data?.code==='primary_transport_required'){state.at=0;try{identity=await descriptor(state,true);}catch(error){return failure(503,error.message,'primary_unavailable');}if(identity.mode==='active')return nativeFetch(state,identity,request);}}
      report('cloud','');return response;
    }
    if(identity.mode!=='active'){const saved=state.pin&&await cached(state,state.pin,request);if(saved)return saved;report('transition','Η βάση Server προετοιμάζεται. Τα προσχέδια διατηρούνται.');return failure(503,'Η βάση Server προετοιμάζεται. Δοκίμασε ξανά χωρίς να κλείσεις το προσχέδιο.','primary_transition');}
    if(!mutation(request.method)){
      const key='read:'+await cipher.hash(JSON.stringify([state.origin,identity.generation,request.method,request.url,cleanHeaders(request.headers)]));if(flights.has(key))return(await flights.get(key)).clone();const pending=nativeFetch(state,identity,request);flights.set(key,pending);try{return(await pending).clone();}finally{if(flights.get(key)===pending)flights.delete(key);}
    }
    if(withoutReceipt.test(url.pathname))return nativeFetch(state,identity,request);
    const value=await payload(request),key=await cipher.hash(JSON.stringify([state.origin,identity.generation,request.headers.get('authorization'),request.method,request.url,value.normalized]));if(flights.has(key))return (await flights.get(key)).clone();const pending=nativeFetch(state,identity,request);flights.set(key,pending);try{return (await pending).clone();}finally{if(flights.get(key)===pending)flights.delete(key);}
  }
  async function pendingOperations(){const actors=new Set([...states.values()].flatMap(s=>[...s.bindings.values()].map(b=>s.origin+'|'+b.actor)));return(await storage.all()).filter(v=>v.kind==='operation'&&actors.has(v.origin+'|'+v.actor)).map(({origin,generation,actor,operation,at,path,method})=>({origin,generation,actor,operation,at,path,method}));}
  const api={status:{kind:'unknown'},fetch:fetchPrimary,registerOrigin(value){try{const url=new URL(value||root.location.href,root.location.href);if(url.protocol==='https:')registered.add(url.origin);}catch{}},protects:()=>[...states.values()].some(s=>s.mode!=='cloud'||s.pin),async prepare(input){const url=new URL(String(input),root.location.href);if(!target(url))return false;try{return(await descriptor(stateFor(url.origin))).mode!=='cloud';}catch{return true;}},generation:origin=>states.get(origin||new URL(root.FLEET_CONFIG?.apiBase||root.location.href).origin)?.pin?.generation||'',async clearReads(){await storage.clearReads();},async clearSession(){for(const state of states.values()){state.bindings.clear();state.epoch++;}for(const value of await storage.all())if(value.kind==='cache'||value.kind==='binding')await storage.remove(value.id);root.dispatchEvent(new CustomEvent('fleet-primary-pending'));},pending:pendingOperations,async resolvePending(operation,decision){if(!['already_saved','not_found'].includes(decision))throw Error('Διάλεξε το αποτέλεσμα ελέγχου.');const allowed=(await pendingOperations()).some(r=>r.operation===operation);if(!allowed)throw Error('Η εκκρεμότητα δεν ανήκει στον συνδεδεμένο λογαριασμό.');const record=(await storage.all()).find(r=>r.kind==='operation'&&r.operation===operation);if(!record)throw Error('Η εκκρεμότητα άλλαξε. Ανανέωσε την προβολή.');await storage.claim({...record,id:'resolved-operation:'+operation,kind:'resolved-operation',decision,reviewedAt:Date.now()});await storage.remove(record.id);root.dispatchEvent(new CustomEvent('fleet-primary-pending'));}};
  root.FleetPrimary=api;root.fetch=fetchPrimary;root.addEventListener('fleet-shared-invalidation',()=>api.clearReads().catch(()=>{}));
  api.frameState=(value,source)=>{if(document.getElementById('fleetModuleFrame')?.contentWindow===source&&value&&typeof value.message==='string')report(value.kind,value.message,{origin:value.origin,generation:value.generation,dataAt:value.dataAt});};
})(window);

(function(root){
 'use strict';
 const network=root.fetch.bind(root),origin=root.location.origin,mutating=method=>!['GET','HEAD','OPTIONS'].includes(method),prefix='fleet-independent-operation:',storage=root.FleetPrimaryStorage;
 let generation='',userId='';
 const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
 function fail(message,status=503){return new Response(JSON.stringify({error:message,code:'independent_unavailable'}),{status,headers:{'Content-Type':'application/json'}});}
 function announce(kind,message){root.dispatchEvent(new CustomEvent('fleet-primary-state',{detail:{kind,message}}));}
 function base64(bytes){let value='';for(const byte of bytes)value+=String.fromCharCode(byte);return btoa(value);}
 async function uploaded(file,headers){
  const bytes=new Uint8Array(await file.arrayBuffer()),digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
  const call=async(action,body)=>{const response=await network(origin+'/api/native/files/'+action,{method:'POST',credentials:'same-origin',headers:{Authorization:headers.get('Authorization')||'','Content-Type':'application/json'},body:JSON.stringify(body)});const value=await response.json();if(!response.ok)throw Error(value.error||'Η μεταφόρτωση απέτυχε.');return value;};
  if(!storage)throw Error('Δεν υποστηρίζεται ασφαλής προσωρινή αποθήκευση.');
  const transferKey='independent-upload:'+await hash([origin,headers.get('Authorization')||userId,file.name,file.type,bytes.length,digest].join('|'));
  const transfer=await storage.claim({id:transferKey,kind:'independent-upload',transfer:crypto.randomUUID(),at:Date.now()});
  const start=await call('start',{id:transfer.transfer,name:file.name,type:file.type||'application/octet-stream',size:file.size,sha256:digest});
  if(!Number.isSafeInteger(start.received)||start.received<0||start.received>bytes.length)throw Error('Δεν επιβεβαιώθηκε η θέση συνέχισης αρχείου.');
  for(let offset=start.received;offset<bytes.length;){const end=Math.min(bytes.length,offset+262144),saved=await call('chunk',{ref:start.ref,offset,data:base64(bytes.subarray(offset,end))});if(saved.received!==end)throw Error('Δεν επιβεβαιώθηκε το τμήμα αρχείου.');offset=end;}
  const finished=await call('finish',{ref:start.ref});if(finished.sha256!==digest||finished.size!==bytes.length)throw Error('Δεν συμφωνεί το αποτύπωμα μεταφοράς.');return {value:{ref:start.ref},signature:{name:file.name,type:file.type,size:file.size,sha256:digest}};
 }
 async function fetchLocal(input,init){
  let request;try{request=new Request(input,init);}catch{return fail('Μη έγκυρο αίτημα.',400);}const url=new URL(request.url);
  if(url.origin!==origin)return fail('Η ανεξάρτητη εγκατάσταση συνδέεται μόνο στον δικό της Android Server.',403);
  if(!url.pathname.startsWith('/api/'))return network(request);
  if(/^\/api\/(primary|direct|deploy)\//.test(url.pathname)||/^\/api\/(client-update|server-update)$/.test(url.pathname))return fail('Αυτή η υπηρεσία δεν χρησιμοποιείται στην ανεξάρτητη εγκατάσταση.',410);
  const headers=new Headers(request.headers),method=request.method;let body,signature='',pendingKey='';
  try{
   if(mutating(method)){
    if(request.headers.get('content-type')?.startsWith('multipart/form-data')){
     const form=await request.clone().formData(),values={},normalized={};
     for(const [name,value]of form){if(value instanceof Blob){const result=await uploaded(value,headers);values[name]=result.value;normalized[name]=result.signature;}else values[name]=normalized[name]=value;}
     body=JSON.stringify({form:values});signature=JSON.stringify(normalized);headers.set('Content-Type','application/vnd.fleet-form+json');
    }else{body=await request.clone().text();signature=body;}
    if(!/^\/api\/(auth|native\/files)\//.test(url.pathname)){
     pendingKey=prefix+await hash([origin,headers.get('Authorization')||userId,method,url.href,signature].join('\n'));
     if(!storage)throw Error('Δεν υποστηρίζεται ασφαλής αποθήκευση ταυτότητας ενέργειας.');
     const record=await storage.claim({id:pendingKey,kind:'independent-operation',operation:crypto.randomUUID(),at:Date.now(),path:url.pathname,userId,origin});
     headers.set('X-Fleet-Operation',record.operation);
    }
   }
   const response=await network(url.href,{method,headers,body,credentials:'same-origin',cache:'no-store',signal:request.signal,redirect:'error'});
   if(pendingKey){let code='';try{code=(await response.clone().json()).code||'';}catch{}if(response.ok||response.status>=400&&response.status<500&&![408,429].includes(response.status)&&!['operation_conflict','operation_authorization_changed'].includes(code))await storage.remove(pendingKey);}
   if(['/api/auth/user-login','/api/auth/me'].includes(url.pathname)&&response.ok){const data=await response.clone().json();userId=data.user?.id||'';root.dispatchEvent(new CustomEvent('fleet-independent-auth',{detail:data.user}));}
   if(response.status===401)root.dispatchEvent(new CustomEvent('fleet-independent-auth',{detail:null}));
   announce('online','Android Server online');const verifiedHeaders=new Headers(response.headers);if(generation)verifiedHeaders.set('X-Fleet-Primary-Generation',generation);verifiedHeaders.set('X-Fleet-Verified-At',String(Date.now()));return new Response([204,205,304].includes(response.status)?null:response.body,{status:response.status,statusText:response.statusText,headers:verifiedHeaders});
  }catch{announce('offline','Server εκτός σύνδεσης. Η αποθήκευση δεν επιβεβαιώθηκε.');root.dispatchEvent(new CustomEvent('fleet-primary-pending'));return fail(mutating(method)?'Η αποθήκευση δεν επιβεβαιώθηκε. Το προσχέδιο διατηρείται· έλεγξε πριν επαναλάβεις.':'Server εκτός σύνδεσης. Τα δεδομένα που φαίνονται μπορεί να είναι παλιά.');}
 }
 root.fetch=fetchLocal;
 root.FleetPrimary={fetch:fetchLocal,registerOrigin(){},protects:()=>true,prepare:async()=>true,generation:()=>generation,status:{kind:'independent'},clearReads:async()=>{},clearSession:async()=>{userId='';root.dispatchEvent(new CustomEvent('fleet-independent-auth',{detail:null}));},pending:async()=>storage?(await storage.all()).filter(r=>r.kind==='independent-operation'&&r.userId===userId&&r.origin===origin):[],resolvePending:async(operation,decision)=>{if(!['already_saved','not_found'].includes(decision))throw Error('Διάλεξε αποτέλεσμα ελέγχου.');for(const row of await storage.all())if(row.kind==='independent-operation'&&row.origin===origin&&row.operation===operation&&row.userId===userId)await storage.remove(row.id);root.dispatchEvent(new CustomEvent('fleet-primary-pending'));},frameState(){}};
 root.addEventListener('fleet-independent-instance',event=>{generation=event.detail?.instanceId||'';});
})(window);

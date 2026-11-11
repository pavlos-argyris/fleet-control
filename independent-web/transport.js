(function(root){
 'use strict';
 const network=root.fetch.bind(root),origin=root.location.origin,mutating=method=>!['GET','HEAD','OPTIONS'].includes(method),prefix='fleet-independent-operation:';
 let generation='',userId='';
 const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
 function fail(message,status=503){return new Response(JSON.stringify({error:message,code:'independent_unavailable'}),{status,headers:{'Content-Type':'application/json'}});}
 function announce(kind,message){root.dispatchEvent(new CustomEvent('fleet-primary-state',{detail:{kind,message}}));}
 function base64(bytes){let value='';for(const byte of bytes)value+=String.fromCharCode(byte);return btoa(value);}
 async function uploaded(file,headers){
  const bytes=new Uint8Array(await file.arrayBuffer()),digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
  const call=async(action,body)=>{const response=await network(origin+'/api/native/files/'+action,{method:'POST',credentials:'same-origin',headers:{Authorization:headers.get('Authorization')||'','Content-Type':'application/json'},body:JSON.stringify(body)});const value=await response.json();if(!response.ok)throw Error(value.error||'Η μεταφόρτωση απέτυχε.');return value;};
  const start=await call('start',{id:crypto.randomUUID(),name:file.name,type:file.type||'application/octet-stream',size:file.size,sha256:digest});
  for(let offset=0;offset<bytes.length;offset+=262144)await call('chunk',{ref:start.ref,offset,data:base64(bytes.subarray(offset,offset+262144))});
  await call('finish',{ref:start.ref});return {value:{ref:start.ref},signature:{name:file.name,type:file.type,size:file.size,sha256:digest}};
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
     let record;try{record=JSON.parse(sessionStorage.getItem(pendingKey)||'null');}catch{}
     if(!record){record={operation:crypto.randomUUID(),at:Date.now(),path:url.pathname,userId};sessionStorage.setItem(pendingKey,JSON.stringify(record));}
     headers.set('X-Fleet-Operation',record.operation);
    }
   }
   const response=await network(url.href,{method,headers,body,credentials:'same-origin',cache:'no-store',signal:request.signal,redirect:'error'});
   if(response.ok&&pendingKey)sessionStorage.removeItem(pendingKey);
   if(response.status<500&&response.status!==408&&pendingKey)sessionStorage.removeItem(pendingKey);
   if(['/api/auth/user-login','/api/auth/me'].includes(url.pathname)&&response.ok){const data=await response.clone().json();userId=data.user?.id||'';root.dispatchEvent(new CustomEvent('fleet-independent-auth',{detail:data.user}));}
   if(response.status===401)root.dispatchEvent(new CustomEvent('fleet-independent-auth',{detail:null}));
   announce('online','Android Server online');return response;
  }catch{announce('offline','Server εκτός σύνδεσης. Η αποθήκευση δεν επιβεβαιώθηκε.');root.dispatchEvent(new CustomEvent('fleet-primary-pending'));return fail(mutating(method)?'Η αποθήκευση δεν επιβεβαιώθηκε. Το προσχέδιο διατηρείται· έλεγξε πριν επαναλάβεις.':'Server εκτός σύνδεσης. Τα δεδομένα που φαίνονται μπορεί να είναι παλιά.');}
 }
 root.fetch=fetchLocal;
 root.FleetPrimary={fetch:fetchLocal,registerOrigin(){},protects:()=>true,prepare:async()=>true,generation:()=>generation,status:{kind:'independent'},clearReads:async()=>{},clearSession:async()=>{userId='';root.dispatchEvent(new CustomEvent('fleet-independent-auth',{detail:null}));},pending:async()=>Object.keys(sessionStorage).filter(k=>k.startsWith(prefix)).map(k=>JSON.parse(sessionStorage.getItem(k))).filter(r=>r.userId===userId),resolvePending:async(operation,decision)=>{if(!['already_saved','not_found'].includes(decision))throw Error('Διάλεξε αποτέλεσμα ελέγχου.');for(const key of Object.keys(sessionStorage))if(key.startsWith(prefix)){const row=JSON.parse(sessionStorage.getItem(key));if(row.operation===operation&&row.userId===userId)sessionStorage.removeItem(key);}},frameState(){}};
 root.addEventListener('fleet-independent-instance',event=>{generation=event.detail?.instanceId||'';});
})(window);

(function(root){
 'use strict';
 const PREFIX='fleet-shared-read-v1:',pending=new Map(),realms=new Map();let activeRealm='',bus=null,epoch=0;
 const allowed=p=>/^\/api\/(status$|snapshot(?:\?|$)|sync(?:\?|$)|workforce\/(dashboard|vehicles|employees|shifts|schedules)(?:\/|\?|$)|admin\/(service-documents|alerts|server-health|invoice-reader-rules)(?:\?|$))/.test(p);
 async function realm(owner,token){
  if(!owner?.id||!token||!root.crypto?.subtle)return '';
  const input=String(owner.id)+'|'+JSON.stringify([...(owner.permissions||[])].sort())+'|'+token;
  if(!realms.has(input))realms.set(input,root.crypto.subtle.digest('SHA-256',new TextEncoder().encode(input)).then(v=>Array.from(new Uint8Array(v),b=>b.toString(16).padStart(2,'0')).join('')));
  return realms.get(input);
 }
 function get(key){try{return JSON.parse(localStorage.getItem(key)||'null');}catch{return null;}}
 function generation(id=activeRealm){return String(get(PREFIX+id+':generation')||'0');}
 function activate(id){if(id===activeRealm)return;bus?.close();activeRealm=id;bus=null;if(id&&typeof BroadcastChannel!=='undefined'){try{bus=new BroadcastChannel('fleet-reads:'+id);bus.onmessage=e=>{if(activeRealm!==id)return;if(e.data?.type==='clear'){clear(true);return;}if(e.data?.type==='invalidate')root.dispatchEvent(new CustomEvent('fleet-shared-invalidation',{detail:e.data}));};}catch{}}}
 function invalidate(scopes=['fleet','invoices','workforce','status']){
  if(!activeRealm)return;const value=Date.now()+':'+Math.random();try{localStorage.setItem(PREFIX+activeRealm+':generation',JSON.stringify(value));}catch{}
  bus?.postMessage({type:'invalidate',scopes});root.dispatchEvent(new CustomEvent('fleet-shared-invalidation',{detail:{type:'invalidate',scopes}}));
 }
 async function sharedFetch(url,init,owner,options={}){
  init=init||{};const path=new URL(url,root.location.href).pathname+new URL(url,root.location.href).search;
  if((init.method||'GET')!=='GET'||!allowed(path))return root.fetch(url,init);
  const guard=epoch,headers=new Headers(init.headers||{}),token=(headers.get('Authorization')||'').replace(/^Bearer\s+/i,''),id=await realm(owner,token);
  if(guard!==epoch)throw new Error('Η συνεδρία άλλαξε.');if(!id)return root.fetch(url,init);activate(id);
  const ttl=Math.min(300000,Math.max(0,Number(options.ttl??15000))),key=PREFIX+id+':'+path,revision=generation(id),flight=key+':'+revision+':'+Boolean(options.force);
  if(pending.has(flight))return (await pending.get(flight)).clone();
  const load=async()=>{
   const saved=get(key);if(!options.force&&ttl&&saved&&saved.generation===generation(id)&&Date.now()-saved.at<ttl)return new Response(saved.body,{status:200,headers:saved.headers});
   const before=generation(id),response=await root.fetch(url,init);
   if(response.ok&&response.status===200&&response.headers.get('Content-Type')?.includes('json')&&guard===epoch&&activeRealm===id&&before===generation(id)){
    const body=await response.clone().text();if(body.length<=1500000)try{localStorage.setItem(key,JSON.stringify({at:Date.now(),generation:before,body,headers:{'Content-Type':'application/json','X-Fleet-Local-Cache':'1'}}));}catch{}
   }
   return response;
  };
  const promise=root.navigator.locks?.request?root.navigator.locks.request('fleet-read:'+id+':'+path,load).catch(e=>{if(['SecurityError','NotSupportedError'].includes(e.name))return load();throw e;}):load();pending.set(flight,promise);
  try{return (await promise).clone();}finally{if(pending.get(flight)===promise)pending.delete(flight);}
 }
 function clear(remote=false){epoch++;if(!remote)bus?.postMessage({type:"clear"});try{for(let i=localStorage.length-1;i>=0;i--){const key=localStorage.key(i);if(key?.startsWith(PREFIX))localStorage.removeItem(key);}}catch{}bus?.close();bus=null;activeRealm='';pending.clear();realms.clear();}
 root.FleetSharedReads={fetch:sharedFetch,invalidate,clear,generation,realm};
})(window);

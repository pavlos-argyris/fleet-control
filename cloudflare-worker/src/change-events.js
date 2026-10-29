// Signals contain scope names only. All data reads still pass their normal authorization.
const encoder=new TextEncoder();
const scopes=['fleet','invoices','workforce','status'];
function base64(bytes){let s='';for(const b of bytes)s+=String.fromCharCode(b);return btoa(s).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');}
function unbase64(s){return Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));}
async function key(env){const secret=env.SERVER_KEY||env.PIN_PEPPER;if(typeof secret!=='string'||secret.length<16)throw new Error('Event signing is not configured');return crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);}
export async function makeTicket(env,actor){
 const permissions=actor.permissions||[],all=permissions.includes('*');
 const allowed=['workforce'];if(all||permissions.includes('fleet.view'))allowed.push('fleet','invoices');if(all||permissions.some(p=>['server.manage','backup.manage','dashboard.view'].includes(p)))allowed.push('status');
 const now=Date.now(),payload={scopes:allowed,exp:now+60000,until:Math.min(now+900000,Number(actor.expires_at||0)*1000||now+900000),nonce:crypto.randomUUID()};
 const raw=base64(encoder.encode(JSON.stringify(payload))),signature=await crypto.subtle.sign('HMAC',await key(env),encoder.encode(raw));return raw+'.'+base64(new Uint8Array(signature));
}
export async function readTicket(env,ticket){
 try{if(typeof ticket!=='string'||ticket.length>1500)return null;const [raw,signature]=ticket.split('.');if(!raw||!signature||!await crypto.subtle.verify('HMAC',await key(env),unbase64(signature),encoder.encode(raw)))return null;
 const value=JSON.parse(new TextDecoder().decode(unbase64(raw)));if(value.exp<Date.now()||value.until<=Date.now()||value.until>Date.now()+901000||!Array.isArray(value.scopes)||value.scopes.some(s=>!scopes.includes(s)))return null;return value;
 }catch{return null;}
}
export async function routeChangeEvents(request,env,authenticate,json){
 const url=new URL(request.url);if(!url.pathname.startsWith('/api/events'))return null;
 if(!env.FLEET_EVENTS)return json({available:false},503);
 if(url.pathname==='/api/events/ticket'&&request.method==='POST'){
  let actor;try{actor=await authenticate(request,env);}catch{return json({error:'Χρειάζεται σύνδεση.'},401);}
  return json({ticket:await makeTicket(env,actor),path:'/api/events',expiresIn:60});
 }
 if(url.pathname==='/api/events'&&request.method==='GET'&&request.headers.get('Upgrade')?.toLowerCase()==='websocket'){
  const ticket=await readTicket(env,url.searchParams.get('ticket'));if(!ticket)return json({error:'Η σύνδεση ειδοποιήσεων έληξε.'},401);
  return env.FLEET_EVENTS.get(env.FLEET_EVENTS.idFromName('fleet')).fetch(new Request('https://events.internal/connect',{headers:{Upgrade:'websocket','X-Fleet-Scopes':JSON.stringify(ticket.scopes),'X-Fleet-Until':String(ticket.until)}}));
 }
 return json({error:'Μη έγκυρη διαδρομή ειδοποιήσεων.'},404);
}
export function changedScopes(request){
 const p=new URL(request.url).pathname;
 if(!['POST','PUT','PATCH','DELETE'].includes(request.method)||!p.startsWith('/api/')||/^\/api\/(auth|events|deploy)\//.test(p))return [];
 if(/^\/api\/server\/(exchange|heartbeat|pulse|operation-progress|ack)$/.test(p)||/\/preview$|\/duplicates$|\/service-impact$|\/transfer-options$|\/resolve-qr$/.test(p))return [];
 if(p==='/api/server/ordexa/import'||p==='/api/server/ordexa/pay-check')return ['workforce','status'];
 if(p==='/api/server/ordexa-server/publish')return ['workforce','status'];
 if(p==='/api/server/operation-error')return ['fleet','invoices','workforce'];
 if(/service-document|invoice-import|invoice-reader/.test(p))return ['fleet','invoices'];
 if(/\/sync|\/snapshot|\/fleet|service-followup|service-appointments|service-trash|\/vehicles/.test(p))return ['fleet','invoices','workforce'];
 if(p.startsWith('/api/server/'))return [];
 return ['workforce','status'];
}
export async function publishChanges(env,scope){
 if(!env.FLEET_EVENTS||!scope.length)return;
 await env.FLEET_EVENTS.get(env.FLEET_EVENTS.idFromName('fleet')).fetch(new Request('https://events.internal/publish',{method:'POST',body:JSON.stringify({scopes:scope})}));
}
export class FleetEvents {
 constructor(ctx,env){this.ctx=ctx;this.env=env;if(typeof WebSocketRequestResponsePair!=='undefined')ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping','pong'));}
 async fetch(request){
  const url=new URL(request.url);
  if(url.pathname==='/connect'&&request.headers.get('Upgrade')==='websocket'){
   if(this.ctx.getWebSockets().length>=256)return new Response('Busy',{status:503});
   const pair=new WebSocketPair(),client=pair[0],server=pair[1],until=Number(request.headers.get('X-Fleet-Until'));
   this.ctx.acceptWebSocket(server);server.serializeAttachment({scopes:JSON.parse(request.headers.get('X-Fleet-Scopes')),until});
   server.send(JSON.stringify({type:'ready'}));const alarm=await this.ctx.storage.getAlarm();if(!alarm||alarm>until)await this.ctx.storage.setAlarm(until);
   return new Response(null,{status:101,webSocket:client});
  }
  if(url.pathname==='/publish'&&request.method==='POST'){
   const body=await request.json(),changed=(body.scopes||[]).filter(s=>scopes.includes(s)),now=Date.now();
   for(const ws of this.ctx.getWebSockets()){const saved=ws.deserializeAttachment();if(!saved||saved.until<=now){try{ws.close(1000,'renew');}catch{}continue;}
    const allowed=changed.filter(s=>saved.scopes.includes(s));if(allowed.length)try{ws.send(JSON.stringify({type:'changed',scopes:allowed}));}catch{}}
   return Response.json({ok:true});
  }
  return new Response('Not found',{status:404});
 }
 async alarm(){let next=Infinity;for(const ws of this.ctx.getWebSockets()){const saved=ws.deserializeAttachment();if(!saved||saved.until<=Date.now()){try{ws.close(1000,'renew');}catch{}}else next=Math.min(next,saved.until);}if(Number.isFinite(next))await this.ctx.storage.setAlarm(next);}
 webSocketMessage(ws,message){if(message==='ping')ws.send('pong');else ws.close(1008,'signals only');}
 webSocketClose(ws,code,reason){try{ws.close(code,reason);}catch{}}
 webSocketError(ws){try{ws.close(1011,'reconnect');}catch{}}
}

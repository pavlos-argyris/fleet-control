import './web.js';
import worker from '../cloudflare-worker/src/worker.js';
import {NativeFile,hex} from './web.js';
import {DB} from './database.js';
import {RECEIPT_SCHEMA,beginOperation,finishOperation} from './receipts.js';
import {FEATURE_SCHEMA,routeFeatures} from './features.js';
import {bindFileSecurity} from './security.js';
const native=globalThis.FleetHost;
const bucket={
  async put(key,value,metadata={}){return native('objects.put',{key,ref:value?.__file?value.ref:null,hex:value?.__file?null:hex(await new Response(value).arrayBuffer()),metadata});},
  async get(key){
    const info=native('objects.get',{key});if(!info.exists)return null;const file=new NativeFile(info);
    return {...info,body:file,arrayBuffer:()=>file.arrayBuffer(),text:()=>file.text(),json:async()=>JSON.parse(await file.text()),writeHttpMetadata(headers){for(const[k,v]of Object.entries(info.httpMetadata||{}))headers.set(k.replace(/[A-Z]/g,c=>'-'+c.toLowerCase()),v);}};
  },
  async head(key){const info=native('objects.get',{key});return info.exists?info:null;},
  async delete(key){native('objects.delete',{key});}
};
let environment,realm;
globalThis.__fleetInit=function(configuration){
  const config=JSON.parse(configuration);realm=new URL(config.realm).origin;
  environment={LOCAL_PRIMARY:true,DB,SERVICE_DOCS:bucket,RELEASES:bucket,SERVER_KEY:config.serverKey,PIN_PEPPER:config.authPepper,EVENT_SIGNING_KEY:config.eventSigningKey,ASSETS:{fetch:()=>new Response('Not available',{status:404})}};
  if(config.eventSigningKey)environment.FLEET_EVENTS={idFromName:()=>0,get:()=>({async fetch(request){native('events.queue',{body:await request.text()});return Response.json({ok:true});}})};
  native('sql.exec',{sql:RECEIPT_SCHEMA+'\n'+FEATURE_SCHEMA});
};
globalThis.__fleetRequest=function(serialized){
  globalThis.__fleetResult=null;
  globalThis.__fleetExternalRequest=JSON.parse(serialized).internal!==true;
  globalThis.__fleetChunkResponse=new URL(JSON.parse(serialized).url).pathname.startsWith('/api/native/files/');
  (async()=>{
    const value=JSON.parse(serialized),url=new URL(value.url);
    const privatePath=/^\/api\/(server|deploy|pin|unlock|direct|primary)(\/|$)/.test(url.pathname)||/^\/api\/auth\/(login|bootstrap)$/.test(url.pathname)||url.pathname==='/api/sync'&&value.method!=='GET';
    if(url.protocol!=='https:'||url.origin!==realm||!value.internal&&privatePath)return Response.json({error:'Η ενέργεια απαιτεί τοπική υπηρεσία Server.'},{status:403});
    const headers=new Headers(value.headers||{});if(!value.internal)headers.delete('X-Fleet-Server-Key');
    const authorizationRequest=new Request(value.url,{method:value.method,headers});authorizationRequest.localInternal=value.internal===true;
    await bindFileSecurity(authorizationRequest,environment);
    const form={};for(const [key,item]of Object.entries(value.form||{}))form[key]=item&&typeof item==='object'&&item.ref?native('file.stat',{ref:item.ref}):item;
    const body=value.bodyFile?new NativeFile(native('file.stat',{ref:value.bodyFile})):value.body;
    const request=new Request(value.url,{method:value.method,headers,body,form});
    request.localInternal=value.internal===true;
    const operation=value.internal?{}:await beginOperation(request,environment,form);if(operation.response)return operation.response;
    const dispatch=request=>worker.fetch(request,environment,{waitUntil(){}});
    const response=await routeFeatures(request,environment,dispatch)||await dispatch(request);
    await finishOperation(operation,response,environment);return response;
  })().then(async response=>{
    const output={status:response.status,headers:Object.fromEntries(response.headers)};
    if(response.data?.__file)output.file={ref:response.data.ref,size:response.data.size,type:response.data.type,name:response.data.name,sha256:response.data.sha256};
    else{
      const body=await response.text();
      // Six-byte JSON escapes and UTF-8 still fit the 1.4 MB encrypted packet.
      if(body.length>120000&&globalThis.__fleetExternalRequest&&!globalThis.__fleetChunkResponse)output.bodyFile=native('response.file',{text:body,type:response.headers.get('content-type')||'application/octet-stream'});
      else output.body=body;
    }
    globalThis.__fleetResult=JSON.stringify(output);
  }).catch(()=>{globalThis.__fleetResult=JSON.stringify({status:500,headers:{'content-type':'application/json'},body:JSON.stringify({error:'Η τοπική εργασία δεν ολοκληρώθηκε.'})});});
};

import './web.js';
import worker from '../cloudflare-worker/src/worker.js';
import {NativeFile,hex} from './web.js';
const native=globalThis.FleetHost;
function prepared(sql,params=[]){return{sql,params,bind(...values){return prepared(sql,values);},async first(column){const value=native('sql.query',{sql,params,first:true}).results[0]||null;return column===undefined?value:value?.[column]??null;},async all(){return native('sql.query',{sql,params});},async run(){return native('sql.run',{sql,params});},async raw(){return native('sql.raw',{sql,params}).rows;}};}
const DB={prepare:prepared,withSession(){return this;},getBookmark(){return null;},async batch(queries){return native('sql.batch',{queries:queries.map(q=>({sql:q.sql,params:q.params}))}).results;},async exec(sql){return native('sql.exec',{sql});}};
const bucket={async put(key,value,metadata={}){return native('objects.put',{key,ref:value?.__file?value.ref:null,hex:value?.__file?null:hex(await new Response(value).arrayBuffer()),metadata});},async get(key){const info=native('objects.get',{key});if(!info.exists)return null;const file=new NativeFile(info);return{...info,body:file,arrayBuffer:()=>file.arrayBuffer(),text:()=>file.text(),json:async()=>JSON.parse(await file.text()),writeHttpMetadata(headers){for(const[k,v]of Object.entries(info.httpMetadata||{}))headers.set(k.replace(/[A-Z]/g,c=>'-'+c.toLowerCase()),v);}};},async head(key){const info=native('objects.get',{key});return info.exists?info:null;},async delete(key){native('objects.delete',{key});}};
let environment,realm;
globalThis.__fleetInit=function(configuration){const config=JSON.parse(configuration);realm=new URL(config.realm).origin;environment={DB,SERVICE_DOCS:bucket,RELEASES:bucket,SERVER_KEY:config.serverKey,PIN_PEPPER:config.authPepper,ASSETS:{fetch:()=>new Response('Not available',{status:404})}};};
globalThis.__fleetRequest=function(serialized){
 globalThis.__fleetResult=null;
 (async()=>{const value=JSON.parse(serialized);const url=new URL(value.url);if(url.protocol!=='https:'||url.origin!==realm||(!value.internal&&(/^\/api\/server\//.test(url.pathname)||/^\/api\/(sync|pin|unlock|direct|primary)(\/|$)/.test(url.pathname))))return Response.json({error:'Η ενέργεια απαιτεί τοπική υπηρεσία Server.'},{status:403});
 const headers=new Headers(value.headers||{});if(!value.internal)headers.delete('X-Fleet-Server-Key');
 const request=new Request(value.url,{method:value.method,headers,body:value.body,form:value.form});
 return worker.fetch(request,environment,{waitUntil(){}});
 })().then(async response=>{const output={status:response.status,headers:Object.fromEntries(response.headers)};if(response.data?.__file)output.file={ref:response.data.ref,size:response.data.size,type:response.data.type};else output.body=await response.text();globalThis.__fleetResult=JSON.stringify(output);}).catch(()=>{globalThis.__fleetResult=JSON.stringify({status:500,headers:{'content-type':'application/json'},body:JSON.stringify({error:'Η τοπική εργασία δεν ολοκληρώθηκε.'})});});
};

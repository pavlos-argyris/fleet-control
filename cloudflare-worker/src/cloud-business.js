import {applyAutomaticCashBatch} from '../../server-runtime/cash-auto.js';
import {routeCloudBackup} from './cloud-backup.js';
import {principalSecurity,nativeObjectOrder} from '../../server-runtime/security.js';
import {authenticateExternal} from './workforce.js';
import {CloudTransfer} from './cloud-transfer.js';
import {ensureCloudStoreIndexes} from './cloud-store-indexes.js';
import {cloudHost,cloudDocumentBucket} from './cloud-host.js';
import {routeCloudSource} from './cloud-source.js';
import {directHash} from './direct-relay.js';
import worker from './worker.js';
import {cloudBusinessDatabase,cloudBusinessTransaction} from './cloud-business-db.js';
import {FEATURE_SCHEMA,routeFeatures} from '../../server-runtime/features.js';
import {RECEIPT_SCHEMA,beginOperation,finishOperation} from '../../server-runtime/receipts.js';

/** Private execution of the shared business code in the cloud-owned database.
 * Only verified authority routing can enter an activated instance.
 * D1 is not read or mutated by this executor. */
export class CloudBusiness {
  constructor(ctx,env,ports){this.ctx=ctx;this.env=env;this.ports=ports;this.DB=cloudBusinessDatabase(ctx.storage);this.ready=null;this.transfer=new CloudTransfer(ctx,env);}
  async scheduleCash(env){if(!env.BUSINESS_CONTEXT?.configured)return;const pending=await env.DB.prepare("SELECT 1 found FROM store_billing_local WHERE scope=? AND kind='cash_apply_request' LIMIT 1").bind(env.BUSINESS_CONTEXT.scope).first();if(!pending)return;const next=Date.now()+1000,alarm=await this.ctx.storage.getAlarm();if(alarm===null||alarm>next)await this.ctx.storage.setAlarm(next);}
  async alarm(){const cfg=await this.ctx.storage.get('cloud-business.configuration');if(!cfg?.active)return;const response=await this.fetch(new Request('https://cloud-business.internal/_cloud-cash-maintain',{headers:{'X-Fleet-Server-Key':this.env.SERVER_KEY}}));if(!response.ok)throw Error('Cloud maintenance needs retry');}
  async fetch(request){
    return this.ctx.blockConcurrencyWhile(async()=>{
     try{
      const path=new URL(request.url).pathname;
      if(path==='/_cloud-transfer/freeze-recovery'){const cfg=await this.ctx.storage.get('cloud-business.configuration');if(!cfg)return Response.json({error:'Not prepared'},{status:409});cfg.active=false;cfg.recoveryFrozen=true;await this.ctx.storage.put('cloud-business.configuration',cfg);return Response.json({frozen:true});}
      if(path.startsWith('/_cloud-transfer/')){try{return Response.json(await this.transfer.control(path.slice('/_cloud-transfer/'.length),await request.json()));}catch{return Response.json({error:'Η μεταφορά στο Cloudflare δεν ολοκληρώθηκε. Τα αρχικά δεδομένα διατηρούνται.',code:'cloud_transfer_failed'},{status:409});}}
      const configuration=await this.ctx.storage.get('cloud-business.configuration');
      if(!configuration?.active)return Response.json({error:'Η κύρια βάση Cloudflare δεν έχει ενεργοποιηθεί.'},{status:503});
      const incoming=new URL(request.url);request=new Request(configuration.realm+incoming.pathname+incoming.search,request);
      const serverKey=request.headers.get('X-Fleet-Server-Key')||'';request.localInternal=serverKey.length>=24&&await directHash(serverKey)===await directHash(this.env.SERVER_KEY||'');
      if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS','Access-Control-Allow-Headers':'Authorization,Content-Type,X-Fleet-Operation,X-Admin-Pin,X-Fleet-Pin,X-Fleet-Pin-Session,X-Idempotency-Key','Access-Control-Max-Age':'600'}});
      const changes=[];
      const environment={...this.env,LOCAL_PRIMARY:true,CLOUD_PRIMARY:true,DB:cloudBusinessDatabase(this.ctx.storage),
        PIN_PEPPER:configuration.authPepper,EVENT_SIGNING_KEY:configuration.eventSigningKey,
        SERVICE_DOCS_RAW:this.env.SERVICE_DOCS,
        SERVICE_DOCS:cloudDocumentBucket(this.env.SERVICE_DOCS,this.DB,configuration.generation),
        BUSINESS_CONTEXT:configuration.context||{},
        BUSINESS_HEALTH:configuration.health||{},
        BUSINESS_PORT:async(command,value)=>{
          return (this.ports||cloudHost)(command,value,{request,configuration,DB:this.DB,env:this.env});
        },
        FLEET_EVENTS:{idFromName:()=>0,get:()=>({async fetch(signal){if(new URL(signal.url).pathname==='/primary/state')return Response.json({mode:'cloud'});const body=await signal.json();changes.push(...body.scopes||[]);return Response.json({ok:true});}})}
      };
      // Cached only after commit. A failed first request must not leave a stale
      // in-memory schema success flag while its actual DDL was rolled back.
      let initialized=false,actorId='',fingerprint='';
      const response=await cloudBusinessTransaction(this.ctx.storage,async()=>{
        if(!this.ready){await this.DB.exec(RECEIPT_SCHEMA+'\n'+FEATURE_SCHEMA);ensureCloudStoreIndexes(this.ctx.storage.sql);initialized=true;}
        if(path==='/_cloud-maintain'||path==='/_cloud-cash-maintain'){if(!request.localInternal)return Response.json({error:'Forbidden'},{status:403});if(path==='/_cloud-maintain'){const pending=[];await worker.scheduled(null,environment,{waitUntil:p=>pending.push(p)});await Promise.all(pending);}const automatic=configuration.context?.configured?await applyAutomaticCashBatch(environment):{idle:true};if(automatic.changed)changes.push('cash');await this.scheduleCash(environment);return Response.json({ok:true,automatic});}
        const backup=await routeCloudBackup(request,environment,configuration,this.ctx.storage);if(backup)return backup;
        const source=await routeCloudSource(request,environment,configuration,this.ctx.storage);if(source){if(source.changed)changes.push('cash','stores');await this.scheduleCash(environment);return source.response;}
        if(request.headers.has('Authorization'))try{const actor=await authenticateExternal(request,environment);actorId=actor.user_id;fingerprint=await principalSecurity(environment,actor);}catch{}
        let receiptRequest=request,receiptForm={};
        if(request.headers.has('X-Fleet-Operation')&&(request.headers.get('Content-Type')||'').includes('multipart/form-data')){
          const form=await request.clone().formData(),values={};for(const [key,value]of [...form.entries()].sort(([a],[b])=>a.localeCompare(b))){if(typeof value==='string')values[key]=value;else values[key]={ref:'cloud-private-upload',name:value.name,type:value.type,size:value.size,sha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await value.arrayBuffer())),v=>v.toString(16).padStart(2,'0')).join('')};}receiptForm=nativeObjectOrder(values);receiptRequest=new Request(request.url,{method:request.method,headers:request.headers,body:''});
        }
        const operation=request.headers.has('X-Fleet-Operation')?await beginOperation(receiptRequest,environment,receiptForm):{};
        if(operation.response)return operation.response;
        const dispatch=value=>worker.fetch(value,environment,{waitUntil(){}});
        const response=await routeFeatures(request,environment,dispatch)||await dispatch(request);
        await finishOperation(operation,response,environment);
        if(response.ok&&!['GET','HEAD','OPTIONS'].includes(request.method))await this.scheduleCash(environment);
        return response;
      });
      if(initialized&&response.status<500)this.ready=true;
      // A notification is a best-effort hint after durable business commit.
      if(response.ok&&changes.length&&this.env.FLEET_EVENTS){
        try{await this.env.FLEET_EVENTS.get(this.env.FLEET_EVENTS.idFromName('fleet')).fetch(new Request('https://events.internal/publish',{method:'POST',body:JSON.stringify({scopes:[...new Set(changes)]})}));}catch{}
      }
      const headers=new Headers(response.headers);headers.set('Access-Control-Allow-Origin','*');headers.set('Cache-Control','private, no-store');headers.set('X-Fleet-Cloud-Primary','1');headers.set('Access-Control-Expose-Headers','X-Fleet-Actor,X-Fleet-Principal,X-Fleet-Replayed,X-Fleet-Cloud-Primary');if(actorId){headers.set('X-Fleet-Actor',actorId);headers.set('X-Fleet-Principal',fingerprint);}return new Response(response.body,{status:response.status,headers});
     }catch(error){return Response.json({error:Number(error.status)>=400&&Number(error.status)<500?error.message:'Η εργασία Cloudflare δεν ολοκληρώθηκε. Τα δεδομένα διατηρούνται.',code:error.code||'cloud_business_failed'},{status:Number(error.status)>=400&&Number(error.status)<500?Number(error.status):500,headers:{'Access-Control-Allow-Origin':'*','Cache-Control':'no-store'}});}
    });
  }
}

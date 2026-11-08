import worker from './worker.js';
import {cloudBusinessDatabase,cloudBusinessTransaction} from './cloud-business-db.js';
import {FEATURE_SCHEMA,routeFeatures} from '../../server-runtime/features.js';
import {RECEIPT_SCHEMA,beginOperation,finishOperation} from '../../server-runtime/receipts.js';

/** Cloud-owned execution of the shared business code. Not publicly registered:
 * authority routing and a verified migration must be installed before activation.
 * D1 is not read or mutated by this executor. */
export class CloudBusiness {
  constructor(ctx,env,ports){this.ctx=ctx;this.env=env;this.ports=ports;this.DB=cloudBusinessDatabase(ctx.storage);this.ready=null;}
  async fetch(request){
    return this.ctx.blockConcurrencyWhile(async()=>{
      const configuration=await this.ctx.storage.get('cloud-business.configuration');
      if(!configuration?.active)return Response.json({error:'Η κύρια βάση Cloudflare δεν έχει ενεργοποιηθεί.'},{status:503});
      const changes=[];
      const environment={...this.env,LOCAL_PRIMARY:true,DB:cloudBusinessDatabase(this.ctx.storage),
        PIN_PEPPER:configuration.authPepper,EVENT_SIGNING_KEY:configuration.eventSigningKey,
        BUSINESS_CONTEXT:configuration.context||{},
        BUSINESS_PORT:async(command,value)=>{
          if(!this.ports)throw Error('Cloud business host service is unavailable');
          return this.ports(command,value,{request,configuration,DB:this.DB});
        },
        FLEET_EVENTS:{idFromName:()=>0,get:()=>({async fetch(signal){const body=await signal.json();changes.push(...body.scopes||[]);return Response.json({ok:true});}})}
      };
      // Cached only after commit. A failed first request must not leave a stale
      // in-memory schema success flag while its actual DDL was rolled back.
      let initialized=false;
      const response=await cloudBusinessTransaction(this.ctx.storage,async()=>{
        if(!this.ready){await this.DB.exec(RECEIPT_SCHEMA+'\n'+FEATURE_SCHEMA);initialized=true;}
        const operation=request.headers.has('X-Fleet-Operation')?await beginOperation(request,environment,{}):{};
        if(operation.response)return operation.response;
        const dispatch=value=>worker.fetch(value,environment,{waitUntil(){}});
        const response=await routeFeatures(request,environment,dispatch)||await dispatch(request);
        await finishOperation(operation,response,environment);
        return response;
      });
      if(initialized&&response.status<500)this.ready=true;
      // A notification is a best-effort hint after durable business commit.
      if(response.ok&&changes.length&&this.env.FLEET_EVENTS){
        try{await this.env.FLEET_EVENTS.get(this.env.FLEET_EVENTS.idFromName('fleet')).fetch(new Request('https://events.internal/publish',{method:'POST',body:JSON.stringify({scopes:[...new Set(changes)]})}));}catch{}
      }
      return response;
    });
  }
}

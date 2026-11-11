import {fleetRegistrySnapshot,readSnapshotBike,writeSnapshotBike} from '../cloudflare-worker/src/snapshot-store.js';
import {publishChanges} from '../cloudflare-worker/src/change-events.js';
import {maintainWorkforce,recordExternalAudit,authenticateExternal} from '../cloudflare-worker/src/workforce.js';

/** Present only in the independent APK; the legacy runtime never acquires these ports. */
export async function routeStandalone(request,env,value){
  const path=new URL(request.url).pathname;
  if(!env.STANDALONE||!path.startsWith('/api/independent/'))return null;
  try{
    if(path==='/api/independent/maintenance'&&request.localInternal&&request.method==='POST'){
      const before=await env.DB.prepare('SELECT total_changes() n').first();
      await maintainWorkforce(env,{serverLastSeen:new Date().toISOString()},{readSnapshot:fleetRegistrySnapshot,readFleetRegistry:fleetRegistrySnapshot,readSnapshotBike,writeSnapshotBike});
      const after=await env.DB.prepare('SELECT total_changes() n').first();
      if(after.n!==before.n)await publishChanges(env,['workforce','status','fleet']);
      return Response.json({ok:true});
    }
    const actor=await authenticateExternal(request,env);
    if(path==='/api/independent/status'&&request.method==='GET')return Response.json(globalThis.FleetHost('independent.status',{}));
    if(actor.role!=='owner')return Response.json({error:'Απαιτείται λογαριασμός ιδιοκτήτη.'},{status:403});
    if(path==='/api/independent/probe'&&request.method==='POST')return Response.json(globalThis.FleetHost('independent.probe',{actorId:actor.user_id,peer:value.independentPeer||'',external:value.independentExternal===true,session:actor.tokenHash}));
    if(path==='/api/independent/activate'&&request.method==='POST'){
      const body=await request.json();
      const result=globalThis.FleetHost('independent.activate',{actorId:actor.user_id,session:actor.tokenHash,proof:body.proof,confirm:body.confirm,oldProductionStopped:body.oldProductionStopped===true,mobileDataTested:body.mobileDataTested===true});
      await recordExternalAudit(env,request,actor,'independent_primary_activated','independent_instance',result.instanceId,{mode:'test'},{mode:'primary'},'Owner confirmed physical mobile-data test and retired old writes');
      return Response.json(result);
    }
    return Response.json({error:'Η ενέργεια δεν υποστηρίζεται.'},{status:404});
  }catch(error){return Response.json({error:Number(error.status)?error.message:'Δεν επιβεβαιώθηκε η δοκιμή ή η ενεργοποίηση. Η υπάρχουσα εγκατάσταση διατηρείται.'},{status:Number(error.status)||409});}
}

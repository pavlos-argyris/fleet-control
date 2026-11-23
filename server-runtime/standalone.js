import {fleetRegistrySnapshot,readSnapshotBike,writeSnapshotBike} from '../cloudflare-worker/src/snapshot-store.js';
import {publishChanges} from '../cloudflare-worker/src/change-events.js';
import {maintainWorkforce,recordExternalAudit,authenticateExternal} from '../cloudflare-worker/src/workforce.js';
import {prepareNextStoreWeek,STORE_WEEK_SCHEMA} from './reports.js';

export const DIRECT_ADMIN_SCHEMA = `
CREATE TABLE IF NOT EXISTS direct_admin_commands(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,session_hash TEXT,action TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,finished_at INTEGER);
CREATE INDEX IF NOT EXISTS direct_admin_commands_queue ON direct_admin_commands(state,created_at);
${STORE_WEEK_SCHEMA}
`;

async function serverAdmin(request,env,actor){
  if(request.method==='GET'){
    const snapshot=globalThis.FleetHost('independent.adminStatus',{});
    if(!snapshot.available)return Response.json({error:'Η απομακρυσμένη διαχείριση δεν είναι διαθέσιμη.'},{status:404});
    const commands=await env.DB.prepare("SELECT id,action,state,created_at,finished_at FROM direct_admin_commands WHERE actor_id=? ORDER BY created_at DESC LIMIT 12").bind(actor.user_id).all();
    return Response.json({...snapshot,commands:commands.results||[]},{headers:{'Cache-Control':'private, no-store'}});
  }
  if(request.method!=='POST')return Response.json({error:'Η ενέργεια δεν υποστηρίζεται.'},{status:405});
  if(!globalThis.FleetHost('independent.adminAvailable',{}).available)return Response.json({error:'Η απομακρυσμένη διαχείριση δεν είναι διαθέσιμη.'},{status:404});
  const body=await request.json(),action=String(body.action||''),id=request.headers.get('X-Fleet-Operation');
  if(!['check-update','retry-backup','create-backup','sync-ordexa','backup-settings'].includes(action))return Response.json({error:'Η ενέργεια δεν υποστηρίζεται.'},{status:400});
  let payload={};
  if(action==='backup-settings'){
    const {enabled,hour,retention,frequency,revision}=body;
    if(typeof enabled!=='boolean'||!Number.isInteger(hour)||hour<0||hour>23||!Number.isInteger(retention)||retention<1||retention>90
        ||!['daily','weekdays','weekly'].includes(frequency)||typeof revision!=='string'||!/^(true|false):\d{1,2}:\d{1,2}:(daily|weekdays|weekly)$/.test(revision)){
      return Response.json({error:'Έλεγξε την ώρα, τη συχνότητα και τη διατήρηση αντιγράφων.'},{status:400});
    }
    payload={enabled,hour,retention,frequency,revision};
  }
  const queued=await env.DB.prepare("SELECT COUNT(*) n FROM direct_admin_commands WHERE state IN ('queued','running')").first();
  const duplicate=await env.DB.prepare("SELECT id FROM direct_admin_commands WHERE action=? AND state IN ('queued','running') LIMIT 1").bind(action).first();
  if(duplicate||Number(queued?.n)>=8)return Response.json({error:'Υπάρχει ήδη προγραμματισμένη εργασία. Ανανέωσε την κατάσταση.'},{status:409});
  await env.DB.prepare("INSERT INTO direct_admin_commands(id,actor_id,session_hash,action,payload,state,created_at) VALUES(?,?,?,?,?,'queued',?)")
      .bind(id,actor.user_id,actor.tokenHash,action,JSON.stringify(payload),Date.now()).run();
  await recordExternalAudit(env,request,actor,'direct_admin_queued','direct_admin_command',id,null,{action,state:'queued'});
  return Response.json({id,action,state:'queued'},{status:202,headers:{'Cache-Control':'private, no-store'}});
}

/** Present only in the independent APK; the legacy runtime never acquires these ports. */
export async function routeStandalone(request,env,value){
  const path=new URL(request.url).pathname;
  if(!env.STANDALONE||!path.startsWith('/api/independent/'))return null;
  try{
    if(path==='/api/independent/store-week-prepare'){
      if(!request.localInternal||request.method!=='POST')return Response.json({error:'Η εργασία απαιτεί τοπική υπηρεσία Server.'},{status:403});
      return Response.json(await prepareNextStoreWeek(env));
    }
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
    if(path==='/api/independent/server-admin')return await serverAdmin(request,env,actor);
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

import {businessPort} from './ports.js';
import {projectFleetHealth} from '../cloudflare-worker/src/fleet-health-core.js';
import {publishChanges} from '../cloudflare-worker/src/change-events.js';
import {list,reply,NativeError,actor,audit,text,stamp} from './common.js';
export const HEALTH_SCHEMA=`
CREATE TABLE IF NOT EXISTS native_health_incidents(id TEXT PRIMARY KEY,code TEXT NOT NULL,generation INTEGER NOT NULL,severity TEXT NOT NULL,first_at TEXT NOT NULL,last_at TEXT NOT NULL,resolved_at TEXT,ack_at TEXT,ack_by TEXT,notes TEXT NOT NULL DEFAULT '',UNIQUE(code,generation));
CREATE UNIQUE INDEX IF NOT EXISTS native_health_open_code ON native_health_incidents(code) WHERE resolved_at IS NULL;
`;
const labels={
  'server-stale':{title:'Ο Server δεν έχει πρόσφατη επικοινωνία',action:'Έλεγξε την υπηρεσία και τη σύνδεση του κινητού Server.',signal:'server'},
  'ordexa-stale':{title:'Οι παρουσίες Ordexa χρειάζονται ενημέρωση',action:'Έλεγξε τη σύνδεση Ordexa στον Server και ζήτησε συγχρονισμό.',signal:'ordexa'},
  'stores-stale':{title:'Τα καταστήματα χρειάζονται ενημέρωση',action:'Άνοιξε Καταστήματα στον Server και έλεγξε την τελευταία επιτυχή λήψη.',signal:'stores'},
  'restore-proof-stale':{title:'Χρειάζεται νέα δοκιμή ανάκτησης',action:'Αντίγραφα στον Server → Δοκιμή ανάκτησης σε ξεχωριστή βάση.',signal:'backupRestoreProof'},
  'outbox-stale':{title:'Εκκρεμεί διανομή αποθηκευμένων αποτελεσμάτων',action:'Έλεγξε τη σύνδεση και τις εκκρεμότητες στον Server.',signal:'outbox'},
  'space-low':{title:'Λίγος διαθέσιμος χώρος στον Server',action:'Έλεγξε τον αποθηκευτικό χώρο. Μην διαγράφεις ανεπιβεβαίωτα backup.',signal:'space'},
  'd1-near-limit':{title:'Η μετρημένη χρήση D1 πλησιάζει το όριο',action:'Έλεγξε τη χρονοσήμανση και τη μεταφορά κύριας βάσης στον Server.',signal:'d1'},
  'd1-quota-exceeded':{title:'Η μετρημένη χρήση D1 έφτασε το όριο',action:'Έλεγξε τη μέτρηση και την κατάσταση της κύριας βάσης Server.',signal:'d1'}
};
function safeSnapshot(raw){
  const take=['at','serverLastSeenAt','ordexaLastSuccessAt','backupLastVerifiedRestoreAt','outboxPending','outboxOldestAt','d1'];const result={};for(const key of take)if(raw[key]!==undefined)result[key]=raw[key];return result;
}
export async function healthSnapshot(env){
  const raw=await businessPort(env,'health.snapshot'),result=projectFleetHealth(safeSnapshot(raw)),now=Date.parse(result.observedAt);
  const storesAt=Date.parse(raw.storesLastSuccessAt);result.stores={status:!Number.isFinite(storesAt)||storesAt>now?'unknown':now-storesAt>2*3600000?'stale':'healthy',observedAt:Number.isFinite(storesAt)?raw.storesLastSuccessAt:null};
  result.space={status:Number.isSafeInteger(raw.freeBytes)&&raw.freeBytes>=0?(raw.freeBytes<256*1024*1024?'low':'healthy'):'unknown',freeBytes:Number.isSafeInteger(raw.freeBytes)&&raw.freeBytes>=0?raw.freeBytes:null};
  const verifiedAt=Date.parse(raw.backupFileVerifiedAt);result.backupFile={status:Number.isFinite(verifiedAt)&&verifiedAt<=now?'readable':'unknown',observedAt:Number.isFinite(verifiedAt)&&verifiedAt<=now?raw.backupFileVerifiedAt:null};
  if(result.stores.status==='stale')result.alerts.push({code:'stores-stale',severity:'warning'});if(result.space.status==='low')result.alerts.push({code:'space-low',severity:'critical'});
  const codes=new Set(result.alerts.map(a=>a.code)),at=result.observedAt;let changed=false;
  for(const alert of result.alerts){
    if(!labels[alert.code])continue;const active=await env.DB.prepare('SELECT id,severity FROM native_health_incidents WHERE code=? AND resolved_at IS NULL').bind(alert.code).first();
    // observedAt is the live observation. Persist incident timestamps only for
    // state transitions, so repeatedly viewing an unchanged alert is read-only.
    if(active){if(active.severity!==alert.severity){await env.DB.prepare('UPDATE native_health_incidents SET last_at=?,severity=? WHERE id=?').bind(at,alert.severity,active.id).run();changed=true;}}
    else{const prior=await env.DB.prepare('SELECT COALESCE(MAX(generation),0) n FROM native_health_incidents WHERE code=?').bind(alert.code).first();await env.DB.prepare('INSERT INTO native_health_incidents(id,code,generation,severity,first_at,last_at) VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(),alert.code,Number(prior.n)+1,alert.severity,at,at).run();changed=true;}
  }
  const open=list(await env.DB.prepare('SELECT id,code FROM native_health_incidents WHERE resolved_at IS NULL').all());
  for(const incident of open){
    const signal=labels[incident.code]?.signal,status=result[signal]?.status;
    if(!codes.has(incident.code)&&['healthy','pending','measured'].includes(status)){await env.DB.prepare('UPDATE native_health_incidents SET resolved_at=?,last_at=? WHERE id=? AND resolved_at IS NULL').bind(at,at,incident.id).run();changed=true;}
  }
  const incidents=list(await env.DB.prepare('SELECT * FROM native_health_incidents ORDER BY resolved_at IS NULL DESC,last_at DESC LIMIT 200').all()).map(i=>({...i,...labels[i.code],acknowledged:!!i.ack_at,resolved:!!i.resolved_at}));
  if(changed)await publishChanges(env,['status','workforce']);
  return{...result,incidents,versions:raw.versions&&typeof raw.versions==='object'?{server:text(raw.versions.server,32),business:text(raw.versions.business,32)}:null};
}
export async function routeHealth(request,env){
  const url=new URL(request.url);if(!url.pathname.startsWith('/api/native/health'))return null;
  const internal=request.localInternal===true;
  const user=internal?{user_id:'native-health',full_name:'Server',role:'owner'}:await actor(request,env,request.method==='GET'?'alerts.view':'alerts.manage');
  if(url.pathname==='/api/native/health/ack'&&request.method==='POST'){
    const b=await request.json(),id=text(b.id,100),generation=b.generation;
    if(!id||!Number.isSafeInteger(generation)||generation<1)throw new NativeError(400,'Επίλεξε έγκυρη ειδοποίηση και έκδοση.');
    const before=await env.DB.prepare('SELECT id,code,generation,ack_at,resolved_at FROM native_health_incidents WHERE id=?').bind(id).first();
    if(!before)throw new NativeError(404,'Η ειδοποίηση δεν βρέθηκε.');
    if(generation!==Number(before.generation))throw new NativeError(409,'Η ειδοποίηση άλλαξε. Ανανέωσε την προβολή.');
    if(!before.ack_at){
      // Compare-and-set: two administrators may acknowledge the same generation.
      // Only the successful transition creates an audit record or live event.
      const at=stamp(),notes=text(b.notes,500);
      const updated=await env.DB.prepare('UPDATE native_health_incidents SET ack_at=?,ack_by=?,notes=? WHERE id=? AND generation=? AND ack_at IS NULL').bind(at,user.user_id,notes,id,generation).run();
      if(Number(updated?.meta?.changes)===1){
        await audit(env,request,user,'health_acknowledged','health_incident',id,before,{acknowledged:true,resolved:!!before.resolved_at},notes);
        await publishChanges(env,['status','workforce']);
      }else{
        const current=await env.DB.prepare('SELECT generation,ack_at,resolved_at FROM native_health_incidents WHERE id=?').bind(id).first();
        if(!current||Number(current.generation)!==generation||!current.ack_at)
          throw new NativeError(409,'Η ειδοποίηση άλλαξε. Ανανέωσε την προβολή.');
        return reply({acknowledged:true,resolved:!!current.resolved_at});
      }
    }
    return reply({acknowledged:true,resolved:!!before.resolved_at});
  }
  if(request.method==='GET'&&['/api/native/health','/api/native/health/diagnostic'].includes(url.pathname)){
    const snapshot=await healthSnapshot(env);
    if(url.pathname.endsWith('/diagnostic'))return reply({schemaVersion:1,observedAt:snapshot.observedAt,versions:snapshot.versions,signals:Object.fromEntries(['server','ordexa','stores','outbox','backupFile','backupRestoreProof','space','d1'].map(k=>[k,snapshot[k]])),incidents:snapshot.incidents.map(i=>({code:i.code,generation:i.generation,severity:i.severity,firstAt:i.first_at,lastAt:i.last_at,resolvedAt:i.resolved_at,acknowledged:i.acknowledged}))});
    return reply(snapshot);
  }
  throw new NativeError(405,'Η ενέργεια διάγνωσης δεν υποστηρίζεται.');
}

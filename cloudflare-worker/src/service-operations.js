import '../public/service-model.js';
import '../public/fleet-operations-model.js';
const M=globalThis.FleetServiceModel,O=globalThis.FleetOperationsModel;
const text=(v,n=100)=>String(v??'').trim().slice(0,n);
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export async function routeServiceOperations(request,env,D){
 const url=new URL(request.url),path=url.pathname;
 if(!['/api/admin/service-trash','/api/admin/service-impact','/api/admin/service-appointments','/api/admin/fleet-diagnostics'].includes(path))return null;
 try{
  const actor=await D.authenticateExternal(request,env,'fleet.manage');if(!D.isManagementActor(actor))throw fail('Χρειάζεται λογαριασμός διαχείρισης στόλου.',403);
  const actorName=text(actor.full_name||actor.fullName||actor.username||'Διαχείριση',120);
  if(path==='/api/admin/fleet-diagnostics'&&request.method==='GET'){
   const [summary,ops,jobs]=await Promise.all([D.snapshotSummary(env),env.DB.prepare("SELECT status,COUNT(*) AS count FROM fleet_operations WHERE status IN ('pending','processing','failed') GROUP BY status").all(),env.DB.prepare("SELECT COUNT(*) AS count FROM invoice_import_drafts WHERE status IN ('processing','ready','committing','error')").first()]);
   const status=await D.statusPayload(env);const serverRelease=await env.DB.prepare("SELECT value FROM fleet_settings WHERE key='server_version'").first();
   return D.json({schema:'fleet-diagnostics-v1',checkedAt:new Date().toISOString(),workerVersion:'5.12.12',snapshotVersion:summary.version,databaseOk:true,storageConfigured:!!(env.SERVICE_DOCS||env.RELEASES),serverOnline:!!status.serverOnline,serverVersion:text(serverRelease?.value,40),operations:(ops.results||[]).map(r=>({status:r.status,count:Number(r.count)})),invoiceDraftsPending:Number(jobs?.count||0),clientVersion:status.clientRelease?.version||'',webVersion:status.webRelease?.version||''});
  }
  if(path==='/api/admin/service-appointments'&&request.method==='GET'){
   const rows=await env.DB.prepare(`SELECT json_extract(b.value,'$.id') AS id,json_extract(b.value,'$.name') AS name,json_extract(b.value,'$.serviceAppointments') AS appointments FROM fleet_snapshot s,json_each(s.data,'$.bikes') b WHERE s.id=1 AND NOT EXISTS(SELECT 1 FROM vehicle_archives a WHERE a.active=1 AND a.bike_id=json_extract(b.value,'$.id'))`).all();
   return D.json({bikes:(rows.results||[]).map(b=>({id:b.id,name:b.name,appointments:O.appointments(JSON.parse(b.appointments||'[]'))}))});
  }
  if(path==='/api/admin/service-trash'&&request.method==='GET'){
   const id=text(url.searchParams.get('id'));
   if(id){
    const row=await env.DB.prepare("SELECT * FROM deleted_records WHERE id=? AND record_type='fleet_history'").bind(id).first();if(!row)throw fail('Η εγγραφή του κάδου δεν βρέθηκε.',404);
    const payload=JSON.parse(row.payload),located=await D.readSnapshotBike(env,String(payload.bikeId));
    if(!located||(await D.activeArchivedBikeIds(env)).has(String(payload.bikeId)))throw fail('Ανάκτησε πρώτα το μηχανάκι από τον κάδο μηχανών.',409);
    const bike=located.bike;bike.odometerFloorKm=await D.workforceOdometerFloor(env,bike.id);
    const files=[];for(const f of payload.entry?.attachments||[]){const found=await (env.SERVICE_DOCS||env.RELEASES)?.head(f.key);files.push({name:f.name,available:!!found});}
    return D.json({id:row.id,deletedAt:row.deleted_at,restoredAt:row.restored_at||'',bikeId:bike.id,bikeName:bike.name,entry:payload.entry,files,expectedBikeUpdatedAt:bike.updatedAt,impact:O.impact(bike,'restore',payload.entry)});
   }
   const offset=Math.min(100000,Math.max(0,Number(url.searchParams.get('offset'))||0)),bikeId=text(url.searchParams.get('bikeId')),restored=url.searchParams.get('restored')==='1';
   const rows=await env.DB.prepare(`SELECT id,label,deleted_at,deleted_by_name,reason,restored_at,json_extract(payload,'$.bikeId') AS bike_id,json_extract(payload,'$.bikeName') AS bike_name,json_extract(payload,'$.entry.type') AS type,json_extract(payload,'$.entry.date') AS date,json_extract(payload,'$.entry.km') AS km,json_array_length(payload,'$.entry.attachments') AS files FROM deleted_records WHERE record_type='fleet_history' AND (?=1 OR restored_at IS NULL) AND (?='' OR json_extract(payload,'$.bikeId')=?) ORDER BY deleted_at DESC,id DESC LIMIT 51 OFFSET ?`).bind(restored?1:0,bikeId,bikeId,offset).all();
   return D.json({records:(rows.results||[]).slice(0,50),hasMore:(rows.results||[]).length>50,nextOffset:offset+50,retention:'manual'});
  }
  if(request.method!=='POST')throw fail('Η μέθοδος δεν υποστηρίζεται.',405);
  const body=await request.json().catch(()=>null);if(!body||typeof body!=='object'||Array.isArray(body))throw fail('Μη έγκυρα στοιχεία.');
  if(path==='/api/admin/service-trash'){
   const id=text(body.id),row=await env.DB.prepare("SELECT * FROM deleted_records WHERE id=? AND record_type='fleet_history'").bind(id).first();if(!row)throw fail('Η εγγραφή δεν βρέθηκε.',404);
   const reason=text(body.reason,500);if(reason.length<3)throw fail('Γράψε αιτιολογία ανάκτησης.');if(row.restored_at)return D.json({restored:true,unchanged:true});
   if(body.expectedDeletedAt!==row.deleted_at)throw fail('Η εγγραφή άλλαξε. Άνοιξε ξανά την προεπισκόπηση.',409);
   const payload=JSON.parse(row.payload);const result=await D.restoreFleetHistoryEntries(env,[{...payload,expectedBikeUpdatedAt:text(body.expectedBikeUpdatedAt,40)}]);
   if(!result.restored)throw fail('Δεν είναι διαθέσιμη η ανάκτηση. Ανανέωσε τη λίστα.',409);
   await env.DB.prepare("UPDATE deleted_records SET restored_at=?,restored_by=?,restore_reason=? WHERE id=? AND restored_at IS NULL").bind(new Date().toISOString(),String(actor.user_id||actor.id||''),reason,id).run();
   await D.recordExternalAudit(env,request,actor,'service_trash_restored','fleet_history',row.record_id,{recycleId:id},{restored:result.restored},reason,false);
   return D.json({restored:true,...result});
  }
  const bikeId=text(body.bikeId),located=await D.readSnapshotBike(env,bikeId);if(!located||(await D.activeArchivedBikeIds(env)).has(bikeId))throw fail('Το ενεργό μηχανάκι δεν βρέθηκε.',404);
  const bike=located.bike;bike.odometerFloorKm=await D.workforceOdometerFloor(env,bikeId);
  if(path==='/api/admin/service-impact'){
   if(!['edit','delete'].includes(body.action))throw fail('Μη έγκυρη προεπισκόπηση.');
   const entry=(bike.history||[]).find(e=>e.id===text(body.entryId));if(!entry)throw fail('Η καταχώρηση δεν βρέθηκε.',404);
   const changed=body.action==='delete'?entry:{...entry,...D.historyChanges(body.changes||{},entry)};
   const token=await D.impactToken(located.json,body.action,entry.id,body.changes||{},bike.odometerFloorKm);
   return D.json({impact:O.impact(bike,body.action,changed),impactToken:token,expectedEntryUpdatedAt:entry.updatedAt||''});
  }
  const action=body.action,now=new Date(Math.max(Date.now(),Date.parse(bike.updatedAt||'')+1||0)).toISOString();
  let appointments=O.appointments(bike.serviceAppointments),record=appointments.find(p=>p.id===text(body.id));
  if(action==='complete'&&record?.status==='completed')return D.json({bike:D.normalizeBike(bike),entryId:record.completedEntryId,unchanged:true});
  if(action!=='create'&&(!record||record.updatedAt!==body.expectedUpdatedAt))throw fail('Το προγραμματισμένο service άλλαξε. Ανανέωσε τη λίστα.',409);
  if(action==='create'&&record)return D.json({bike:D.normalizeBike(bike),appointment:record,unchanged:true});
  let entryId='';
  if(action==='create'||action==='edit'){
   if(action==='create'&&appointments.filter(p=>p.status==='planned').length>=50)throw fail('Μπορείς να έχεις έως 50 προγραμματισμένα service ανά μηχανάκι.',409);
   if(action==='edit'&&record.status!=='planned')throw fail('Αυτό το ραντεβού έχει ήδη ολοκληρωθεί ή ακυρωθεί.',409);
   const date=M.date(body.date),tasks=(Array.isArray(body.tasks)?body.tasks:[]).map(t=>text(t,120)).filter(Boolean).slice(0,30);if(!date||!tasks.length)throw fail('Συμπλήρωσε ημερομηνία και τουλάχιστον μία εργασία.');
   record={id:record?.id||text(body.id)||crypto.randomUUID(),status:'planned',date,tasks,notes:text(body.notes,500),createdAt:record?.createdAt||now,updatedAt:now,actor:actorName,completedEntryId:''};
  }else if(action==='cancel'){
   if(record.status!=='planned')throw fail('Το service δεν είναι πλέον προγραμματισμένο.',409);record={...record,status:'cancelled',updatedAt:now,actor:actorName};
  }else if(action==='complete'){
   if(record.status!=='planned')throw fail('Το service δεν είναι πλέον προγραμματισμένο.',409);
   if(body.expectedBikeUpdatedAt!==bike.updatedAt)throw fail('Το ιστορικό άλλαξε. Άνοιξε ξανά την προεπισκόπηση.',409);
   if((bike.history||[]).length>=500)throw fail('Έχει συμπληρωθεί το όριο των 500 καταχωρήσεων. Δεν αφαιρέθηκε παλιό ιστορικό.',409);
   const km=Number(body.km),date=M.date(body.date),tasks=(Array.isArray(body.tasks)?body.tasks:[]).map(t=>text(t,120)).filter(Boolean).slice(0,30);
   if(!Number.isSafeInteger(km)||km<0||km>2000000000||body.km==null||body.km===''||!date||!tasks.length||body.confirm!==true)throw fail('Επιβεβαίωσε ημερομηνία, χιλιόμετρα και εργασίες.');
   entryId=crypto.randomUUID();const oilChanged=body.oilChanged===true,majorService=body.majorService===true;
   D.ensureLegacyOilHistory(bike,now);
   const normalizedChanges=D.historyChanges({...body,km,date,tasks},{type:'service'});
   const entry={...normalizedChanges,id:entryId,type:'service',notes:normalizedChanges.tasks.join('\n'),majorServiceMilestoneKm:majorService?km:0,attachments:[],cost:'',workshop:'',appointmentId:record.id,createdAt:now,updatedAt:now};
   if(oilChanged&&km>=Number(bike.lastServiceKm||0)){bike.lastServiceKm=km;bike.nextServiceKm=km+Number(bike.intervalKm);}bike.currentKm=Math.max(Number(bike.currentKm||0),km);bike.history=[entry,...(bike.history||[])];
   record={...record,status:'completed',completedEntryId:entryId,updatedAt:now,actor:actorName};
  }else throw fail('Μη έγκυρη ενέργεια.');
  bike.serviceAppointments=O.appointments([record,...appointments.filter(p=>p.id!==record.id)]);bike.updatedAt=now;const normalized=D.normalizeBike(bike),version=await D.writeSnapshotBike(env,located,normalized,'service-appointment-'+action,now);
  if(!version)throw fail('Έγινε άλλη αλλαγή ταυτόχρονα. Ανανέωσε τη λίστα.',409);
  await D.queueBike(env,normalized,now);await D.recordExternalAudit(env,request,actor,'service_appointment_'+action,'fleet_history',record.id,null,{status:record.status,date:record.date,entryId},'Προγραμματισμός service',false);
  return D.json({bike:normalized,appointment:record,entryId,version});
 }catch(error){return D.json({error:error.message||'Η ενέργεια δεν ολοκληρώθηκε.'},Number(error.status)||500);}
}

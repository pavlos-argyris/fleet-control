// Retry one current failure. Bulk UI calls this endpoint sequentially; it never
// sends an unbounded list or treats queue acceptance as completed analysis.
export async function retryFailedInvoice(request, env, deps) {
  const {json, authenticateExternal, isManagementActor, readServiceEntry,
    readServiceDocument, serviceRenderState, jobAttachmentMatches, restartServiceDocument,
    reprocessAdminServiceDocument, resolveServiceDocumentFailure, digestHex} = deps;
  let actor;
  try { actor = await authenticateExternal(request, env, 'fleet.manage'); }
  catch (error) { return json({error:error.message}, Number(error.status)||401); }
  if (!isManagementActor(actor)) return json({error:'Χρειάζεται λογαριασμός διαχείρισης.'},403);
  const body = await request.json().catch(()=>({}));
  let jobId = String(body.jobId||'').slice(0,120), key = String(body.key||'').slice(0,500);
  if (body.alertId) {
    const alert = await env.DB.prepare('SELECT type,object_type,object_id,resolved FROM system_alerts WHERE id=?').bind(String(body.alertId).slice(0,120)).first();
    if (!alert || alert.type!=='invoice_processing_failed' || alert.object_type!=='invoice_job') return json({error:'Η ειδοποίηση τιμολογίου δεν βρέθηκε.'},404);
    if (alert.resolved) return json({ok:true,skipped:true,status:'completed'});
    jobId=alert.object_id; key='';
  }
  if(!jobId&&!key&&(!body.bikeId||!body.entryId))return json({error:'Επίλεξε τιμολόγιο για επανάληψη.'},400);
  if(key&&(!key.startsWith('service-documents/')||key.includes('..')))return json({error:'Μη έγκυρο τιμολόγιο.'},400);
  let row=jobId?await env.DB.prepare('SELECT id,type,payload,status,created_at FROM fleet_operations WHERE id=?').bind(jobId).first():null;
  if (jobId && (!row || row.type!=='service_document_render')) return json({error:'Η εργασία δεν βρέθηκε. Άνοιξε το service για έλεγχο.'},404);
  // Older releases resolved/replaced attempts differently. Follow a bounded
  // chain, so an old notification cannot launch a second attempt of its own.
  for(let i=0;row?.status==='cancelled' && i<12;i++) {
    const next=await env.DB.prepare("SELECT id,type,payload,status,created_at FROM fleet_operations WHERE type='service_document_render' AND json_extract(payload,'$.replacesJobId')=? ORDER BY created_at DESC LIMIT 1").bind(row.id).first();
    if(!next)break; row=next;jobId=row.id;
  }
  let payload={};try{payload=JSON.parse(row?.payload||'{}');}catch{}
  if(payload.draftId)return json({error:'Άνοιξε το προσχέδιο τιμολογίου για νέα προσπάθεια.'},409);
  key=payload.documentKey||key;
  const located=key?await readServiceDocument(env,key):await readServiceEntry(env,payload.bikeId||body.bikeId,payload.entryId||body.entryId);
  if(!located||located.entry.type==='check')return json({error:'Το τιμολόγιο ή το service δεν βρέθηκε.'},404);
  const qrPayload={...payload,qrUrl:payload.qrUrl||body.qrUrl||located.entry.invoiceData?.qrUrl};
  const file=key?located.entry.attachments?.find(a=>a.key===key):located.entry.attachments?.find(a=>(jobId&&jobAttachmentMatches(a,qrPayload,jobId))||(qrPayload.qrUrl&&String(a.qrUrl||a.qrValue)===qrPayload.qrUrl&&a.key!==payload.sourcePhotoKey));
  const active=row?.status==='pending' && serviceRenderState(payload,row.status,row.created_at).status==='processing';
  if(active)return json({ok:true,existing:true,queued:true,status:'processing',jobId:row.id},202);
  if(file&&!file.ocrError){
    if(jobId)await resolveServiceDocumentFailure(env,jobId);
    return json({ok:true,skipped:true,status:'completed'});
  }
  if(file){key=file.key;jobId=file.renderJobId||jobId;}
  if(row&&(String(located.bike.id)!==String(payload.bikeId)||String(located.entry.id)!==String(payload.entryId)))return json({error:'Η εργασία δεν αντιστοιχεί στο τιμολόγιο.'},400);
  const legacy=located.entry.invoiceData||{};
  const legacyFailure=['error','delayed'].includes(String(legacy.qrProcessingStatus))||(legacy.qrProcessingStatus==='completed'&&!file&&legacy.qrUrl);
  if(!row && !file?.ocrError && !legacyFailure)return json({ok:true,skipped:true,status:'unchanged'});
  if(row?.status==='cancelled')return json({error:'Η προσπάθεια έχει διακοπεί. Ανανέωσε τα τιμολόγια.'},409);
  const identity=key||jobId||[located.bike.id,located.entry.id,body.qrUrl||legacy.qrUrl||''].join('|');
  const lock='invoice_retry_lock:'+await digestHex(new TextEncoder().encode(identity)),owner=crypto.randomUUID(),now=Date.now();
  const acquired=await env.DB.prepare("INSERT INTO fleet_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at WHERE CAST(json_extract(fleet_settings.value,'$.expiresAt') AS INTEGER)<?")
    .bind(lock,JSON.stringify({owner,expiresAt:now+300000}),new Date(now).toISOString(),now).run();
  if(!acquired.meta?.changes)return json({ok:true,busy:true,status:'requesting'},202);
  try{
    if(key){const fresh=await readServiceDocument(env,key),current=fresh?.entry.attachments?.find(a=>a.key===key);if(!current)return json({error:'Το τιμολόγιο αφαιρέθηκε.'},404);if(!current.ocrError){if(jobId)await resolveServiceDocumentFailure(env,jobId);return json({ok:true,skipped:true,status:'completed'});}}
    const headers=new Headers(request.headers);headers.delete('Content-Length');
    const target=key?'/api/admin/service-documents/reprocess':'/api/admin/service-documents/restart';
    const retryBody=key?{key}:{jobId,bikeId:located.bike.id,entryId:located.entry.id,qrUrl:payload.qrUrl||body.qrUrl||legacy.qrUrl};
    const next=new Request(new URL(target,request.url),{method:'POST',headers,body:JSON.stringify(retryBody)});
    const response=key?await reprocessAdminServiceDocument(next,env):await restartServiceDocument(next,env);
    // A synchronous stored-file read has no new render job. Resolve the old
    // notification only after the read and its save actually succeeded.
    if(response.ok&&key){const result=await response.clone().json();if(!result.queued&&!result.ocrWarning&&!result.document?.error&&jobId)await resolveServiceDocumentFailure(env,jobId);}
    return response;
  }finally{
    await env.DB.prepare("DELETE FROM fleet_settings WHERE key=? AND json_extract(value,'$.owner')=?").bind(lock,owner).run();
  }
}

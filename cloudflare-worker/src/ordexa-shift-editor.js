// Editing is a source operation. It must not depend on a running payroll
// computer, a recent projection, or unrelated decisions for the same person.
// This module reads identity/version metadata only; it never calculates pay.
const rows=r=>r.results||[];
const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))).map(n=>n.toString(16).padStart(2,'0')).join('');
export async function captureShift(env,id,epoch,zone,projection){
 const ids=[...new Set(projection?.sourceSessionIds?.length?projection.sourceSessionIds:[String(id).replace(/^ordexa:/,'')])];
 if(ids.length>5000)return null;
 const source=rows(await env.DB.prepare(`SELECT s.id,s.city_id,s.rider_id,s.revision,s.in_at,s.out_at,s.ignored,s.review,s.missing_since,s.review_reason,r.employee_id,r.revision link_revision,u.full_name employee_name FROM ordexa_sessions s LEFT JOIN ordexa_riders r ON r.city_id=s.city_id AND r.rider_id=s.rider_id LEFT JOIN app_users u ON u.id=r.employee_id AND u.deleted_at IS NULL WHERE s.id IN(SELECT value FROM json_each(?)) ORDER BY s.in_at,s.id`).bind(JSON.stringify(ids)).all());
 if(!source.length||source.length!==ids.length||source.some(s=>s.employee_id!==source[0].employee_id))return null;
 const groupId='ordexa:'+source[0].id,employee=source[0].employee_id||'';
 let value=groupId+'\n'+employee;for(const s of source)value+='\n'+s.id+'|'+s.revision+'|'+s.in_at+'|'+(s.out_at||'')+'|'+s.ignored+'|'+s.review+'|'+(s.missing_since||'')+'|'+(s.review_reason||'');
 const sourceFingerprint='direct-v1:'+await digest(value+'\n'+zone);
 const fingerprint='edit-v1:'+await digest(sourceFingerprint+'\n'+epoch+'\n'+JSON.stringify(source.map(s=>[s.city_id,s.rider_id,s.link_revision])));
 const adjustment=await env.DB.prepare('SELECT * FROM ordexa_shift_adjustments WHERE id=?').bind(groupId).first();
 return {source,employee,groupId,sourceFingerprint,fingerprint,adjustment,context:JSON.stringify({source,zone}),epoch};
}
export const directContextCte='WITH direct_context(data,employee,epoch) AS (SELECT ?,?,?)';
const directEmployee='(SELECT employee FROM direct_context)';
export const directSourceGuard=`NOT EXISTS(SELECT 1 FROM fleet_settings WHERE key='ordexa_restore_active' AND value<>'') AND EXISTS(SELECT 1 FROM fleet_mirror_state WHERE id=1 AND epoch||':'||COALESCE((SELECT value FROM fleet_settings WHERE key='ordexa_server_generation'),'')=(SELECT epoch FROM direct_context)) AND EXISTS(SELECT 1 FROM app_users WHERE id=${directEmployee} AND deleted_at IS NULL) AND COALESCE((SELECT value FROM system_settings WHERE key='timezone'),'Europe/Athens')=json_extract((SELECT data FROM direct_context),'$.zone') AND NOT EXISTS(SELECT 1 FROM json_each((SELECT data FROM direct_context),'$.source') expected WHERE NOT EXISTS(SELECT 1 FROM ordexa_sessions s JOIN ordexa_riders r ON r.city_id=s.city_id AND r.rider_id=s.rider_id WHERE s.id=json_extract(expected.value,'$.id') AND r.employee_id=${directEmployee} AND r.revision IS json_extract(expected.value,'$.link_revision') AND ${['city_id','rider_id','revision','in_at','out_at','ignored','review','missing_since','review_reason'].map(c=>`s.${c} IS json_extract(expected.value,'$.${c}')`).join(' AND ')}))`;
export const directContextArgs=capture=>[capture.context,capture.employee,capture.epoch];

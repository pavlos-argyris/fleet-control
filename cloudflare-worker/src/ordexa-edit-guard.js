// Compare only the inputs of this employee's Server calculation. A different
// employee's import or an unchanged heartbeat must not invalidate an editor.
// This is a dependency fence, never a Worker payroll calculation. It is used
// again inside the audit/write transaction, not just when opening the editor.
export const editContextCte='WITH edit_context(data,employee,epoch,revision) AS (SELECT ?,?,?,?)';
const employee='(SELECT employee FROM edit_context)',lower="json_extract((SELECT data FROM edit_context),'$.lower')",upper="json_extract((SELECT data FROM edit_context),'$.upper')";
const specs=[
 ['riders',['city_id','rider_id','employee_id','revision'],`SELECT city_id,rider_id,employee_id,revision FROM ordexa_riders WHERE employee_id=${employee}`],
 ['sessions',['id','revision','in_at','out_at','ignored','review','missing_since','review_reason'],`SELECT s.id,s.revision,s.in_at,s.out_at,s.ignored,s.review,s.missing_since,s.review_reason FROM ordexa_sessions s JOIN ordexa_riders r ON r.city_id=s.city_id AND r.rider_id=s.rider_id WHERE r.employee_id=${employee} AND s.in_at>=${lower} AND s.in_at<${upper}`],
 ['schedules',['id','start_at','end_at','status','vehicle_id'],`SELECT id,start_at,end_at,status,vehicle_id FROM schedules WHERE employee_id=${employee} AND start_at<${upper} AND end_at>${lower} AND status<>'cancelled'`],
 ['adjustments',['id','revision'],`SELECT a.id,a.revision FROM ordexa_shift_adjustments a JOIN ordexa_sessions s ON a.id='ordexa:'||s.id WHERE a.employee_id=${employee} AND s.in_at>=${lower} AND s.in_at<${upper}`],
 ['legacyDecisions',['id','start_choice','end_choice','chosen_schedule_id','updated_at'],`SELECT d.id,d.start_choice,d.end_choice,d.chosen_schedule_id,d.updated_at FROM ordexa_pay_decisions d JOIN ordexa_sessions s ON s.id=d.source_session_id WHERE d.employee_id=${employee} AND s.in_at>=${lower} AND s.in_at<${upper}`],
 ['settings',['key','value'],"SELECT key,value FROM system_settings WHERE key IN ('timezone','ordexa_policy','ordexa_pay_policy')"]
];
const scoped=specs.map(([key,columns,query])=>`json_type((SELECT data FROM edit_context),'$.${key}')='array' AND (SELECT COUNT(*) FROM (${query}))=json_array_length((SELECT data FROM edit_context),'$.${key}') AND NOT EXISTS(SELECT 1 FROM (${query}) actual WHERE NOT EXISTS(SELECT 1 FROM json_each((SELECT data FROM edit_context),'$.${key}') expected WHERE ${columns.map(col=>`actual.${col} IS json_extract(expected.value,'$.${col}')`).join(' AND ')}))`).join(' AND ');
export const editSourceGuard=`NOT EXISTS(SELECT 1 FROM fleet_settings WHERE key='ordexa_restore_active' AND value<>'') AND EXISTS(SELECT 1 FROM fleet_mirror_state WHERE id=1 AND epoch||':'||COALESCE((SELECT value FROM fleet_settings WHERE key='ordexa_server_generation'),'')=(SELECT epoch FROM edit_context)) AND EXISTS(SELECT 1 FROM app_users WHERE id=${employee} AND deleted_at IS NULL) AND ((json_extract((SELECT data FROM edit_context),'$.version')=1 AND ${scoped}) OR ((SELECT data FROM edit_context) IS NULL AND EXISTS(SELECT 1 FROM system_settings WHERE key='ordexa_revision' AND value=(SELECT revision FROM edit_context))))`;
export const editContextArgs=stored=>[stored.edit_context||null,stored.employee_id,stored.input_epoch,stored.input_revision];
export async function editSourceCurrent(env,stored){return !!(await env.DB.prepare(`${editContextCte} SELECT CASE WHEN ${editSourceGuard} THEN 1 ELSE 0 END ok`).bind(...editContextArgs(stored)).first())?.ok;}

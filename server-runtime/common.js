import {authenticateExternal,recordExternalAudit} from '../cloudflare-worker/src/workforce.js';
export const list=result=>result.results||[];
export const stamp=()=>new Date().toISOString();
export const reply=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'private, no-store'}});
export class NativeError extends Error{constructor(status,message,code){super(message);this.status=status;this.code=code;}}
export function text(value,max=500){return String(value??'').trim().slice(0,max);}
export function day(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+'T12:00:00Z'))||new Date(value+'T12:00:00Z').toISOString().slice(0,10)!==value)throw new NativeError(400,'Διάλεξε έγκυρη ημερομηνία.');return value;}
export const addDay=(d,n)=>new Date(Date.parse(day(d)+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
export function range(url,max=366){const from=day(url.searchParams.get('from')||url.searchParams.get('day')),to=day(url.searchParams.get('to')||from);if(to<from||Date.parse(to)-Date.parse(from)>max*86400000)throw new NativeError(400,'Επίλεξε μικρότερο έγκυρο διάστημα.');return{from,to};}
export function integer(value,min=0,max=100000000){if(!Number.isSafeInteger(value)||value<min||value>max)throw new NativeError(400,'Η ποσότητα ή το ποσό δεν είναι έγκυρο.');return value;}
export function stable(value){if(Array.isArray(value))return '['+value.map(stable).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}';return JSON.stringify(value);}
export const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(typeof value==='string'?value:stable(value)))),b=>b.toString(16).padStart(2,'0')).join('');
export async function actor(request,env,permission){return authenticateExternal(request,env,permission);}
export async function audit(env,request,user,action,type,id,before,after,reason=''){return recordExternalAudit(env,request,user,action,type,id,before,after,reason,false);}

import {actor,reply,NativeError,text} from './common.js';
const native=globalThis.FleetHost;
export async function routeFiles(request,env,dispatch){
  const url=new URL(request.url);if(!url.pathname.startsWith('/api/native/files/'))return null;
  const upload=['start','chunk','finish'].includes(url.pathname.split('/').pop());
  const user=await actor(request,env,upload?'fleet.manage':'');
  if(upload&&request.method==='POST'){
    const body=await request.json(),action=url.pathname.split('/').pop();
    if(action==='start')return reply(native('files.start',{id:body.id,name:text(body.name,240),type:text(body.type,100),size:body.size,sha256:body.sha256}));
    if(action==='chunk')return reply(native('files.append',{ref:body.ref,offset:body.offset,data:body.data}));
    return reply(native('files.finish',{ref:body.ref}));
  }
  if(request.method==='GET'){
    const ref=url.pathname.slice('/api/native/files/'.length);if(!/^[a-f0-9-]{36}$/.test(ref))throw new NativeError(400,'Μη έγκυρη ιδιωτική αναφορά αρχείου.');
    const info=native('file.stat',{ref});
    if(info.permission)await actor(request,env,info.permission);
    if(info.sourceUrl&&new URL(info.sourceUrl).pathname.startsWith('/api/service-documents/')){
      const checked=await dispatch(new Request(info.sourceUrl,{headers:request.headers}));if(!checked.ok)return checked;
    }
    const offset=Number(url.searchParams.get('offset')||0);if(!Number.isSafeInteger(offset)||offset<0)throw new NativeError(400,'Μη έγκυρο τμήμα αρχείου.');
    return reply(native('files.chunk',{ref,offset}));
  }
  throw new NativeError(405,'Η μεταφορά αρχείου δεν υποστηρίζεται.');
}

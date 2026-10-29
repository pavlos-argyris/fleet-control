// Synthetic running Server for integration/browser tests. It uses actual Java
// computations and the real paged/publish APIs, and releases its own leases on
// cancellation just like OrdexaPayrollSync. It never calls the Ordexa provider.
export async function projectOrdexaWeek(call,native,week){
 const check=r=>{if(r.status!==200){const error=Error(JSON.stringify(r));error.status=r.status;throw error;}return r.data;};
 const control=check(await call('/api/server/ordexa-server/control',{server:true,method:'POST',body:{week}}));
 if(!control.jobs.some(x=>x.weekStart===week)){for(const job of control.jobs)check(await call('/api/server/ordexa-server/release',{server:true,method:'POST',body:{weekStart:job.weekStart,lease:job.lease}}));const error=Error('No projection lease');error.status=409;throw error;}
 let requested;const completed=new Set();
 try{for(const job of control.jobs){
  const targetWeek=job.weekStart,prefix='/api/server/ordexa-server/input?week='+targetWeek+'&lease='+encodeURIComponent(job.lease),meta=check(await call(prefix,{server:true})),input={weekStart:targetWeek,timeZone:meta.timeZone};
  for(const table of meta.tables){let cursor=0,done=false;input[table]=[];
   for(let page=0;page<300;page++){const data=check(await call(prefix+'&table='+table+'&revision='+meta.revision+'&epoch='+meta.epoch+'&cursor='+cursor,{server:true}));input[table].push(...data.rows);if(!data.hasMore){done=true;break;}if(data.nextCursor<=cursor)throw Error('Projection cursor did not advance');cursor=data.nextCursor;}
   if(!done)throw Error('Projection inputs incomplete');
  }
  const payload=native.build(input,meta.serverTime),body={weekStart:targetWeek,lease:job.lease,revision:meta.revision,epoch:meta.epoch,engineVersion:payload.engineVersion,sourceSyncedAt:new Date().toISOString(),payload};
  const saved=check(await call('/api/server/ordexa-server/publish',{server:true,method:'POST',body}));completed.add(job.lease);if(targetWeek===week)requested={payload,input,meta,body,saved};
 }return requested;
 }finally{for(const job of control.jobs)if(!completed.has(job.lease))check(await call('/api/server/ordexa-server/release',{server:true,method:'POST',body:{weekStart:job.weekStart,lease:job.lease}}));}
}

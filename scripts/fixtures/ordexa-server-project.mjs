export async function projectOrdexaWeek(call,native,week){
 const check=r=>{if(r.status!==200)throw Error(JSON.stringify(r));return r.data;};
 const control=check(await call('/api/server/ordexa-server/control',{server:true,method:'POST',body:{week}}));const job=control.jobs.find(x=>x.weekStart===week);if(!job)throw Error('No projection lease');
 const prefix='/api/server/ordexa-server/input?week='+week+'&lease='+encodeURIComponent(job.lease),meta=check(await call(prefix,{server:true}));const input={weekStart:week,timeZone:meta.timeZone};
 for(const table of meta.tables){let cursor=0,done=false;input[table]=[];for(let page=0;page<300;page++){const data=check(await call(prefix+'&table='+table+'&revision='+meta.revision+'&epoch='+meta.epoch+'&cursor='+cursor,{server:true}));input[table].push(...data.rows);if(!data.hasMore){done=true;break;}if(data.nextCursor<=cursor)throw Error('Projection cursor did not advance');cursor=data.nextCursor;}if(!done)throw Error('Projection inputs incomplete');}
 const payload=native.build(input,meta.serverTime),body={weekStart:week,lease:job.lease,revision:meta.revision,epoch:meta.epoch,engineVersion:1,sourceSyncedAt:new Date().toISOString(),payload};const saved=check(await call('/api/server/ordexa-server/publish',{server:true,method:'POST',body}));return {payload,input,meta,body,saved};
}

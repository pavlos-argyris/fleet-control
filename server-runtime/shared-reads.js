// Only role-independent computations belong here. Every route authenticates
// before calling them; response headers, principals and files are never shared.
let epoch=0,active=false,staged=new Map(),saved=new Map(),bytes=0;
const MAX_BYTES=4*1024*1024,MAX_ENTRIES=8,MAX_AGE=300000;
export function beginSharedReads(){active=false;staged=new Map();epoch++;active=true;}
export function finishSharedReads(committed){
  active=false;const ready=staged;staged=new Map();if(!committed)return;
  for(const [key,value]of ready){
    const old=saved.get(key);if(old){bytes-=old.weight;saved.delete(key);}
    while(saved.size&&(bytes+value.weight>MAX_BYTES||saved.size>=MAX_ENTRIES)){const first=saved.keys().next().value;bytes-=saved.get(first).weight;saved.delete(first);}
    saved.set(key,value);bytes+=value.weight;
  }
}
export async function sharedStoreRead(env,parameters,compute){
  if(!env.STANDALONE||!active)return compute();
  const requestEpoch=epoch;
  let revisions;try{revisions=(await env.DB.prepare("SELECT scope,revision FROM independent_projection_revisions WHERE scope IN ('all','stores') ORDER BY scope").all()).results;}catch(optionalCache){return compute();}
  if(!Array.isArray(revisions))return compute();
  const key=JSON.stringify([parameters,revisions]),now=Date.now(),hit=saved.get(key);
  if(hit&&now-hit.at<=MAX_AGE){saved.delete(key);saved.set(key,hit);return JSON.parse(hit.body);}
  if(hit){saved.delete(key);bytes-=hit.weight;}
  const value=await compute();
  if(active&&requestEpoch===epoch){
    const body=JSON.stringify(value),weight=body.length*2;
    if(weight<=MAX_BYTES/2){let stagedBytes=0;for(const item of staged.values())stagedBytes+=item.weight;if(staged.size<MAX_ENTRIES&&stagedBytes+weight<=MAX_BYTES)staged.set(key,{body,weight,at:now});}
  }
  return value;
}

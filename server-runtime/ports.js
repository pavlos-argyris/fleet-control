/** Request-scoped host services. Never install a global host in a Worker isolate. */
export function businessContext(env){
  if(env?.BUSINESS_CONTEXT)return env.BUSINESS_CONTEXT;
  try{return typeof globalThis.FleetHost==='function'?globalThis.FleetHost('store.context')||{}:{};}catch{return{};}
}
export async function businessPort(env,command,value={}){
  if(typeof env?.BUSINESS_PORT==='function')return env.BUSINESS_PORT(command,value);
  if(typeof globalThis.FleetHost==='function')return globalThis.FleetHost(command,value);
  throw Error('Business host service is unavailable');
}

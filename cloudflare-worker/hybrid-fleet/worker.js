import { authorizeSync, currentEpoch, fleetError, pullMutations, pushMutations, readBody } from './ledger.js';
import { routePin } from './pin.js';

const routes = new Map([
  ['/api/fleet-sync/v1/state','GET'],
  ['/api/fleet-sync/v1/delta','GET'],
  ['/api/fleet-sync/v1/mutations','POST']
]);
const response = (value, status=200) => Response.json(value,{
  status,headers:{'Cache-Control':'no-store','Referrer-Policy':'no-referrer',
    'X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"}
});

// Staging API only. The production redirect never imports this entry point.
export default {
  async fetch(request, env) {
    const url=new URL(request.url);
    if (url.protocol!=='https:' || env.FLEET_REHEARSAL_ENABLED!=='1') return response({error:'unavailable'},404);
    try {
      const pin=await routePin(request,env,response);
      if (pin) return pin;
      const method=routes.get(url.pathname);
      if (!method) return response({error:'unavailable'},404);
      if (request.method!==method) return response({error:'method_not_allowed'},405);
      const db=env.FLEET_DB;
      const credential=await authorizeSync(request,db);
      const epoch=await currentEpoch(db);
      if (url.pathname.endsWith('/state')) return response({epoch,schemaVersion:1,mode:'rehearsal'});
      if (request.headers.get('X-Fleet-Epoch')!==epoch) throw fleetError(409,'epoch_changed');
      if (url.pathname.endsWith('/mutations')) {
        const operations=await pushMutations(db,credential,epoch,await readBody(request));
        return response({epoch,operations});
      }
      const value=url.searchParams.get('cursor') ?? '0';
      const cursor=Number(value);
      if (!/^\d{1,16}$/.test(value) || !Number.isSafeInteger(cursor)) throw fleetError(400,'invalid_cursor');
      return response({epoch,...await pullMutations(db,cursor)});
    } catch (error) {
      // Never send/log private URLs, credential headers, SQL errors or payloads.
      return response({error:error.status?error.code:'ledger_temporarily_unavailable'},error.status||503);
    }
  }
};

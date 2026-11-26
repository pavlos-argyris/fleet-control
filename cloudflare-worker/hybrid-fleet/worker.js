import { authorizeSync, currentEpoch, fleetError, pullMutations, pushMutations, readBody } from './ledger.js';
import { routePin } from './pin.js';
import { invoiceQueueStatus, runInvoiceQueue, sealInvoiceStage, stageInvoiceJobs } from './invoice-jobs.js';
import { storeInvoiceFile } from './invoice-files.js';
import { routeFleetSetup } from './setup.js';
import { baselineEnabled, baselineReadyForQueue, routeBaseline } from './baseline.js';
import { advanceBaselineProjection } from './baseline-projection.js';

const routes = new Map([
  ['/api/fleet-sync/v1/state','GET'],
  ['/api/fleet-sync/v1/delta','GET'],
  ['/api/fleet-sync/v1/mutations','POST'],
  ['/api/fleet-sync/v1/invoice-jobs','POST'],
  ['/api/fleet-sync/v1/invoice-stage','POST'],
  ['/api/fleet-sync/v1/invoice-file','PUT'],
  ['/api/fleet-sync/v1/invoice-status','GET']
]);
const response = (value, status=200) => Response.json(value,{
  status,headers:{'Cache-Control':'no-store','Referrer-Policy':'no-referrer',
    'X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"}
});

// Staging API only. The production redirect never imports this entry point.
export default {
  async scheduled(controller,env) {
    if (env.FLEET_REHEARSAL_ENABLED!=='1') return;
    if (baselineEnabled(env)) await advanceBaselineProjection(env.FLEET_DB);
    if (env.FLEET_INVOICE_PROCESSING==='1'&&await baselineReadyForQueue(env)) {
      await runInvoiceQueue(env);
    }
  },
  async fetch(request, env) {
    const url=new URL(request.url);
    if (url.protocol!=='https:' || env.FLEET_REHEARSAL_ENABLED!=='1') return response({error:'unavailable'},404);
    try {
      const setup=routeFleetSetup(request);
      if (setup) return setup;
      const pin=await routePin(request,env,response);
      if (pin) return pin;
      const method=routes.get(url.pathname);
      const baseline=url.pathname==='/api/fleet-sync/v1/baseline'||url.pathname.startsWith('/api/fleet-sync/v1/baseline/');
      if (!method&&!baseline) return response({error:'unavailable'},404);
      if (method&&request.method!==method) return response({error:'method_not_allowed'},405);
      const db=env.FLEET_DB;
      const credential=await authorizeSync(request,db);
      const epoch=await currentEpoch(db);
      if (url.pathname.endsWith('/state')) return response({epoch,schemaVersion:1,mode:'rehearsal',
        ...(baselineEnabled(env)?{baselineVersion:1}:{})});
      if (request.headers.get('X-Fleet-Epoch')!==epoch) throw fleetError(409,'epoch_changed');
      if (baseline) return await routeBaseline(request,env,credential,epoch,response)||response({error:'unavailable'},404);
      if (url.pathname.endsWith('/mutations')) {
        const operations=await pushMutations(db,credential,epoch,await readBody(request));
        return response({epoch,operations});
      }
      if (url.pathname.endsWith('/invoice-jobs')) return response(await stageInvoiceJobs(env,credential,epoch,await readBody(request)));
      if (url.pathname.endsWith('/invoice-stage')) return response(await sealInvoiceStage(env,credential,epoch,await readBody(request)));
      if (url.pathname.endsWith('/invoice-file')) return response(await storeInvoiceFile(request,env,credential,url.searchParams.get('sha256')));
      if (url.pathname.endsWith('/invoice-status')) return response(await invoiceQueueStatus(db));
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

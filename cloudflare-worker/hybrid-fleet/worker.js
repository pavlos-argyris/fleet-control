import { authorizeSync, currentEpoch, fleetError, pullMutations, pushMutations, readBody } from './ledger.js';
import { routePin } from './pin.js';
import { invoiceQueueStatus, runInvoiceQueue, sealInvoiceStage, stageInvoiceJobs } from './invoice-jobs.js';
import { readInvoiceFile, storeInvoiceFile } from './invoice-files.js';
import { routeFleetSetup } from './setup.js';
import { baselineEnabled, baselineOverview, baselineReadyForQueue, routeBaseline } from './baseline.js';
import { advanceBaselineProjection } from './baseline-projection.js';
import { advanceBaselineLedger } from './baseline-ledger.js';
import { advanceBaselineInvoiceImport, baselineInvoiceImportReady } from './baseline-invoice-import.js';
import { routeSourceDelta, SOURCE_DELTA_ROUTE, sourceDeltaEnabled } from './source-delta.js';
import { advanceSourceProjection, sourceProjectionStatus } from './source-projection.js';
import { INITIAL_TRANSFER_HOST, initialEnrollmentConfigured, transferMode } from './initial-transfer.js';

const routes = new Map([
  ['/api/fleet-sync/v1/state','GET'],
  ['/api/fleet-sync/v1/delta','GET'],
  ['/api/fleet-sync/v1/mutations','POST'],
  ['/api/fleet-sync/v1/invoice-jobs','POST'],
  ['/api/fleet-sync/v1/invoice-stage','POST'],
  ['/api/fleet-sync/v1/invoice-file','PUT'],
  ['/api/fleet-sync/v1/invoice-document','GET'],
  ['/api/fleet-sync/v1/invoice-status','GET']
]);
const response = (value, status=200) => Response.json(value,{
  status,headers:{'Cache-Control':'no-store','Referrer-Policy':'no-referrer',
    'X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"}
});

// This receiver is separate from the public Direct redirect and the OTA channel.
export default {
  async scheduled(controller,env) {
    const mode=transferMode(env);
    if (!mode) return;
    if (baselineEnabled(env)) {
      const db=env.FLEET_DB;
      if (mode==='initial-transfer') {
        if (!await advanceBaselineProjection(db)&&!await advanceBaselineLedger(db)&&await baselineReadyForQueue(env)) {
          await advanceSourceProjection(db);
        }
        return;
      }
      if (await advanceBaselineProjection(db)||await advanceBaselineLedger(db)||await advanceBaselineInvoiceImport(env)) return;
      if (!await baselineInvoiceImportReady(db)) return;
      if (sourceDeltaEnabled(env)&&await advanceSourceProjection(db)) return;
    }
    if (env.FLEET_INVOICE_PROCESSING==='1'&&await baselineReadyForQueue(env)) {
      await runInvoiceQueue(env);
    }
  },
  async fetch(request, env) {
    const url=new URL(request.url);
    const mode=transferMode(env),initial=mode==='initial-transfer';
    if (url.protocol!=='https:'||!mode||(initial&&url.host!==INITIAL_TRANSFER_HOST)) return response({error:'unavailable'},404);
    try {
      const setup=routeFleetSetup(request,mode,initial&&initialEnrollmentConfigured(env));
      if (setup) return setup;
      const pin=await routePin(request,env,response);
      if (pin) return pin;
      const method=routes.get(url.pathname);
      const baseline=url.pathname==='/api/fleet-sync/v1/baseline'||url.pathname.startsWith('/api/fleet-sync/v1/baseline/');
      const sourceDelta=url.pathname.startsWith(SOURCE_DELTA_ROUTE);
      if (!method&&!baseline&&!sourceDelta) return response({error:'unavailable'},404);
      if (method&&request.method!==method) return response({error:'method_not_allowed'},405);
      const db=env.FLEET_DB;
      const credential=await authorizeSync(request,db);
      const epoch=await currentEpoch(db);
      if (url.pathname==='/api/fleet-sync/v1/state') return response({epoch,schemaVersion:1,mode,
        ...(sourceDeltaEnabled(env)?{sourceDeltaVersion:1,sourceProgress:await sourceProjectionStatus(db,epoch)}:{}),
        ...(baselineEnabled(env)?{baselineVersion:1,baselineProgress:await baselineOverview(db,epoch)}:{})});
      if (request.headers.get('X-Fleet-Epoch')!==epoch) throw fleetError(409,'epoch_changed');
      if (initial&&['/api/fleet-sync/v1/mutations','/api/fleet-sync/v1/invoice-jobs','/api/fleet-sync/v1/invoice-stage'].includes(url.pathname)) {
        throw fleetError(409,'initial_transfer_only');
      }
      if (baseline) return await routeBaseline(request,env,credential,epoch,response)||response({error:'unavailable'},404);
      if (sourceDelta) return await routeSourceDelta(request,url.pathname,env,credential,epoch,response);
      if (['/api/fleet-sync/v1/mutations','/api/fleet-sync/v1/delta','/api/fleet-sync/v1/invoice-document'].includes(url.pathname)&&
          !await baselineReadyForQueue(env)) {
        throw fleetError(409,'baseline_working_ledger_unready');
      }
      if (url.pathname.endsWith('/mutations')) {
        const operations=await pushMutations(db,credential,epoch,await readBody(request));
        return response({epoch,operations});
      }
      if (url.pathname.endsWith('/invoice-jobs')) return response(await stageInvoiceJobs(env,credential,epoch,await readBody(request)));
      if (url.pathname.endsWith('/invoice-stage')) return response(await sealInvoiceStage(env,credential,epoch,await readBody(request)));
      if (url.pathname.endsWith('/invoice-file')) return response(await storeInvoiceFile(request,env,credential,url.searchParams.get('sha256'),initial?epoch:null));
      if (url.pathname.endsWith('/invoice-document')) return await readInvoiceFile(env,url.searchParams.get('sha256'));
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

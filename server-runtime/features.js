import {CASH_SCHEMA,routeCash} from './cash.js';
import {REPORT_SCHEMA,routeReports} from './reports.js';
import {reply} from './common.js';
import {routeExports} from './exports.js';
import {REVIEW_SCHEMA,routePayrollReview} from './payroll-review.js';
import {HEALTH_SCHEMA,routeHealth} from './health.js';
import {publishChanges} from '../cloudflare-worker/src/change-events.js';
import {routeFiles} from './files.js';
export const FEATURE_SCHEMA=CASH_SCHEMA+'\n'+REPORT_SCHEMA+'\n'+REVIEW_SCHEMA+'\n'+HEALTH_SCHEMA;
export async function routeFeatures(request,env,dispatch){
  try{
    const response=await routeFiles(request,env,dispatch)||await routeExports(request,env)||await routeCash(request,env)||await routeReports(request,env)||await routePayrollReview(request,env,dispatch)||await routeHealth(request,env);
    if(response?.ok&&!['GET','HEAD','OPTIONS'].includes(request.method)){
      const path=new URL(request.url).pathname,scopes=path.startsWith('/api/native/cash')?['cash']:path.startsWith('/api/native/store-financials')?['stores']:path.startsWith('/api/native/payroll-review')?['workforce']:path.startsWith('/api/native/health')?['status']:[];
      await publishChanges(env,Array.isArray(response.nativeChanges)?response.nativeChanges:scopes);
    }
    return response;
  }
  catch(error){if(Number(error.status)>=400&&Number(error.status)<500)return reply({error:error.message,code:error.code},Number(error.status));throw error;}
}

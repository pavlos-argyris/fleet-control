import {stable} from './common.js';
export function storeFinancialValue(row){return Object.fromEntries(Object.entries(row||{}).filter(([key])=>!['sourceLastSuccessAt','computedAt','runId'].includes(key)));}
/** A fresh complete proof binds the values, not per-store timestamp rewrites.
 * A changed row arriving before its new proof remains explicitly unknown. */
export function matchesStoreProof(snapshot,proof,storeId,cloud){
 if(!proof||proof.needsSourceRefresh||!proof.sourceAt)return false;
 if(cloud&&proof.cloudSnapshots)return !!proof.cloudSnapshots[storeId]&&stable(storeFinancialValue(snapshot))===stable(proof.cloudSnapshots[storeId]);
 return snapshot.sourceLastSuccessAt===proof.sourceAt;
}

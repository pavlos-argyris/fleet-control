// Deterministic evidence gate for an isolated restore. This module performs
// NO decryption, ZIP parsing, filesystem writes or production restore.
// Only verified native backup/restore probes may supply trusted evidence.
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/i.test(v);
const date=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
export function recoveryEvidenceGate({requiredDatasets=[],archive=null,integrity=null,isolatedRestore=null}={}){
 if(!Array.isArray(requiredDatasets)||requiredDatasets.some(x=>typeof x!=='string'||!x)||new Set(requiredDatasets).size!==requiredDatasets.length)throw new TypeError('Invalid required datasets');
 const blockers=[];
 if(!archive||!hex(archive.sha256)||!Number.isSafeInteger(archive.sizeBytes)||archive.sizeBytes<=0||!date(archive.createdAt))blockers.push('archive-metadata-unverified');
 if(!integrity||integrity.archiveSha256!==archive?.sha256||integrity.authTagValid!==true||integrity.checksumsValid!==true||integrity.manifestValid!==true)blockers.push('archive-integrity-unverified');
 const cover=Array.isArray(archive?.datasets)?archive.datasets:[];
 for(const dataset of requiredDatasets)if(!cover.includes(dataset))blockers.push('missing-dataset:'+dataset);
 if(!isolatedRestore||isolatedRestore.isolated!==true||isolatedRestore.productionWrites===true||isolatedRestore.completed!==true||isolatedRestore.archiveSha256!==archive?.sha256||!date(isolatedRestore.verifiedAt)||!date(archive?.createdAt)||Date.parse(isolatedRestore.verifiedAt)<Date.parse(archive.createdAt))blockers.push('isolated-restore-not-proven');
 if(isolatedRestore?.sourceRevalidated!==true||isolatedRestore?.rowCountsMatched!==true||isolatedRestore?.referentialChecksPassed!==true)blockers.push('restored-data-consistency-unverified');
 if(Array.isArray(isolatedRestore?.datasets)){for(const dataset of requiredDatasets)if(!isolatedRestore.datasets.includes(dataset))blockers.push('restore-dataset-unverified:'+dataset);}
 else if(requiredDatasets.length)blockers.push('restore-datasets-not-reported');
 const unique=[...new Set(blockers)];
 return {evidenceComplete:unique.length===0,blockers:unique,productionRestorePerformed:false,warning:'Evidence gate only: it does not run backup verification or restore. Require actual native non-production results.'};
}

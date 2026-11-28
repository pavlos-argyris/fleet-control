import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { invoiceStageProof } from '../cloudflare-worker/hybrid-fleet/invoice-jobs.js';

const PRIVATE_OBJECT=/^[a-f0-9]{64}-[a-f0-9]{64}\.(pdf|png|jpg|webp|bin)$/;
const SHA=/^[a-f0-9]{64}$/;
const MAX_FILE=15*1024*1024;

// stageRequest is the authenticated, epoch-fenced rehearsal transport. No
// part of the caller's private SQLite or raw pending rows is sent over it.
// Every response is a durable receipt, so a stopped transfer is replayable
// from the same plan without creating another job or rewriting any document.
export async function stageNativeInvoicePlan(plan,objectFolder,stageRequest) {
  if (plan?.format!=='private-fleet-invoice-plan-v1' || plan.count!==plan.jobs?.length ||
      await invoiceStageProof(plan.jobs)!==plan.manifestHash || plan.backupBlockingReasons.length) {
    throw new Error('Invoice plan or native verification differs');
  }
  for (const file of plan.objects) {
    if (!PRIVATE_OBJECT.test(file.local_name)||!SHA.test(file.sha256)) throw new Error('Invalid private file inventory');
    const local=resolve(objectFolder,file.local_name);
    const stat=lstatSync(local);
    if (!stat.isFile()||stat.size!==file.size||stat.size<=0||stat.size>MAX_FILE) throw new Error('Private attachment size differs');
    const bytes=readFileSync(local);
    if (bytes.length!==file.size || createHash('sha256').update(bytes).digest('hex')!==file.sha256) throw new Error('Private attachment checksum differs');
    const receipt=await stageRequest('/invoice-file?sha256='+file.sha256,{
      method:'PUT',headers:{'Content-Type':file.content_type,'Content-Length':String(bytes.length)},body:bytes
    });
    if (receipt?.verified!==true||receipt.sha256!==file.sha256||receipt.size!==file.size) throw new Error('Attachment receipt differs');
  }
  for (let index=0; index<plan.count; index+=6) {
    const batch=plan.jobs.slice(index,index+6);
    const reply=await stageRequest('/invoice-jobs',jsonRequest({jobs:batch}));
    if (!Array.isArray(reply?.jobs)||reply.jobs.length!==batch.length||
        reply.jobs.some((item,i)=>item.operationId!==batch[i].operationId)) throw new Error('Invoice batch receipt differs');
  }
  const {count,manifestHash}=plan;
  const proof=await stageRequest('/invoice-stage',jsonRequest({count,manifestHash}));
  if (proof?.verified!==true||proof.count!==count||proof.manifestHash!==manifestHash) throw new Error('Invoice stage proof differs');
  return proof;
}

function jsonRequest(input) {
  return {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)};
}

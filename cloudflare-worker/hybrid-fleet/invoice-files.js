import { fleetError } from './ledger.js';

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const contentTypes=new Set(['application/pdf','image/jpeg','image/png','image/webp','image/heic','image/heif','application/octet-stream']);
const hex=value=>Array.from(new Uint8Array(value),byte=>byte.toString(16).padStart(2,'0')).join('');

export async function storeInvoiceFile(request,env,credential,sha256) {
  if (credential.scope!=='sync-read-write') throw fleetError(403,'sync_write_scope_required');
  if (!/^[a-f0-9]{64}$/.test(sha256||'')) throw fleetError(400,'invalid_attachment_digest');
  if (!env.FLEET_DOCUMENTS) throw fleetError(503,'private_documents_unavailable');
  const type=request.headers.get('Content-Type');
  if (!contentTypes.has(type)) throw fleetError(415,'invalid_attachment_type');
  const size=Number(request.headers.get('Content-Length'));
  if (!Number.isSafeInteger(size)||size<=0||size>MAX_FILE_BYTES||!request.body) throw fleetError(413,'invalid_attachment_size');
  const bytes=new Uint8Array(size),reader=request.body.getReader();
  let offset=0;
  try {
    for (;;) {
      const {value,done}=await reader.read();
      if (done) break;
      if (offset+value.byteLength>size) throw fleetError(422,'attachment_size_mismatch');
      bytes.set(value,offset);
      offset+=value.byteLength;
    }
  } catch (error) { await reader.cancel().catch(()=>{}); throw error; }
  if (offset!==size) throw fleetError(422,'attachment_size_mismatch');
  if (hex(await crypto.subtle.digest('SHA-256',bytes))!==sha256) throw fleetError(422,'attachment_digest_mismatch');
  const key='sha256/'+sha256;
  const stored=await env.FLEET_DOCUMENTS.put(key,bytes,{sha256,onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:type}});
  const object=stored||await env.FLEET_DOCUMENTS.head(key);
  if (!object || object.size!==size || object.checksums?.toJSON()?.sha256!==sha256) {
    throw fleetError(503,'attachment_not_durable');
  }
  return {sha256,size,verified:true,replayed:!stored};
}

export async function readInvoiceFile(env,sha256) {
  if (!/^[a-f0-9]{64}$/.test(sha256||'')) throw fleetError(400,'invalid_attachment_digest');
  if (!env.FLEET_DOCUMENTS) throw fleetError(503,'private_documents_unavailable');
  // A replica can still be reading a committed invoice page preceding a
  // subsequent correction or tombstone. Files stay available for that replay.
  const accessible=await env.FLEET_DB.prepare(`SELECT 1 FROM fleet_mutations WHERE kind='invoice' AND deleted=0
    AND (json_extract(data,'$.sha256')=? OR json_extract(data,'$.sourceSha256')=?) LIMIT 1`).bind(sha256,sha256).first();
  if (!accessible) throw fleetError(404,'invoice_document_unreferenced');
  const object=await env.FLEET_DOCUMENTS.get('sha256/'+sha256);
  if (!object||object.size<=0||object.size>MAX_FILE_BYTES||object.checksums?.toJSON()?.sha256!==sha256) {
    await object?.body.cancel();
    throw fleetError(503,'invoice_document_not_verified');
  }
  const type=object.httpMetadata?.contentType;
  return new Response(object.body,{headers:{'Content-Type':contentTypes.has(type)?type:'application/octet-stream',
    'Content-Length':String(object.size),'X-Fleet-Sha256':sha256,'Cache-Control':'no-store',
    'Content-Disposition':'attachment','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff',
    'Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"}});
}

import { fleetError } from './ledger.js';

export const INITIAL_TRANSFER_HOST='fleet-control-fleet.pavlosargyris.workers.dev';
const HEX=/^[a-f0-9]{64}$/;
const limit=(value,max)=>/^\d{1,10}$/.test(value||'')&&Number(value)>0&&Number(value)<=max?Number(value):0;

export function transferMode(env) {
  if (env.FLEET_INITIAL_TRANSFER!=='1') return env.FLEET_REHEARSAL_ENABLED==='1'?'rehearsal':null;
  if (env.FLEET_REHEARSAL_ENABLED==='1'||env.FLEET_BASELINE_TRANSFER!=='1'||env.FLEET_SOURCE_DELTA_TRANSFER!=='1'||
      !env.FLEET_DB||!env.FLEET_DOCUMENTS||!initialTransferLimits(env).records||!initialTransferLimits(env).media) return null;
  return 'initial-transfer';
}

export function initialTransferLimits(env) {
  return {records:limit(env.FLEET_INITIAL_TRANSFER_RECORD_BYTES,500000000),media:limit(env.FLEET_INITIAL_TRANSFER_MEDIA_BYTES,10000000000)};
}

export function initialEnrollmentConfigured(env) {
  return typeof env.FLEET_PIN_PEPPER==='string'&&env.FLEET_PIN_PEPPER.length>=43&&HEX.test(env.FLEET_RECOVERY_CREDENTIAL_SHA256||'');
}

export async function reserveInitialMedia(env,credential,epoch,sha,size) {
  const db=env.FLEET_DB,max=initialTransferLimits(env).media;
  const [,receipt]=await db.batch([
    db.prepare(`INSERT INTO fleet_initial_media(sha256,size)
      SELECT ?,? WHERE EXISTS(SELECT 1 FROM fleet_rehearsal_state WHERE id=1 AND epoch=?)
      AND EXISTS(SELECT 1 FROM fleet_sync_credentials WHERE id=? AND secret_sha256=? AND scope='sync-read-write'
        AND revoked_at IS NULL AND expires_at>?)
      AND (EXISTS(SELECT 1 FROM fleet_baseline WHERE epoch=? AND verified_at IS NULL)
        OR EXISTS(SELECT 1 FROM fleet_source_deltas WHERE epoch=? AND verified_at IS NULL))
      AND (SELECT bytes FROM fleet_initial_media_usage WHERE id=1)<=?-?
      ON CONFLICT(sha256) DO NOTHING`).bind(sha,size,epoch,credential.id,credential.hash,Date.now(),epoch,epoch,max,size),
    db.prepare('SELECT size FROM fleet_initial_media WHERE sha256=?').bind(sha)
  ]);
  if (receipt.results[0]?.size!==size) throw fleetError(409,'initial_transfer_media_not_admitted');
}

import crypto from 'node:crypto';
import '../cloudflare-worker/public/primary-crypto.js';

// Use the same identity and cloud-return certificate checks as the shipped client.
export async function verifyProbeAuthority(value, origin) {
  await globalThis.FleetPrimaryCrypto.descriptor(value, origin);
  if(value.mode==='cloud'&&value.backend&&!['d1','cloud-sqlite'].includes(value.backend))throw Error('Unknown cloud backend');
  if (value.mode === 'cloud' && value.backend === 'cloud-sqlite'
      && !await globalThis.FleetPrimaryCrypto.cloudReturn(value, value)) {
    throw Error('Invalid cloud-return authority certificate');
  }
  return {
    mode: value.mode,
    backend: value.mode === 'cloud' ? value.backend || 'd1' : 'android',
    connected: value.connected === true,
    transitional: !['cloud', 'active'].includes(value.mode),
  };
}

export function expectedPrimaryFence(response, value, authority) {
  return authority.mode !== 'cloud' && response?.status === 503
    && value?.code === 'primary_transport_required'
    && value.mode === authority.mode && value.generation === authority.generation;
}

export async function verifyProbeWebAsset(base, file, expected, fetcher = fetch) {
  if (!expected || !/^[a-f0-9]{64}$/.test(expected.sha256)
      || !Number.isSafeInteger(expected.sizeBytes) || expected.sizeBytes < 1) {
    throw Error('Missing pinned Web asset ' + file);
  }
  let url = new URL('/' + file, base), response;
  const redirects = [];
  for (let hop = 0; hop < 3; hop++) {
    response = await fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(30000) });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('Location');
    const next = location ? new URL(location, url) : null;
    // Cloudflare Assets canonicalizes /portal.html to /portal. Do not forward
    // credentials or accept other origins, login redirects or redirect loops.
    if (file !== 'portal.html' || !next || next.origin !== base.origin
        || next.username || next.password || next.search || next.hash
        || !['/portal', '/portal/'].includes(next.pathname)
        || redirects.some(r => r.to === next.pathname) || next.href === url.href) {
      throw Error('Unexpected Web redirect');
    }
    redirects.push({ status: response.status, from: url.pathname, to: next.pathname });
    await response.body?.cancel();
    url = next;
  }
  if (!response?.ok || response.status !== 200) throw Error('Live Web response failed');
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== expected.sizeBytes || digest !== expected.sha256) {
    throw Error('Live Web differs from pinned release');
  }
  return { file, verified: true, size: bytes.length, sha256: digest, redirects };
}

// Transport only. Credentials, sessions and business queries run on Android.
// No D1 access, stored request bodies, or automatic replay of mutations.
const MAX_BYTES = 2 * 1024 * 1024;
const encoder = new TextEncoder();
export const validDirectPacket = value => value?.v === 1 && /^[a-f0-9]{32}$/.test(value.nonce || '') &&
  /^[A-Za-z0-9_-]{122}$/.test(value.epk || '') && /^[A-Za-z0-9_-]{16}$/.test(value.iv || '') &&
  typeof value.ciphertext === 'string' && /^[A-Za-z0-9_-]{22,2097152}$/.test(value.ciphertext);
const response = (body, status = 200) => Response.json(body, {status, headers: {
  'Cache-Control': 'private, no-store', 'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Fleet-Direct-Key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS', 'X-Content-Type-Options': 'nosniff'
}});
export async function directHash(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function serverAuthorized(request, env) {
  const supplied = request.headers.get('X-Fleet-Server-Key') || '';
  if (!env.SERVER_KEY || supplied.length < 24 || supplied.length > 512) return false;
  return await directHash(supplied) === await directHash(env.SERVER_KEY);
}
export async function routeDirectRelay(request, env) {
  const path = new URL(request.url).pathname;
  if (!path.startsWith('/api/direct/')) return null;
  if (request.method === 'OPTIONS') return response({});
  if (!env.FLEET_EVENTS) return response({error: 'Η απευθείας πρόσβαση δεν είναι διαθέσιμη.'}, 503);
  const relay = env.FLEET_EVENTS.get(env.FLEET_EVENTS.idFromName('fleet'));
  if (path === '/api/direct/connect' && request.method === 'GET') {
    if (!await serverAuthorized(request, env)) return response({error: 'Μη έγκυρος Server.'}, 401);
    const pairHash = request.headers.get('X-Fleet-Direct-Pair') || '';
    if (!/^[a-f0-9]{64}$/.test(pairHash) || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
      return response({error: 'Μη έγκυρη σύνδεση Server.'}, 400);
    return relay.fetch(new Request('https://events.internal/direct/connect', {headers: {
      Upgrade: 'websocket', 'X-Fleet-Direct-Pair': pairHash
    }}));
  }
  if (path !== '/api/direct/request' || request.method !== 'POST') return response({error: 'Η διαδρομή δεν βρέθηκε.'}, 404);
  const key = request.headers.get('X-Fleet-Direct-Key') || '';
  if (!/^[a-f0-9]{64}$/.test(key)) return response({error: 'Χρειάζεται σύζευξη με τον Server.'}, 401);
  if (Number(request.headers.get('Content-Length')) > MAX_BYTES) return response({error: 'Το αίτημα είναι πολύ μεγάλο.'}, 413);
  let raw = '';
  if (request.body) {
    const reader=request.body.getReader(), decoder=new TextDecoder();let bytes=0;
    for (;;) { const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>MAX_BYTES){await reader.cancel();return response({error:'Το αίτημα είναι πολύ μεγάλο.'},413);}raw+=decoder.decode(chunk.value,{stream:true}); }
    raw+=decoder.decode();
  }
  let body; try { body = JSON.parse(raw); } catch { return response({error: 'Μη έγκυρο αίτημα.'}, 400); }
  // Only an encrypted packet crosses this relay. Android owns the API allowlist.
  if (!validDirectPacket(body)) return response({error: 'Μη έγκυρο κρυπτογραφημένο αίτημα.'}, 400);
  return relay.fetch(new Request('https://events.internal/direct/request', {method: 'POST',
    headers: {'X-Fleet-Direct-Pair': key},body: JSON.stringify(body)}));
}

export class DirectRelay {
  constructor(ctx) { this.ctx = ctx; this.pending = new Map(); }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/direct/connect') {
      const pair = new WebSocketPair(), server = pair[1];
      for (const old of this.ctx.getWebSockets('direct-server')) try { old.close(1000, 'replaced'); } catch {}
      this.failPending();
      this.ctx.acceptWebSocket(server, ['direct-server']);
      server.serializeAttachment({direct: true, pairHash: request.headers.get('X-Fleet-Direct-Pair')});
      server.send(JSON.stringify({type: 'ready'}));
      return new Response(null, {status: 101, webSocket: pair[0]});
    }
    if (path !== '/direct/request') return response({error: 'Η διαδρομή δεν βρέθηκε.'}, 404);
    const server = this.ctx.getWebSockets('direct-server').find(ws => ws.readyState === 1);
    if (!server) return response({error: 'Ο Server δεν είναι συνδεδεμένος. Άνοιξε την υπηρεσία στο κινητό Server.'}, 503);
    const attachment = server.deserializeAttachment();
    if (request.headers.get('X-Fleet-Direct-Pair') !== attachment?.pairHash)
      return response({error: 'Ο κωδικός σύζευξης άλλαξε. Σύνδεσε ξανά τη συσκευή.'}, 401);
    if (this.pending.size >= 16) return response({error: 'Ο Server εξυπηρετεί άλλες εργασίες. Δοκίμασε σε λίγο.'}, 429);
    const body = await request.json(), id = crypto.randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(response({error: 'Ο Server δεν απάντησε εγκαίρως. Έλεγξε την κατάσταση πριν επαναλάβεις αποθήκευση.'}, 504));
      }, 25000);
      this.pending.set(id, {resolve, timer, server, nonce: body.nonce, epk: body.epk});
      try { server.send(JSON.stringify({type: 'request', id, request: body})); }
      catch { clearTimeout(timer); this.pending.delete(id); resolve(response({error: 'Η σύνδεση με τον Server διακόπηκε.'}, 503)); }
    });
  }
  message(ws, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_BYTES * 2) { ws.close(1009, 'too large'); return; }
    if (raw === 'ping') { ws.send('pong'); return; }
    let value; try { value = JSON.parse(raw); } catch { return; }
    const item = this.pending.get(value.id);
    if (!item || item.server !== ws) return;
    this.pending.delete(value.id); clearTimeout(item.timer);
    const payload = value.response;
    if (!validDirectPacket(payload) || payload.nonce !== item.nonce || payload.epk !== item.epk) {
      item.resolve(response({error: 'Μη έγκυρη απόκριση Server.'}, 502)); return;
    }
    item.resolve(response(payload));
  }
  failPending(ws) {
    for (const [id, item] of this.pending) if (!ws || item.server === ws) {
      clearTimeout(item.timer); this.pending.delete(id);
      item.resolve(response({error: 'Η σύνδεση με τον Server διακόπηκε.'}, 503));
    }
  }
}

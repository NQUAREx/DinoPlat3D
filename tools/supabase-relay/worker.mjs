// No secrets or configurable upstream. Authorization remains the backend's job.
const UPSTREAM = 'https://yusnxxdeumczuniwumvi.supabase.co';
const LIMIT = 8192;
const TIMEOUT = 10000;
export function allowedOrigin(origin) {
  if (origin === 'https://nquarex.github.io') return true;
  try {
    const url = new URL(origin);
    return url.origin === origin && url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch { return false; }
}
async function limitedBody(request, signal) {
  if (Number(request.headers.get('content-length')) > LIMIT) throw new Error('limit');
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > LIMIT) { await reader.cancel(); throw new Error('limit'); }
      chunks.push(value);
    }
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
  const body = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}
export async function relay(request, upstreamFetch = fetch) {
  const origin = request.headers.get('origin');
  if (!allowedOrigin(origin)) return new Response('Forbidden origin', { status: 403 });
  const headers = new Headers({
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  const reply = (text, status) => new Response(text, { status, headers });
  const url = new URL(request.url);
  const auth = url.pathname === '/auth/v1/token';
  const logout = url.pathname === '/auth/v1/logout';
  if (url.pathname !== '/functions/v1/game-api' && !auth && !logout) return reply('Not found', 404);
  if (auth ? [...url.searchParams.keys()].some(k => k !== 'grant_type') ||
      url.searchParams.getAll('grant_type').length !== 1 ||
      !['password', 'refresh_token'].includes(url.searchParams.get('grant_type')) : !!url.search)
    return reply('Invalid query', 400);
  if (request.method === 'OPTIONS') {
    if (request.headers.get('access-control-request-method') !== 'POST') return reply('Method not allowed', 405);
    const requested = (request.headers.get('access-control-request-headers') || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
    if (requested.some(h => !['authorization', 'apikey', 'content-type', 'x-client-info'].includes(h))) return reply('Forbidden header', 403);
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== 'POST') return reply('Method not allowed', 405);
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return reply('JSON required', 415);
  const controller = new AbortController();
  let timer;
  try {
    // Bound both upload reading and upstream response, including stalled bodies.
    const operation = async () => {
      const body = await limitedBody(request, controller.signal);
      if (controller.signal.aborted) return reply('Upstream timeout', 504);
      const forwarded = new Headers();
      for (const name of ['authorization', 'apikey', 'content-type', 'x-client-info']) {
        if (request.headers.has(name)) forwarded.set(name, request.headers.get(name));
      }
      const response = await upstreamFetch(UPSTREAM + url.pathname + url.search, {
        method: 'POST', headers: forwarded, body, signal: controller.signal,
        redirect: 'manual', credentials: 'omit',
      });
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); return reply('Upstream redirect refused', 502); }
      const data = await response.arrayBuffer();
      headers.set('Content-Type', response.headers.get('content-type') || 'application/json');
      if (response.headers.has('retry-after')) headers.set('Retry-After', response.headers.get('retry-after'));
      return new Response(data.byteLength ? data : null, { status: response.status, headers });
    };
    return await Promise.race([operation(), new Promise(resolve => {
      timer = setTimeout(() => { controller.abort(); void request.body?.cancel().catch(() => {}); resolve(reply('Upstream timeout', 504)); }, TIMEOUT);
    })]);
  } catch (error) { return reply(error.message === 'limit' ? 'Body too large' : 'Upstream unavailable', error.message === 'limit' ? 413 : 502); }
  finally { clearTimeout(timer); }
}
export default { fetch: request => relay(request) };

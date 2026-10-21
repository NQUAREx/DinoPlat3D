export class ApiError extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}
type Env = (name: string) => string | undefined;
type Dependencies = { env: Env; fetch: typeof fetch; background?: (promise: Promise<unknown>) => void };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const device = /^[0-9a-f]{64}$/;
const writeActions = new Set(['profile-rename', 'visit', 'heartbeat', 'run-start', 'run-finish']);
const actions = new Set(['profile', ...writeActions, 'leaderboard', 'admin-summary', 'maintenance', 'telegram-flush']);
export async function sha256(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(x => x.toString(16).padStart(2, '0')).join('');
}
export function validate(input: Record<string, unknown>) {
  const action = input.action;
  if (typeof action !== 'string' || !actions.has(action)) throw new ApiError('invalid_action');
  if (writeActions.has(action) && (typeof input.request_id !== 'string' || !uuid.test(input.request_id))) throw new ApiError('invalid_request_id');
  for (const key of ['session_id', 'run_id']) if (input[key] !== undefined && (typeof input[key] !== 'string' || !uuid.test(input[key] as string))) throw new ApiError(`invalid_${key}`);
  if (['heartbeat', 'run-start'].includes(action) && !input.session_id) throw new ApiError('invalid_session_id');
  if (action === 'run-finish' && !input.run_id) throw new ApiError('invalid_run_id');
  if (action === 'profile-rename' || (action === 'profile' && input.nickname !== undefined)) {
    if (typeof input.nickname !== 'string') throw new ApiError('invalid_nickname');
    input.nickname = input.nickname.normalize('NFKC').trim();
    if (!/^[\p{L}\p{N}_-]{3,20}$/u.test(input.nickname as string)) throw new ApiError('invalid_nickname');
  }
  if (action === 'heartbeat' && (!Number.isInteger(input.active_seconds) || Number(input.active_seconds) < 0 || Number(input.active_seconds) > 86400)) throw new ApiError('invalid_active_seconds');
  if (action === 'run-finish') {
    for (const [key, max] of [['distance', 561600], ['duration', 21600], ['coins', 432010]] as const) {
      if (typeof input[key] !== 'number' || !Number.isFinite(input[key]) || Number(input[key]) < 0 || Number(input[key]) > max) throw new ApiError('invalid_run');
    }
    if (!Number.isInteger(input.coins)) throw new ApiError('invalid_run');
  }
  if (action === 'leaderboard' && (!['score', 'coins'].includes(String(input.metric)) || !['day', 'week', 'all'].includes(String(input.period)) || (input.limit !== undefined && (!Number.isInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 100)))) throw new ApiError('invalid_input');
  return action;
}

export function createHandler(deps: Dependencies) {
  const env = deps.env;
  async function rest(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
    const key = env('SUPABASE_SERVICE_ROLE_KEY');
    const url = env('SUPABASE_URL');
    if (!key || !url) throw new ApiError('server_configuration', 503);
    const response = await deps.fetch(`${url}/rest/v1/${path}`, {
      method, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000),
    });
    const data = response.status === 204 ? null : await response.json();
    if (!response.ok) {
      const code = String(data.message || 'database_error');
      const known = /^(nickname_taken|unknown_device|invalid_[a-z_]+|idempotency_conflict|implausible_run|registration_rate_limited)$/;
      if (!known.test(code)) throw new ApiError('database_error', 500);
      throw new ApiError(code, code === 'registration_rate_limited' ? 429 : code === 'unknown_device' ? 401 : ['nickname_taken', 'idempotency_conflict'].includes(code) ? 409 : 400);
    }
    return data;
  }
  const rpc = (name: string, body: unknown = {}) => rest(`rpc/${name}`, body);
  async function telegram() {
    const delivery = { sent: 0, failed: 0, lastStatus: 0 };
    let token = env('TELEGRAM_BOT_TOKEN'); let chat = env('TELEGRAM_CHAT_ID');
    if (!token || !chat) {
      const config = await rpc('game_telegram_config');
      token ||= config?.bot_token; chat ||= config?.chat_id;
    }
    if (!token || !chat) return delivery;
    const rows = await rpc('game_claim_outbox');
    for (const row of rows) {
      let ok = false;
      try {
        const res = await deps.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chat, text: row.message, disable_web_page_preview: true }), signal: AbortSignal.timeout(5000),
        });
        delivery.lastStatus = res.status;
        ok = res.ok && (await res.json()).ok === true;
      } catch { /* Credentials/URLs must never enter logs or DB errors. */ }
      await rpc('game_ack_outbox', { p_id: row.id, p_lease: row.lease_id, p_ok: ok });
      if (ok) delivery.sent++; else delivery.failed++;
    }
    return delivery;
  }
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('Origin');
    const allowed = (env('ALLOWED_ORIGINS') || 'https://nquarex.github.io,http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173').split(',').map(x => x.trim()).filter(Boolean);
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin', 'Access-Control-Allow-Headers': 'authorization,apikey,content-type,x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
    if (origin && allowed.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
    const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers });
    try {
      if (origin && !allowed.includes(origin)) throw new ApiError('origin_forbidden', 403);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
      if (request.method !== 'POST') throw new ApiError('method_not_allowed', 405);
      if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new ApiError('json_required', 415);
      if (Number(request.headers.get('content-length')) > 8192) throw new ApiError('body_too_large', 413);
      const reader = request.body?.getReader();
      if (!reader) throw new ApiError('invalid_json');
      let bytes = 0; const chunks: Uint8Array[] = [];
      while (true) { const { value, done } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > 8192) { await reader.cancel(); throw new ApiError('body_too_large', 413); } chunks.push(value); }
      const joined = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
      let input: Record<string, unknown>;
      try { input = JSON.parse(new TextDecoder().decode(joined)); } catch { throw new ApiError('invalid_json'); }
      if (!input || Array.isArray(input) || typeof input !== 'object') throw new ApiError('invalid_json');
      // Older clients may duplicate the bearer in JSON. Never persist it in the
      // idempotency payload, and never accept it instead of Authorization.
      delete input.token;
      const fields = new Set(['action', 'request_id', 'nickname', 'session_id', 'run_id', 'active_seconds', 'distance', 'duration', 'coins', 'metric', 'period', 'limit']);
      if (Object.keys(input).some(key => !fields.has(key))) throw new ApiError('invalid_field');
      const action = validate(input);
      const match = /^Bearer ([^\s]+)$/.exec(request.headers.get('Authorization') || '');
      if (!match) throw new ApiError('unauthorized', 401);
      const bearer = match[1];
      // Fixed key first: rotating device tokens cannot create unbounded limiter rows.
      if (!await rpc('game_rate_limit', { p_key: 'global:requests', p_limit: 600, p_seconds: 60 })) throw new ApiError('rate_limited', 429);
      if (action === 'maintenance' || action === 'telegram-flush') {
        const expected = env('GAME_WORKER_SECRET');
        const hash = await sha256(bearer);
        const allowed = expected ? expected.length >= 32 && hash === await sha256(expected) : await rpc('game_worker_authorized', { p_hash: hash });
        if (!allowed) throw new ApiError('forbidden', 403);
        if (action === 'maintenance') return reply({ ok: true, data: await rpc('game_maintenance') });
        const delivery = await telegram(); return reply({ ok: true, data: { processed: true, delivery } });
      }
      if (action === 'admin-summary') {
        const key = env('SUPABASE_SERVICE_ROLE_KEY'); const url = env('SUPABASE_URL');
        if (!key || !url) throw new ApiError('server_configuration', 503);
        if (!await rpc('game_rate_limit', { p_key: `admin:${await sha256(bearer)}`, p_limit: 20, p_seconds: 60 })) throw new ApiError('rate_limited', 429);
        const res = await deps.fetch(`${url}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new ApiError('unauthorized', 401);
        const user = await res.json();
        if (!user.id || !user.email || !user.email_confirmed_at || user.is_anonymous) throw new ApiError('forbidden', 403);
        const admins = await rest(`game_admin_emails?email=eq.${encodeURIComponent(String(user.email).toLowerCase())}&select=email`);
        const ids = await rest(`game_admins?user_id=eq.${encodeURIComponent(user.id)}&select=user_id`);
        if (!admins.length && !ids.length) throw new ApiError('forbidden', 403);
        const summary = await rest('game_admin_summary?select=*');
        return reply({ ok: true, data: { summary: summary[0] } });
      }
      if (!device.test(bearer)) throw new ApiError('invalid_device_token', 401);
      const hash = await sha256(bearer);
      if (!await rpc('game_rate_limit', { p_key: `device:${hash}`, p_limit: 120, p_seconds: 60 })) throw new ApiError('rate_limited', 429);
      // Only use a gateway-owned IP header explicitly configured by the operator.
      const ipHeader = env('TRUSTED_IP_HEADER');
      const ip = ipHeader ? request.headers.get(ipHeader) : null;
      if (action === 'profile' && ip && !await rpc('game_rate_limit', { p_key: `bootstrap:${await sha256(ip)}`, p_limit: 10, p_seconds: 3600 })) throw new ApiError('rate_limited', 429);
      const data = await rpc('game_action', { p_hash: hash, p_action: action, p_input: input });
      if ((action === 'profile' && typeof input.nickname === 'string') || action === 'run-finish') {
        const work = telegram().catch(() => {});
        if (deps.background) deps.background(work); else await work;
      }
      return reply({ ok: true, data });
    } catch (error) {
      const e = error instanceof ApiError ? error : new ApiError('internal_error', 500);
      return reply({ ok: false, error: { code: e.code, message: e.code } }, e.status);
    }
  };
}

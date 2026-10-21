import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHandler, sha256, validate } from '../supabase/functions/game-api/core.ts';

const token = 'a'.repeat(64);
const requestId = '11111111-1111-4111-8111-111111111111';
const envValues: Record<string, string> = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-service-key' };
const env = (name: string) => envValues[name];
function req(body: unknown, bearer = token) { return new Request('https://edge.test', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` }, body: JSON.stringify(body) }); }

test('validation rejects malformed IDs, impossible shapes, nonfinite metrics', () => {
  assert.throws(() => validate({ action: 'run-start', request_id: 'bad', session_id: requestId }));
  assert.throws(() => validate({ action: 'run-finish', request_id: requestId, run_id: requestId, distance: NaN, duration: 1, coins: 1 }));
  assert.throws(() => validate({ action: 'heartbeat', request_id: requestId, session_id: requestId, active_seconds: 1.5 }));
  assert.throws(() => validate({ action: 'leaderboard', metric: 'wallet', period: 'all' }));
  assert.throws(() => validate({ action: 'profile-rename', request_id: requestId, nickname: '<script>' }));
  const input = { action: 'profile', nickname: ' Ａbc ' }; validate(input); assert.equal(input.nickname, 'Abc');
  const spaced = { action: 'profile-rename', request_id: requestId, nickname: 'Dino Run' }; validate(spaced); assert.equal(spaced.nickname, 'Dino Run');
});

test('hashes are SHA256; raw device bearer never reaches REST', async () => {
  assert.equal((await sha256(token)).length, 64);
  const calls: { url: string; body: string }[] = [];
  const handler = createHandler({ env, fetch: (async (url, init) => {
    calls.push({ url: String(url), body: String(init?.body) });
    return Response.json(String(url).endsWith('game_rate_limit') ? true : { id: 'profile' });
  }) as typeof fetch });
  const response = await handler(req({ action: 'profile', token })); assert.equal(response.status, 200);
  assert.ok(calls.every(x => !x.body.includes(token)));
  assert.equal(JSON.parse(calls.find(x => x.url.endsWith('game_action'))!.body).p_hash, await sha256(token));
});

test('auth, body size, CORS, and methods fail closed', async () => {
  let calls = 0;
  const handler = createHandler({ env: name => name === 'ALLOWED_ORIGINS' ? 'https://game.test' : env(name), fetch: (async url => { calls++; return Response.json(!String(url).includes('game_worker_authorized')); }) as typeof fetch });
  assert.equal((await handler(new Request('https://edge.test'))).status, 405);
  assert.equal((await handler(req({ action: 'profile' }, 'wrong'))).status, 401);
  assert.equal((await handler(req({ action: 'profile', nickname: 'a'.repeat(9000) }))).status, 413);
  const blocked = req({ action: 'profile' }); blocked.headers.set('Origin', 'https://evil.test');
  assert.equal((await handler(blocked)).status, 403);
  assert.equal((await handler(req({ action: 'maintenance' }))).status, 403);
  assert.equal(calls, 3);
});

test('admin requires live confirmed auth identity and database allowlist', async () => {
  for (const state of ['bad-auth', 'unconfirmed', 'not-listed', 'allowed']) {
    const handler = createHandler({ env, fetch: (async url => {
      const path = String(url);
      if (path.includes('game_rate_limit')) return Response.json(true);
      if (path.endsWith('/auth/v1/user')) return state === 'bad-auth' ? Response.json({}, { status: 401 }) : Response.json({ id: requestId, email: 'nquare.x@gmail.com', email_confirmed_at: state === 'unconfirmed' ? null : '2026-10-21', is_anonymous: false });
      if (path.includes('game_admin_emails')) return Response.json(state === 'allowed' ? [{ email: 'nquare.x@gmail.com' }] : []);
      if (path.includes('game_admins?')) return Response.json([]);
      return Response.json([{ players: 1 }]);
    }) as typeof fetch });
    assert.equal((await handler(req({ action: 'admin-summary' }, 'auth.jwt.token'))).status, state === 'allowed' ? 200 : state === 'bad-auth' ? 401 : 403);
  }
});

test('rate limits and private DB errors are sanitized', async () => {
  for (const limited of [true, false]) {
    const handler = createHandler({ env, fetch: (async url => String(url).includes('game_rate_limit') ? Response.json(!limited) : Response.json({ message: 'SECRET_INTERNAL_VALUE' }, { status: 500 })) as typeof fetch });
    const response = await handler(req({ action: 'leaderboard', metric: 'score', period: 'all' }));
    assert.equal(response.status, limited ? 429 : 500); assert.ok(!(await response.text()).includes('SECRET_INTERNAL_VALUE'));
  }
});

test('Telegram uses Vault fallback, leases and acks without exposing credentials', async () => {
  const seen: string[] = [];
  const handler = createHandler({ env, fetch: (async (url, init) => {
    const path = String(url); seen.push(path);
    if (path.includes('game_rate_limit')) return Response.json(true);
    if (path.includes('game_action')) return Response.json({ id: 'profile' });
    if (path.includes('game_telegram_config')) return Response.json({ bot_token: 'secret-token', chat_id: 'secret-chat' });
    if (path.includes('game_claim_outbox')) return Response.json([{ id: requestId, lease_id: requestId, message: 'record' }]);
    if (path.includes('api.telegram.org')) { assert.equal(JSON.parse(String(init?.body)).chat_id, 'secret-chat'); return Response.json({ ok: true }); }
    if (path.includes('game_ack_outbox')) { assert.equal(JSON.parse(String(init?.body)).p_ok, true); return new Response(null, { status: 204 }); }
    throw Error('unexpected');
  }) as typeof fetch });
  const response = await handler(req({ action: 'profile', nickname: 'Runner' }));
  assert.equal(response.status, 200); assert.ok(!(await response.text()).includes('secret'));
  assert.ok(seen.some(x => x.includes('game_ack_outbox')));
});

test('operational Telegram flush handles PostgREST void 204 and returns safe delivery status', async () => {
  const handler = createHandler({ env: name => name === 'GAME_WORKER_SECRET' ? token : env(name), fetch: (async url => {
    const path = String(url);
    if (path.includes('game_rate_limit')) return Response.json(true);
    if (path.includes('game_telegram_config')) return Response.json({ bot_token: 'secret-token', chat_id: 'secret-chat' });
    if (path.includes('game_claim_outbox')) return Response.json([{ id: requestId, lease_id: requestId, message: 'test' }]);
    if (path.includes('api.telegram.org')) return Response.json({ ok: true });
    if (path.includes('game_ack_outbox')) return new Response(null, { status: 204 });
    throw Error('unexpected');
  }) as typeof fetch });
  const response = await handler(req({ action: 'telegram-flush' }));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.delivery, { sent: 1, failed: 0, lastStatus: 200 });
});

test('PostgreSQL integration: identity, ownership, exactly-once earnings, rankings, retention, privileges', { skip: !process.env.BACKEND_PGLITE_MODULE }, async () => {
  const { PGlite } = await import(process.env.BACKEND_PGLITE_MODULE!);
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key);`);
  const migration = readdirSync(new URL('../supabase/migrations/', import.meta.url)).find(x => x.endsWith('_game_backend.sql'))!;
  await db.exec(readFileSync(new URL(`../supabase/migrations/${migration}`, import.meta.url), 'utf8'));
  const vaultMigration = readdirSync(new URL('../supabase/migrations/', import.meta.url)).find(x => x.endsWith('_private_vault_helpers.sql'))!;
  await db.exec(readFileSync(new URL(`../supabase/migrations/${vaultMigration}`, import.meta.url), 'utf8'));
  let counter = 1;
  const id = () => `22222222-2222-4222-8222-${String(counter++).padStart(12, '0')}`;
  const call = async (hash: string, action: string, input: Record<string, unknown> = {}) => (await db.query('select public.game_action($1,$2,$3::jsonb) as result', [hash, action, JSON.stringify({ action, ...input })])).rows[0].result;
  try {
    await assert.rejects(call('f'.repeat(64), 'profile'), /unknown_device/);
    const p = await call('a'.repeat(64), 'profile', { nickname: 'Runner' });
    assert.equal(p.nickname, 'Runner'); assert.ok(!('nickname_normalized' in p));
    assert.equal((await call('a'.repeat(64), 'profile')).id, p.id);
    await assert.rejects(call('b'.repeat(64), 'profile', { nickname: 'runner' }), /nickname_taken/);
    const q = await call('b'.repeat(64), 'profile', { nickname: 'Second' });
    const visitReq = id(); const session = await call('a'.repeat(64), 'visit', { request_id: visitReq });
    assert.deepEqual(await call('a'.repeat(64), 'visit', { request_id: visitReq }), session);
    await db.query("update public.game_sessions set started_at=now()-interval '60 seconds' where id=$1", [session.session_id]);
    await call('a'.repeat(64), 'heartbeat', { request_id: id(), session_id: session.session_id, active_seconds: 20 });
    await call('a'.repeat(64), 'heartbeat', { request_id: id(), session_id: session.session_id, active_seconds: 20 });
    await call('a'.repeat(64), 'heartbeat', { request_id: id(), session_id: session.session_id, active_seconds: 10 });
    assert.equal((await db.query('select active_seconds from public.game_daily_activity where profile_id=$1', [p.id])).rows[0].active_seconds, 20);
    await assert.rejects(call('b'.repeat(64), 'run-start', { request_id: id(), session_id: session.session_id }), /invalid_session/);
    const startReq = id(); const run = await call('a'.repeat(64), 'run-start', { request_id: startReq, session_id: session.session_id });
    assert.deepEqual(await call('a'.repeat(64), 'run-start', { request_id: startReq, session_id: session.session_id }), run);
    await assert.rejects(call('a'.repeat(64), 'run-finish', { request_id: id(), run_id: run.run_id, distance: 50000, duration: 10, coins: 1 }), /implausible_run/);
    await db.query("update public.game_runs set started_at=now()-interval '20 seconds' where id=$1", [run.run_id]);
    const finish = { request_id: id(), run_id: run.run_id, distance: 100.8, duration: 10, coins: 8 };
    const result = await call('a'.repeat(64), 'run-finish', finish); assert.equal(result.score, 100);
    assert.deepEqual(await call('a'.repeat(64), 'run-finish', finish), result);
    assert.deepEqual(await call('a'.repeat(64), 'run-finish', { ...finish, request_id: id() }), result);
    await assert.rejects(call('a'.repeat(64), 'run-finish', { ...finish, request_id: id(), coins: 9 }), /idempotency_conflict/);
    assert.equal((await call('a'.repeat(64), 'profile')).earned_coins, 8);
    for (const metric of ['score', 'coins']) for (const period of ['day', 'week', 'all']) {
      const board = await call('a'.repeat(64), 'leaderboard', { metric, period, limit: 1 });
      assert.equal(board.entries.length, 1); assert.equal(board.personal.rank, 1); assert.equal(board.personal.record, metric === 'score' ? 100 : 8);
      const other = await call('b'.repeat(64), 'leaderboard', { metric, period }); assert.equal(other.personal.rank, null);
    }
    await db.exec(`insert into public.game_profiles(nickname,nickname_normalized,best_score,earned_coins) select 'Player'||n,'player'||n,200+n,100+n from generate_series(1,105) n;`);
    const board = await call('a'.repeat(64), 'leaderboard', { metric: 'score', period: 'all', limit: 100 });
    assert.equal(board.entries.length, 100); assert.equal(board.personal.rank, 106);
    assert.equal(Number((await db.query('select * from public.game_admin_daily')).rows[0].dau), 1);
    assert.equal(Number((await db.query('select * from public.game_admin_summary')).rows[0].earned_coins), 8);
    assert.ok((await db.query('select * from public.game_admin_retention')).rows.length);
    const tables = await db.query("select relname,relrowsecurity,relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','game_private') and c.relkind='r'");
    assert.ok(tables.rows.every((x: any) => x.relrowsecurity && x.relforcerowsecurity));
    const exposedDefiners = await db.query("select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'game_%' and p.prosecdef");
    assert.equal(exposedDefiners.rows.length, 0);
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      await assert.rejects(db.query('select * from public.game_profiles'), /permission denied/);
      await assert.rejects(db.query("select public.game_action('x','profile','{}')"), /permission denied/);
      await assert.rejects(db.query('select public.game_telegram_config()'), /permission denied/);
      await db.exec('reset role');
    }
    await db.exec('set role service_role');
    assert.deepEqual((await db.query('select public.game_telegram_config() as config')).rows[0].config, {});
    await db.query('select public.game_rate_limit($1,2,60)', ['test']);
    assert.equal((await db.query('select public.game_rate_limit($1,2,60) as allowed', ['test'])).rows[0].allowed, true);
    assert.equal((await db.query('select public.game_rate_limit($1,2,60) as allowed', ['test'])).rows[0].allowed, false);
    await db.exec('reset role');
    await db.exec("insert into game_private.rate_limits(key,window_at,hits) values('global:registrations',now(),120) on conflict(key) do update set hits=120,window_at=now()");
    assert.equal((await call('a'.repeat(64), 'profile')).id, p.id);
    await assert.rejects(call('c'.repeat(64), 'profile', { nickname: 'Blocked' }), /registration_rate_limited/);
    await db.exec('set role service_role');
    const claimed = (await db.query('select * from public.game_claim_outbox()')).rows;
    assert.ok(claimed.length > 0);
    assert.equal((await db.query('select * from public.game_claim_outbox()')).rows.length, 0);
    await db.query('select public.game_ack_outbox($1,$2,true)', [claimed[0].id, claimed[0].lease_id]);
    await db.query('select public.game_maintenance()');
    await db.exec('reset role');
    assert.notEqual(q.id, p.id);
  } finally { await db.close(); }
});

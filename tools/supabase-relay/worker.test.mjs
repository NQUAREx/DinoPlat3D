import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relay, allowedOrigin } from './worker.mjs';

const origin = 'https://nquarex.github.io';
const request = (path = '/functions/v1/game-api', options = {}) => new Request(`https://relay.example${path}`, {
  method: 'POST', headers: { origin, 'content-type': 'application/json', authorization: 'Bearer test-device', apikey: 'public-test-key' },
  body: '{"action":"profile"}', ...options,
});
test('exact origins, including localhost but no suffix tricks', () => {
  for (const value of [origin, 'http://localhost:5173', 'http://127.0.0.1:4173', 'http://[::1]:5173']) assert.equal(allowedOrigin(value), true);
  for (const value of [null, 'null', 'https://evil.example', 'https://nquarex.github.io.evil.example', 'http://localhost.evil.example', `${origin}/DinoPlat3d`, 'https://NQUAREx.github.io']) assert.equal(allowedOrigin(value), false);
});
test('fixed upstream, opaque credentials, CORS and no response cookie/cache leakage', async () => {
  let calls = 0;
  const response = await relay(request(), async (url, init) => {
    calls++;
    assert.equal(url, 'https://yusnxxdeumczuniwumvi.supabase.co/functions/v1/game-api');
    assert.equal(init.headers.get('authorization'), 'Bearer test-device');
    assert.equal(init.headers.get('apikey'), 'public-test-key');
    assert.equal(new TextDecoder().decode(init.body), '{"action":"profile"}');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.has('cookie'), false);
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'bad=1', 'access-control-allow-origin': '*' } });
  });
  assert.equal(calls, 1);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.has('set-cookie'), false);
  assert.equal(response.headers.has('access-control-allow-credentials'), false);
});
test('only password and refresh token grant queries are forwarded', async () => {
  for (const grant of ['password', 'refresh_token']) {
    const response = await relay(request(`/auth/v1/token?grant_type=${grant}`), async url => {
      assert.equal(url, `https://yusnxxdeumczuniwumvi.supabase.co/auth/v1/token?grant_type=${grant}`);
      return Response.json({ access_token: 'test-only' });
    });
    assert.equal(response.status, 200);
  }
});
test('logout forwards only to the fixed upstream with credentials and preserves empty 204', async () => {
  let calls = 0;
  const response = await relay(request('/auth/v1/logout', {
    body: '{}', headers: { origin, 'content-type': 'application/json', authorization: 'Bearer mock-admin-access', apikey: 'public-test-key' },
  }), async (url, init) => {
    calls++;
    assert.equal(url, 'https://yusnxxdeumczuniwumvi.supabase.co/auth/v1/logout');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.get('authorization'), 'Bearer mock-admin-access');
    assert.equal(init.headers.get('apikey'), 'public-test-key');
    assert.equal(new TextDecoder().decode(init.body), '{}');
    assert.equal(init.redirect, 'manual');
    return new Response(null, { status: 204 });
  });
  assert.equal(calls, 1);
  assert.equal(response.status, 204);
  assert.equal(await response.text(), '');
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
test('reject paths, query injection, methods, content type, oversized and missing-origin requests without fetch', async () => {
  const never = () => { throw Error('upstream must not be called'); };
  const cases = [
    [request('/rest/v1/profiles'), 404], [request('/auth/v1/user'), 404],
    [request('/auth/v1/logout/extra'), 404],
    [request('/auth/v1/logout?url=https://evil.example'), 400],
    [request('/auth/v1/logout?scope=global'), 400],
    [request('/auth/v1/logout', { method: 'GET', body: undefined }), 405],
    [request('/functions/v1/game-api/extra'), 404],
    [request('/functions/v1/game-api?url=https://evil.example'), 400],
    [request('/auth/v1/token?grant_type=password&grant_type=refresh_token'), 400],
    [request('/auth/v1/token?grant_type=client_credentials'), 400],
    [request('/auth/v1/token?grant_type=password&url=https://evil.example'), 400],
    [request('/functions/v1/game-api', { method: 'GET', body: undefined }), 405],
    [request('/functions/v1/game-api', { headers: { origin, 'content-type': 'text/plain' } }), 415],
    [request('/functions/v1/game-api', { body: 'x'.repeat(8193) }), 413],
    [request('/functions/v1/game-api', { headers: { 'content-type': 'application/json' } }), 403],
  ];
  for (const [input, expected] of cases) assert.equal((await relay(input, never)).status, expected);
});
test('preflight allows only POST and the credential header allowlist', async () => {
  for (const path of ['/functions/v1/game-api', '/auth/v1/token?grant_type=password', '/auth/v1/logout'])
    for (const [method, requested, status] of [['POST', 'authorization,apikey,content-type', 204], ['DELETE', '', 405], ['POST', 'cookie', 403]]) {
    const response = await relay(request(path, { method: 'OPTIONS', body: undefined, headers: {
      origin, 'access-control-request-method': method, 'access-control-request-headers': requested,
    } }));
    assert.equal(response.status, status);
  }
});
test('streamed bodies cannot evade the limit; exactly 8192 bytes and backend errors survive', async () => {
  const streamed = request('/functions/v1/game-api', {
    body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(4096)); c.enqueue(new Uint8Array(4097)); c.close(); } }), duplex: 'half',
  });
  let called = false;
  assert.equal((await relay(streamed, async () => { called = true; return Response.json({}); })).status, 413);
  assert.equal(called, false);
  const response = await relay(request('/functions/v1/game-api', { body: 'x'.repeat(8192) }), async () =>
    new Response('{"ok":false,"error":{"code":"unauthorized"}}', { status: 401, headers: { 'content-type': 'application/json' } }));
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'unauthorized');
});
test('redirects and upstream errors are bounded generic failures', async () => {
  assert.equal((await relay(request(), async () => new Response(null, { status: 302, headers: { location: 'https://evil.example' } }))).status, 502);
  const response = await relay(request(), async () => { throw Error('credential must not appear'); });
  assert.equal(response.status, 502);
  assert.equal(await response.text(), 'Upstream unavailable');
});
test('timeout covers a stalled upstream', { timeout: 12000 }, async () => {
  const response = await relay(request(), () => new Promise(() => {}));
  assert.equal(response.status, 504);
});

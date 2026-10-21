import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';

// node tests/online-browser.mjs [--webkit] — actual browser modules, strict API.md mock,
// no WebGL, external service, credentials or deployment required.
const useWebKit = process.argv.includes('--webkit');
const fixture = '/__online-test';
async function harness(run) {
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  let browser;
  try {
    browser = useWebKit
      ? await webkit.launch({ ...(process.env.WEBKIT_PATH ? { executablePath: process.env.WEBKIT_PATH } : {}) })
      : await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    page.setDefaultTimeout(2500);
    const html = (await readFile(new URL('../index.html', import.meta.url), 'utf8'))
      .replace(/<script\b[^>]*\bsrc="\/src\/main\.ts"[^>]*><\/script>/, '<link rel="stylesheet" href="/src/style.css">');
    await page.route(`**${fixture}`, route => route.fulfill({ contentType: 'text/html', body: html }));
    const profiles = new Map();
    const calls = []; const violations = []; const finishes = new Map();
    let offline = false; let denyAdmin = true;
    await page.route('**/functions/v1/game-api', async route => {
      if (offline) return route.abort('internetdisconnected');
      const req = route.request(); const body = req.postDataJSON();
      const auth = req.headers().authorization;
      const token = auth?.replace(/^Bearer /, '');
      calls.push({ body, auth });
      const send = data => route.fulfill({ json: { ok: true, data } });
      const fail = (status, code) => route.fulfill({ status, json: { ok: false, error: { code, message: code } } });
      const violation = message => { violations.push(message); return fail(400, message); };
      if (body.action === 'admin-summary') {
        if (token !== 'mock-admin-access' || denyAdmin) return fail(403, 'forbidden');
        return send({ summary: { players: 2, runs: 1 }, activity: [], retention: [] });
      }
      if (!/^[a-f0-9]{64}$/.test(token || '')) return violation('device Bearer header required');
      const profile = profiles.get(token);
      if (body.action === 'profile') {
        if (profile) return send(profile);
        if (!body.nickname) return fail(401, 'unknown_device');
        if (!/^[\p{L}\p{N}_-]{3,20}$/u.test(body.nickname)) return fail(400, 'invalid_nickname');
        if ([...profiles.values()].some(p => p.nickname.toLowerCase() === body.nickname.toLowerCase())) return fail(409, 'nickname_taken');
        const result = { id: crypto.randomUUID(), nickname: body.nickname, best_score: 0, earned_coins: 0, created_at: new Date().toISOString() };
        profiles.set(token, result); return send(result);
      }
      if (!profile) return fail(401, 'unknown_device');
      if (['visit', 'heartbeat', 'run-start', 'run-finish', 'profile-rename'].includes(body.action) && !/^[0-9a-f-]{36}$/i.test(body.request_id || '')) return violation('write request_id required');
      switch (body.action) {
        case 'visit': return send({ session_id: '00000000-0000-4000-8000-000000000001', started_at: new Date().toISOString(), active_seconds: 0 });
        case 'heartbeat': return send({ session_id: body.session_id, active_seconds: body.active_seconds });
        case 'run-start':
          if (!body.session_id) return violation('session_id required');
          return send({ run_id: '00000000-0000-4000-8000-000000000002', started_at: new Date().toISOString() });
        case 'run-finish': {
          if (!body.run_id || !Number.isFinite(body.distance) || !Number.isFinite(body.duration)) return violation('run-finish contract');
          const result = finishes.get(body.run_id) || { run_id: body.run_id, score: Math.floor(body.distance), earned_coins: body.coins, duration: body.duration, finished_at: new Date().toISOString() };
          finishes.set(body.run_id, result); return send(result);
        }
        case 'profile-rename': profile.nickname = body.nickname; return send(profile);
        case 'leaderboard': return send({ metric: body.metric, period: body.period, starts_at: null,
          personal: { record: body.metric === 'coins' ? 7 : 45, rank: 200 },
          entries: [{ rank: 1, profile_id: '00000000-0000-4000-8000-000000000099', nickname: '<img src=x onerror="window.injected=1">', value: body.metric === 'coins' ? 17 : 123 }] });
        default: return violation(`unsupported action: ${body.action}`);
      }
    });
    await page.route('**/auth/v1/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/auth/v1/logout') return route.fulfill({ status: 204, body: '' });
      if (url.pathname !== '/auth/v1/token') { violations.push(`unexpected auth path: ${url.pathname}`); return route.fulfill({ status: 404, json: {} }); }
      return route.fulfill({ json: { access_token: 'mock-admin-access', refresh_token: 'mock-refresh', expires_in: 3600 } });
    });
    const url = `${server.resolvedUrls.local[0].replace(/\/$/, '')}${fixture}`;
    async function load() {
      await page.goto(url);
      await page.evaluate(async () => {
        const { OnlineService } = await import('/src/online.ts');
        const { OnlineUI } = await import('/src/online-ui.ts');
        const { MobileBrowser } = await import('/src/mobile-browser.ts');
        window.mobileShell = new MobileBrowser(() => {}, () => {});
        window.service = new OnlineService({ publishableKey: 'mock-public-key', timeoutMs: 500 });
        window.onlineUI = new OnlineUI(window.service);
        await window.onlineUI.init();
      });
    }
    await load();
    try {
      await run({ page, load, profiles, calls, violations, finishes, offline: value => { offline = value; }, denyAdmin: value => { denyAdmin = value; } });
    } catch (error) {
      if (violations.length) error.message += `\nAPI contract violations: ${violations.join('; ')}`;
      throw error;
    }
    assert.deepEqual(violations, [], 'client requests must match supabase/API.md');
  } finally { await browser?.close(); await server.close(); }
}
async function register(page, nickname = 'Runner_123') {
  await page.locator('#nickname-input').fill(nickname);
  await page.locator('#nickname-save').tap();
  await page.waitForFunction(() => window.service.canPlay);
}

test('mandatory nickname: gate, native focus, validation and successful registration', { timeout: 20000 }, () => harness(async ({ page }) => {
  assert.equal(await page.evaluate(() => service.canPlay), false);
  assert.equal(await page.locator('#nickname-gate').isVisible(), true);
  assert.equal(await page.locator('#nickname-cancel').isVisible(), false);
  assert.equal(await page.locator('#nickname-input').getAttribute('data-native-input') !== null, true);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'nickname-input');
  // Actual touch activation and input selection must survive the global shell.
  await page.locator('#nickname-input').evaluate(input => input.blur());
  await page.locator('#nickname-input').tap();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'nickname-input');
  assert.equal(await page.evaluate(() => document.body.dataset.editing), 'true');
  await page.keyboard.insertText('Runner_123');
  const native = await page.locator('#nickname-input').evaluate(input => {
    input.setSelectionRange(0, 6);
    const pointer = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch' });
    input.dispatchEvent(pointer);
    const context = new Event('contextmenu', { bubbles: true, cancelable: true });
    input.dispatchEvent(context);
    return { value: input.value, start: input.selectionStart, end: input.selectionEnd,
      pointerPrevented: pointer.defaultPrevented, contextPrevented: context.defaultPrevented };
  });
  assert.deepEqual(native, { value: 'Runner_123', start: 0, end: 6, pointerPrevented: false, contextPrevented: false });
  assert.equal(await page.evaluate(() => document.getElementById('overlay').inert), true);
  const blocked = await page.evaluate(() => { try { service.startRun(); return false; } catch { return true; } });
  assert.equal(blocked, true);
  await page.locator('#nickname-input').fill('x');
  await page.locator('#nickname-save').tap();
  assert.equal(await page.evaluate(() => service.canPlay), false);
  await register(page);
  assert.equal(await page.locator('#nickname-gate').isVisible(), false);
}));

test('reload preserves device/profile; confirmed player can open offline', { timeout: 20000 }, () => harness(async ({ page, load, offline }) => {
  await register(page);
  const token = await page.evaluate(() => service.token);
  await load();
  assert.equal(await page.evaluate(() => service.token), token);
  assert.equal(await page.evaluate(() => service.profile.nickname), 'Runner_123');
  offline(true); await load();
  assert.equal(await page.evaluate(() => service.canPlay), true);
  assert.equal(await page.locator('#nickname-gate').isVisible(), false);
}));

test('duplicate nickname is rejected; duplicate finish does not credit twice', { timeout: 20000 }, () => harness(async ({ page, profiles, calls, finishes }) => {
  profiles.set('f'.repeat(64), { id: 'other', nickname: 'Taken_123' });
  await page.locator('#nickname-input').fill('Taken_123');
  await page.locator('#nickname-save').tap();
  await page.waitForFunction(() => document.getElementById('nickname-message').textContent.includes('nickname_taken'));
  assert.equal(await page.evaluate(() => service.canPlay), false);
  await register(page);
  await page.evaluate(async () => {
    service.startRun();
    await service.finishRun({ score: 123, coins: 17, durationMs: 12000 });
    await service.finishRun({ score: 123, coins: 17, durationMs: 12000 });
    await service.flushQueue();
  });
  assert.equal(finishes.size, 1);
  assert.equal(calls.filter(c => c.body.action === 'run-finish').length, 1);
}));

test('leaderboard: both metrics, three periods, personal rank outside list, safe text rendering', { timeout: 20000 }, () => harness(async ({ page, calls }) => {
  await register(page);
  await page.evaluate(async () => {
    // Exercise the UI without allocating the game renderer or menu controller.
    document.getElementById('leaderboard-panel').hidden = false;
    await onlineUI.refreshSection('leaderboard');
    for (const metric of ['score', 'coins']) for (const period of ['day', 'week', 'all']) {
      const result = await service.leaderboard(metric, period);
      if (result.personal.rank !== 200 || result.personal.record !== (metric === 'coins' ? 7 : 45))
        throw Error(`Personal result lost for ${metric}/${period}`);
      if (result.entries.some(entry => entry.playerId === service.profile.id)) throw Error('Personal player must be outside returned list');
    }
  });
  assert.equal(await page.locator('#leaderboard-rows tr').count(), 1);
  assert.equal(await page.locator('#leaderboard-rows img').count(), 0);
  assert.equal(await page.locator('#leaderboard-personal').textContent(), 'ВАШ РЕКОРД: 45 м · МЕСТО: 200');
  assert.equal(await page.locator('#leaderboard-rows .online-self').count(), 0);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  assert.equal(new Set(calls.filter(c => c.body.action === 'leaderboard').map(c => `${c.body.metric}/${c.body.period}`)).size, 6);
}));

test('admin: author unlock gives no data; server denial and memory-only session', { timeout: 20000 }, () => harness(async ({ page, calls, denyAdmin }) => {
  assert.equal(await page.locator('#admin-toggle').isVisible(), false);
  await page.evaluate(async () => {
    document.getElementById('developer-toggle').hidden = false;
    await new Promise(resolve => setTimeout(resolve, 0));
    await onlineUI.refreshSection('admin');
  });
  assert.equal(calls.some(c => c.body.action === 'admin-summary'), false);
  const denial = await page.evaluate(async () => {
    try { await service.adminLogin('admin@example.invalid', 'test-only-password'); return false; } catch { return !service.isAdminSignedIn; }
  });
  assert.equal(denial, true, 'valid Auth session still needs backend administrator authorization');
  denyAdmin(false);
  const result = await page.evaluate(async () => {
    const summary = await service.adminLogin('admin@example.invalid', 'test-only-password');
    const stored = Object.keys(localStorage).map(k => localStorage.getItem(k)).join(' ');
    return { players: summary.players, leaked: /mock-admin-access|mock-refresh|test-only-password/.test(stored) };
  });
  assert.deepEqual(result, { players: 2, leaked: false });
  await page.evaluate(() => { document.getElementById('developer-toggle').hidden = true; });
  await page.waitForFunction(() => !service.isAdminSignedIn);
}));

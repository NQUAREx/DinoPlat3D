import test from "node:test";
import assert from "node:assert/strict";
import { OnlineService, validateNickname } from "../src/online";

const profile = { id: "11111111-1111-4111-8111-111111111111", nickname: "DinoTest" };
function fixture() {
  const storage = new Map<string, string>();
  const calls: { body: Record<string, unknown>; headers: Headers }[] = [];
  let now = 0;
  let unavailable = false;
  const original = { window: globalThis.window, document: globalThis.document, storage: globalThis.localStorage, fetch: globalThis.fetch, performance: globalThis.performance };
  Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() });
  Object.defineProperty(globalThis, "document", { configurable: true, value: Object.assign(new EventTarget(), { hidden: false }) });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) } });
  Object.defineProperty(globalThis, "performance", { configurable: true, value: { now: () => now } });
  globalThis.fetch = async (_url, init) => {
    if (unavailable) throw new TypeError("Offline");
    const body = JSON.parse(String(init?.body));
    calls.push({ body, headers: new Headers(init?.headers) });
    const data = body.action === "profile" || body.action === "profile-rename" ? profile
      : body.action === "visit" ? { session_id: "22222222-2222-4222-8222-222222222222" }
      : body.action === "run-start" ? { run_id: "33333333-3333-4333-8333-333333333333" }
      : body.action === "leaderboard" ? { entries: [{ nickname: "Leader", rank: 1, value: 500 }], personal: { record: 120, rank: 200 } } : {};
    return Response.json({ ok: true, data });
  };
  return { storage, calls, advance: (ms: number) => { now += ms; }, offline: () => { unavailable = true; }, restore() {
    for (const [name, value] of Object.entries({ window: original.window, document: original.document, localStorage: original.storage, performance: original.performance })) Object.defineProperty(globalThis, name, { configurable: true, value });
    globalThis.fetch = original.fetch;
  } };
}

test("online: Unicode nickname validation rejects markup and invalid lengths", () => {
  assert.equal(validateNickname("  Дино_123  "), "Дино_123");
  assert.throws(() => validateNickname("<img>"));
  assert.throws(() => validateNickname("ab"));
  assert.throws(() => validateNickname("a".repeat(21)));
});
test("online: device restore, one visit per page, bearer never persisted in API body", async () => {
  const f = fixture(); let first: OnlineService | undefined, second: OnlineService | undefined;
  try {
    first = new OnlineService();
    assert.equal(first.canPlay, false);
    assert.throws(() => first!.startRun());
    await first.init(); await first.init();
    assert.equal(first.canPlay, true);
    assert.equal(f.calls.filter(c => c.body.action === "visit").length, 1);
    const token = first.token; first.dispose(); f.offline();
    second = new OnlineService(); await second.init();
    assert.equal(second.token, token); assert.deepEqual(second.profile, profile);
    for (const call of f.calls) {
      assert.equal(call.body.token, undefined);
      assert.equal(call.headers.get("Authorization"), `Bearer ${token}`);
    }
  } finally { first?.dispose(); second?.dispose(); f.restore(); }
});
test("online: paused time excluded, finish submits earned coins once, rank outside top list retained", async () => {
  const f = fixture(); const service = new OnlineService();
  try {
    await service.init(); service.startRun(); f.advance(1000); service.setRunning(false);
    f.advance(60000); assert.equal(service.activeSeconds, 1);
    service.setRunning(true); f.advance(2000);
    await service.finishRun({ score: 36, coins: 3, durationMs: 3000 });
    await service.finishRun({ score: 36, coins: 3, durationMs: 3000 });
    const finishes = f.calls.filter(c => c.body.action === "run-finish");
    assert.equal(finishes.length, 1); assert.equal(finishes[0].body.coins, 3);
    assert.equal(finishes[0].body.duration, 3);
    const board = await service.leaderboard("coins", "week");
    assert.equal(board.personal.rank, 200); assert.equal(board.personal.record, 120);
  } finally { service.dispose(); f.restore(); }
});
test("online: immediate restart cannot abandon the previous pending server finish", async () => {
  const f = fixture(); const service = new OnlineService();
  const transport = globalThis.fetch;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = async (url, init) => {
    if (JSON.parse(String(init?.body)).action === "run-finish") await gate;
    return transport(url, init);
  };
  try {
    await service.init(); service.startRun();
    await new Promise(resolve => setTimeout(resolve, 0));
    const finished = service.finishRun({ score: 12, coins: 1, durationMs: 1000 });
    service.startRun();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(f.calls.filter(c => c.body.action === "run-start").length, 1);
    release(); await finished;
    await new Promise(resolve => setTimeout(resolve, 0));
    const actions = f.calls.map(c => c.body.action);
    assert.equal(actions.filter(a => a === "run-start").length, 2);
    assert.ok(actions.indexOf("run-finish") < actions.lastIndexOf("run-start"));
  } finally { release(); service.dispose(); f.restore(); }
});

import { test } from "node:test";
import { BONUS_DEFINITIONS } from "../src/bonuses.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Simulation, STEP } from "../src/simulation.ts";
import { ObjectKind, ObjectRegistry, WorldSpawner } from "../src/world.ts";
import { Rules } from "../src/config.ts";
import { GameEvent, GameEvents } from "../src/events.ts";
import { Health } from "../src/progression.ts";
import { PickupMotion } from "../src/pickup-motion.ts";

function pickup(game: Simulation, kind: ObjectKind, x = game.x, y = 0.5) {
  const w = game.world;
  w.active.fill(0);
  w.active[0] = 1;
  w.kinds[0] = kind;
  w.x[0] = x;
  w.z[0] = game.z + 0.2;
  w.baseY[0] = y;
  w.halfX[0] = w.halfZ[0] = 0.46;
  w.height[0] = 0.75;
}

test("all pickups use one bounded periodic motion clock, freeze in pause and reset", () => {
  const a = new PickupMotion(),
    b = new PickupMotion();
  for (let i = 0; i < 500; i++) {
    const t = i * 0.037;
    a.update(t);
    b.update(t + PickupMotion.period * 100);
    assert.ok(Math.abs(a.bob - b.bob) < 1e-12);
    assert.ok(Math.abs(a.bob) <= 0.1);
    assert.ok(a.angle >= 0 && a.angle <= Math.PI * 2);
  }
  const game = new Simulation();
  game.phase = "running";
  game.step(STEP);
  const angle = game.pickupMotion.angle;
  game.phase = "paused";
  game.step(10);
  assert.equal(game.pickupMotion.angle, angle);
  game.reset(1);
  assert.equal(game.pickupMotion.angle, 0);
  assert.equal(game.previousTime, 0);
});

test("collect coin/diamond exactly once, including during damage immunity; restart retains balances", () => {
  const game = new Simulation(1);
  game.phase = "running";
  game.health.immunity = 2;
  for (const kind of [ObjectKind.Coin, ObjectKind.Diamond]) {
    pickup(game, kind);
    game.step(STEP);
    assert.equal(game.world.active[0], 0);
    for (let n = 0; n < 5; n++) game.step(STEP);
  }
  assert.equal(game.wallet.coins, 1);
  assert.equal(game.wallet.diamonds, 1);
  assert.equal(game.health.lives, 3);
  game.reset(2);
  assert.equal(game.wallet.coins + game.wallet.diamonds, 2);
});

test("hearts restore exactly one, never exceed three or revive dead; immunity is preserved", () => {
  const events = new GameEvents(),
    health = new Health(events);
  let healed = 0;
  events.on(GameEvent.Heal, () => healed++);
  assert.equal(health.heal(), false);
  health.damage();
  const immunity = health.immunity;
  assert.equal(health.heal(), true);
  assert.equal(health.lives, 3);
  assert.equal(health.immunity, immunity);
  assert.equal(healed, 1);
  health.lives = 0;
  assert.equal(health.heal(), false);
  assert.throws(() => health.heal(-1));
  const game = new Simulation();
  game.phase = "running";
  game.health.lives = 1;
  pickup(game, ObjectKind.Heart);
  game.step(STEP);
  assert.equal(game.health.lives, 2);
  assert.equal(game.world.active[0], 0);
  pickup(game, ObjectKind.Heart);
  game.step(STEP);
  assert.equal(game.health.lives, 3);
  pickup(game, ObjectKind.Heart);
  game.step(STEP);
  assert.equal(game.health.lives, 3);
  assert.equal(game.world.active[0], 0);
});

test("pickup requires real horizontal and vertical overlap; airborne player can miss low items", () => {
  const game = new Simulation();
  game.phase = "running";
  pickup(game, ObjectKind.Coin, game.x + 2);
  game.step(STEP);
  assert.equal(game.wallet.coins, 0);
  game.y = game.previousY = 3;
  pickup(game, ObjectKind.Coin);
  game.step(STEP);
  assert.equal(game.wallet.coins, 0);
  game.y = game.previousY = 0;
  game.velocityY = 0;
  pickup(game, ObjectKind.Coin);
  game.step(STEP);
  assert.equal(game.wallet.coins, 1);
  game.down();
  for (let i = 0; i < 12; i++) game.step(STEP);
  pickup(game, ObjectKind.Coin);
  game.step(STEP);
  assert.equal(game.wallet.coins, 2);
});

test("weighted pickup sampling is isolated from cactus density and matches 250:10:1", () => {
  const r = ObjectRegistry.defaults(),
    counts = new Uint32Array(256),
    samples = Math.round((261 + BONUS_DEFINITIONS.reduce((sum, bonus) => sum + bonus.weight, 0)) * 100);
  for (let n = 0; n < samples; n++) {
    assert.equal(r.pick((n + 0.5) / samples)?.kind, ObjectKind.Cactus);
    counts[r.pick((n + 0.5) / samples, true)!.kind]++;
  }
  assert.equal(counts[ObjectKind.Coin], 25000);
  assert.equal(counts[ObjectKind.Diamond], 1000);
  assert.equal(counts[ObjectKind.Heart], 100);
  for (const bonus of BONUS_DEFINITIONS)
    assert.equal(counts[ObjectKind.Jetpack + bonus.kind], Math.round(bonus.weight * 100));
});

test("swept pickup collision follows bob rather than a static height", () => {
  for (const [time, collected] of [
    [0.6, false],
    [1.8, true],
  ] as const) {
    const game = new Simulation();
    game.phase = "running";
    game.time = game.previousTime = time;
    game.pickupMotion.update(time);
    pickup(game, ObjectKind.Coin, game.x, 1.25);
    game.step(STEP);
    assert.equal(game.wallet.coins, collected ? 1 : 0);
  }
});

test("random pickup field is bounded, spans both axes, preserves original cactus field and avoids cacti", () => {
  const pool = new WorldSpawner(),
    cactusOnly = new ObjectRegistry();
  cactusOnly.register(ObjectRegistry.defaults().get(ObjectKind.Cactus)!);
  const original = new WorldSpawner(cactusOnly);
  pool.reset(1979);
  original.reset(1979);
  const counts = new Uint32Array(6);
  const buffer = pool.active;
  for (let n = 0; n < 80; n++) {
    const x = n % 2 ? n * 17.3 : -n * 17.3,
      z = n * 150;
    pool.update(x, z);
    original.update(x, z);
    for (let i = 0; i < pool.active.length; i++) {
      if (i % Rules.slotsPerChunk < Rules.candidatesPerChunk) {
        assert.equal(pool.active[i], original.active[i]);
        if (pool.active[i]) assert.equal(pool.kinds[i], ObjectKind.Cactus);
      }
      if (!pool.active[i] || pool.kinds[i] === ObjectKind.Cactus) continue;
      counts[pool.kinds[i]]++;
      assert.ok(Math.abs(pool.halfX[i] - 0.46) < 1e-6);
      assert.ok(Math.abs(pool.halfZ[i] - 0.46) < 1e-6);
      assert.notEqual(pool.x[i] % Rules.chunkSize, 0);
      assert.notEqual(pool.z[i] % Rules.chunkSize, 0);
      for (let j = 0; j < pool.active.length; j++) {
        if (!pool.active[j] || pool.kinds[j] !== ObjectKind.Cactus) continue;
        assert.ok(
          Math.abs(pool.x[i] - pool.x[j]) > pool.halfX[i] + pool.halfX[j] ||
            Math.abs(pool.z[i] - pool.z[j]) > pool.halfZ[i] + pool.halfZ[j],
        );
      }
    }
  }
  assert.ok(counts[ObjectKind.Coin] > counts[ObjectKind.Diamond] * 15);
  assert.ok(counts[ObjectKind.Diamond] > counts[ObjectKind.Heart] * 4);
  assert.ok(counts[ObjectKind.Heart] > 0);
  assert.equal(pool.active, buffer);
  assert.equal(buffer.length, Rules.poolSize);
});

test("authored pickup voxel sources are actual solid volumes with cubic cells and small palettes", async () => {
  for (const name of ["coin", "diamond", "heart"]) {
    const b = await readFile(
      new URL(`../art/collectibles/${name}.vox`, import.meta.url),
    );
    assert.equal(b.toString("ascii", 0, 4), "VOX ");
    const offset = b.indexOf(Buffer.from("XYZI")),
      count = b.readUInt32LE(offset + 12);
    const depths = new Set<number>();
    for (let i = 0; i < count; i++) depths.add(b[offset + 16 + i * 4 + 1]);
    assert.equal(depths.size, 5);
    assert.ok(count > 500 && count < 1000);
  }
});

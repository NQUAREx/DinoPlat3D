import { test } from "node:test";
import assert from "node:assert/strict";
import { BONUS_DEFINITIONS, BonusKind, BonusState, TURBO_MAX_SPEED, bonusKindForObject } from "../src/bonuses.ts";
import { GameEvent } from "../src/events.ts";
import { Surface } from "../src/landscape.ts";
import { Rules } from "../src/config.ts";
import { Simulation, STEP } from "../src/simulation.ts";
import { ObjectKind, ObjectRegistry, WorldSpawner } from "../src/world.ts";

function emptyGame() {
  const registry = ObjectRegistry.defaults();
  for (const kind of Object.values(ObjectKind))
    if (typeof kind === "number") registry.setWeight(kind, 0);
  const game = new Simulation(1979, registry);
  game.landscape.enabled = false;
  game.reset(1979);
  game.phase = "running";
  return game;
}

function place(game: Simulation, kind: ObjectKind, x: number, z: number, slot = 0, base?: number) {
  const world = game.world, bounds = world.registry.get(kind)!.colliders[0];
  world.active[slot] = 1;
  world.kinds[slot] = kind;
  world.motion[slot] = world.magnetized[slot] = 0;
  world.lean[slot] = 0;
  world.x[slot] = world.previousX[slot] = x;
  world.z[slot] = world.previousZ[slot] = z;
  world.baseY[slot] = world.previousBaseY[slot] = base ?? bounds.baseY ?? 0;
  world.halfX[slot] = bounds.halfX;
  world.halfZ[slot] = bounds.halfZ;
  world.height[slot] = bounds.height;
  return slot;
}

function tick(game: Simulation, seconds: number) {
  for (let i = 0; i < Math.round(seconds / STEP); i++) game.step(STEP);
}

test("bonus metadata, numeric object contract and rare weights match the agreed values", () => {
  assert.deepEqual(BONUS_DEFINITIONS.map((b) => b.duration), [6, 8, 10, 4, 5, 5, 3]);
  assert.deepEqual(BONUS_DEFINITIONS.map((b) => b.weight), [1.2, 1.5, 2, 0.6, 1, 0.6, 0.4]);
  const registry = ObjectRegistry.defaults();
  for (const definition of BONUS_DEFINITIONS) {
    const kind = ObjectKind.Jetpack + definition.kind;
    assert.equal(bonusKindForObject(kind), definition.kind);
    assert.equal(ObjectKind[kind], BonusKind[definition.kind]);
    assert.ok(definition.name && definition.icon);
    assert.equal(registry.get(kind)?.weight, definition.weight);
    assert.equal(registry.get(kind)?.spawnGroup, "pickup");
    assert.equal(registry.get(kind)?.animation, "spin-bob");
    assert.equal(registry.get(kind)?.blocking, false);
  }
  for (const invalid of [-1, 0, 11, 12.1, 19, Infinity, NaN])
    assert.equal(bonusKindForObject(invalid), undefined);
  const counts = new Uint32Array(19);
  for (let i = 0; i < 100_000; i++) counts[registry.pick((i + 0.5) / 100_000, true)!.kind]++;
  for (const definition of BONUS_DEFINITIONS)
    assert.ok(Math.abs(counts[12 + definition.kind] / counts[ObjectKind.Coin] - definition.weight / 250) < 0.00002);
});

test("independent timers refresh rather than stack, expire exactly and expose bounded visual strength", () => {
  const bonuses = new BonusState();
  assert.ok(bonuses.remaining instanceof Float64Array);
  for (const definition of BONUS_DEFINITIONS) bonuses.activate(definition.kind);
  bonuses.step(1);
  for (const definition of BONUS_DEFINITIONS)
    assert.equal(bonuses.remaining[definition.kind], definition.duration - 1);
  bonuses.activate(BonusKind.Shake);
  assert.equal(bonuses.remaining[BonusKind.Shake], 3);
  bonuses.remaining[BonusKind.Blindness] = 0.175;
  assert.equal(bonuses.strength(BonusKind.Blindness), 0.5);
  const before = bonuses.remaining.slice();
  for (const dt of [-1, NaN, Infinity]) bonuses.step(dt);
  assert.deepEqual(bonuses.remaining, before);
  for (let i = 0; i < 1200; i++) bonuses.step(STEP);
  for (const definition of BONUS_DEFINITIONS) {
    assert.equal(bonuses.active(definition.kind), false);
    assert.equal(bonuses.strength(definition.kind), 0);
  }
  bonuses.activate(BonusKind.Turbo);
  bonuses.reset();
  assert.ok(bonuses.remaining.every((value) => value === 0));
});

test("all seven physical pickups activate and refresh once with stable numeric collection events", () => {
  for (const definition of BONUS_DEFINITIONS) {
    const game = emptyGame(), kind = ObjectKind.Jetpack + definition.kind;
    const collected: number[][] = [], visuals: number[] = [];
    game.events.on(GameEvent.Collected, (value, amount) => collected.push([value, amount]));
    game.events.on(GameEvent.CollectedVisual, (slot) => {
      assert.equal(game.world.active[slot], 1, "visual consumer can read the live slot");
      visuals.push(slot);
    });
    place(game, kind, 0, 0.7);
    game.step(STEP);
    assert.equal(game.bonuses.remaining[definition.kind], definition.duration);
    assert.equal(game.world.active[0], 0);
    game.step(STEP);
    assert.deepEqual(collected, [[kind, 1]]);
    assert.deepEqual(visuals, [0]);
    place(game, kind, game.x, game.z + 0.3, 1, game.groundY + game.y + 0.5);
    game.step(STEP);
    assert.equal(game.bonuses.remaining[definition.kind], definition.duration);
    assert.deepEqual(collected, [[kind, 1], [kind, 1]]);
    assert.equal(game.wallet.coins, 0);
    assert.equal(game.wallet.diamonds, 0);
  }
});

test("pause, hit freeze and non-running phases stop timers and attraction; reset clears effects but not wallet", () => {
  const game = emptyGame();
  for (const definition of BONUS_DEFINITIONS) game.bonuses.activate(definition.kind);
  place(game, ObjectKind.Coin, 5, 0);
  const before = game.bonuses.remaining.slice(), coinX = game.world.x[0];
  for (const phase of ["paused", "ready", "over", "dying"] as const) {
    game.phase = phase;
    game.step(0.1);
    assert.deepEqual(game.bonuses.remaining, before);
    assert.equal(game.world.x[0], coinX);
  }
  game.phase = "running";
  game.hitStopRemaining = Rules.hitStopSeconds;
  tick(game, 1);
  assert.deepEqual(game.bonuses.remaining, before);
  assert.equal(game.world.x[0], coinX);
  game.step(STEP);
  assert.ok(game.bonuses.remaining[BonusKind.Magnet] < before[BonusKind.Magnet]);
  assert.ok(game.world.x[0] < coinX);
  game.wallet.coins = 10;
  game.reset(1979);
  assert.ok(game.bonuses.remaining.every((value) => value === 0));
  assert.ok(game.world.magnetized.every((value) => value === 0));
  assert.equal(game.wallet.coins, 10);
  assert.equal(game.y, 0);
});

test("jetpack tracks five metres above steep changing terrain and lands smoothly exactly once", () => {
  for (const grade of [-3, 0, 3]) {
    const game = emptyGame();
    game.landscape.heightAt = (_x, z) => grade * z + Math.sin(z / 4);
    game.bonuses.activate(BonusKind.Jetpack);
    let lands = 0;
    game.events.on(GameEvent.Land, () => lands++);
    for (let i = 0; i < 600; i++) {
      game.jump(); game.down();
      game.step(STEP);
      assert.ok(game.y > 0 && game.y <= 5);
      assert.equal(game.groundY, game.landscape.heightAt(game.x, game.z));
      assert.equal(game.falling, false);
      assert.equal(game.diving, false);
      assert.equal(game.health.lives, 3);
    }
    assert.ok(Math.abs(game.y - 5) < 1e-7);
    game.bonuses.remaining[BonusKind.Jetpack] = STEP;
    const height = game.y;
    game.step(STEP);
    assert.equal(game.bonuses.active(BonusKind.Jetpack), false);
    assert.ok(game.y < height && game.y > height - 0.01);
    let previous = game.y;
    while (game.y > 0) {
      game.step(STEP);
      assert.ok(game.y <= previous && previous - game.y <= 8 * STEP + 1e-8);
      previous = game.y;
    }
    tick(game, 0.1);
    assert.equal(lands, 1);
    assert.equal(game.velocityY, 0);
    assert.equal(game.health.lives, 3);
  }
});

test("jetpack protects pit/water/lava crossings only until flight and descent reach the surface", () => {
  for (const surface of [Surface.Pit, Surface.Water, Surface.Lava]) {
    const game = emptyGame();
    game.landscape.surfaceAt = () => surface;
    game.bonuses.activate(BonusKind.Jetpack);
    tick(game, 5.9);
    assert.equal(game.phase, "running");
    assert.equal(game.health.lives, 3);
    assert.ok(game.y > 4.99);
    tick(game, 2);
    assert.equal(game.health.lives, 0);
    assert.equal(game.fatalCause, surface);
  }
});

test("invisibility passes damaging objects, still collects coins and does not protect terrain hazards", () => {
  for (const kind of [ObjectKind.Cactus, ObjectKind.Bird, ObjectKind.Tumbleweed]) {
    const game = emptyGame();
    game.bonuses.activate(BonusKind.Invisibility);
    place(game, kind, 0, 0.7);
    if (kind === ObjectKind.Bird) game.world.motion[0] = 3;
    place(game, ObjectKind.Coin, 0, 0.7, 1);
    game.step(STEP);
    assert.equal(game.health.lives, 3);
    assert.equal(game.hitStopRemaining, 0);
    assert.equal(game.world.active[0], 1, "passing through must not destroy the obstacle");
    assert.equal(game.wallet.coins, 1);
    game.bonuses.remaining[BonusKind.Invisibility] = STEP;
    game.step(STEP);
    assert.equal(game.health.lives, 2);
    assert.equal(game.hitStopRemaining, Rules.hitStopSeconds);
  }
  for (const surface of [Surface.Pit, Surface.Water, Surface.Lava]) {
    const game = emptyGame();
    game.bonuses.activate(BonusKind.Invisibility);
    game.landscape.surfaceAt = () => surface;
    tick(game, 0.5);
    assert.equal(game.health.lives, 0);
    assert.equal(game.fatalCause, surface);
  }
});

test("turbo multiplies movement by 1.4 below the cap, never compounds and never exceeds the online budget", () => {
  const base = emptyGame(), turbo = emptyGame();
  turbo.bonuses.activate(BonusKind.Turbo);
  base.step(STEP); turbo.step(STEP);
  assert.ok(Math.abs(turbo.speed / base.speed - 1.4) < 1e-10);
  assert.ok(Math.abs(turbo.scoreDistance / base.scoreDistance - 1.4) < 1e-10);
  turbo.bonuses.activate(BonusKind.Turbo);
  turbo.step(STEP);
  assert.ok(turbo.speed < 17, "refresh cannot compound the multiplier");
  turbo.distance = 4000;
  turbo.runSpeed = 24;
  for (let i = 0; i < 720; i++) {
    const score = turbo.scoreDistance, distance = turbo.distance;
    turbo.step(STEP);
    const cap = turbo.bonuses.active(BonusKind.Turbo) ? TURBO_MAX_SPEED : Rules.maxSpeed;
    assert.equal(turbo.speed, cap, "turbo still accelerates a max-speed run");
    assert.ok(turbo.scoreDistance - score <= cap * STEP + 1e-9);
    assert.ok(turbo.distance - distance <= cap * STEP + 1e-9);
  }
  assert.equal(turbo.bonuses.active(BonusKind.Turbo), false);
  assert.ok(turbo.scoreDistance <= turbo.time * 26 + 5);
});

test("reverse transforms held input only in step, restores it on expiry and preserves score anti-circling", () => {
  const game = emptyGame();
  game.move(1);
  game.step(STEP);
  assert.ok(game.heading < 0);
  game.bonuses.activate(BonusKind.Reverse);
  const before = game.heading;
  game.step(STEP);
  assert.ok(game.heading > before);
  assert.equal(game.steering, 1);
  game.bonuses.activate(BonusKind.Turbo);
  tick(game, 3.1);
  assert.equal(game.scoreLocked, true);
  const score = game.scoreDistance;
  tick(game, 2);
  assert.equal(game.bonuses.active(BonusKind.Reverse), false);
  assert.equal(game.scoreDistance, score);
  const restored = game.heading;
  game.step(STEP);
  assert.ok(game.heading < restored);
  assert.equal(game.steering, 1);
  game.move(0);
  tick(game, 2.9);
  assert.equal(game.scoreDistance, score);
  tick(game, 0.2);
  assert.ok(game.scoreDistance > score);
});

test("magnet visibly pulls coins only, then awards wallet and collection events once on contact", () => {
  const game = emptyGame();
  const collected: number[][] = [], visuals: number[] = [], wallet: number[] = [];
  game.events.on(GameEvent.Collected, (kind, amount) => collected.push([kind, amount]));
  game.events.on(GameEvent.CollectedVisual, (slot) => visuals.push(slot));
  game.events.on(GameEvent.Pickup, (kind) => wallet.push(kind));
  game.bonuses.activate(BonusKind.Magnet);
  place(game, ObjectKind.Coin, 6, 0);
  for (const [i, kind] of [ObjectKind.Diamond, ObjectKind.Heart, ObjectKind.Turbo, ObjectKind.Cactus].entries())
    place(game, kind, 5, 0, i + 1);
  game.step(STEP);
  assert.equal(game.world.magnetized[0], 1);
  assert.equal(game.world.previousX[0], 6);
  assert.ok(game.world.x[0] < 6 && game.world.x[0] > 5);
  assert.equal(game.wallet.coins, 0, "entering the radius must not instantly award a coin");
  for (let i = 1; i <= 4; i++) {
    assert.equal(game.world.x[i], 5);
    assert.equal(game.world.magnetized[i], 0);
  }
  tick(game, 1);
  assert.equal(game.wallet.coins, 1);
  assert.equal(game.wallet.diamonds, 0);
  assert.equal(game.world.active[0], 0);
  assert.equal(game.world.magnetized[0], 0);
  assert.deepEqual(collected, [[ObjectKind.Coin, 1]]);
  assert.deepEqual(visuals, [0]);
  assert.equal(wallet.length, 1);
  game.world.update(game.x, game.z, 24);
  tick(game, 0.1);
  assert.equal(game.wallet.coins, 1);
});

test("magnet radius is a swept 3D sphere in either travel direction, including large/negative coordinates", () => {
  for (const heading of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const game = emptyGame();
    game.x = game.previousX = -1_000_000;
    game.z = game.previousZ = 1_000_000;
    game.world.update(game.x, game.z);
    game.heading = game.previousHeading = heading;
    game.runSpeed = 24; game.distance = 4000;
    const sx = -Math.sin(heading), sz = Math.cos(heading);
    // Both endpoints are >7m away, but the middle of the sweep enters range.
    place(game, ObjectKind.Coin, game.x + sx * 8 + sz * 6, game.z + sz * 8 - sx * 6);
    game.bonuses.activate(BonusKind.Magnet);
    game.step(2 / 3);
    assert.equal(game.wallet.coins, 1, `heading=${heading}`);
  }
  const game = emptyGame();
  place(game, ObjectKind.Coin, 7.01, 0);
  place(game, ObjectKind.Coin, 0, 0, 1, 9);
  place(game, ObjectKind.Coin, 6, 6, 2);
  game.bonuses.activate(BonusKind.Magnet);
  game.step(STEP);
  assert.equal(game.world.magnetized[0], 0);
  assert.equal(game.world.magnetized[1], 0);
  assert.equal(game.world.magnetized[2], 0, "radius is circular, not a square broad phase");
  assert.equal(game.wallet.coins, 0);
});

test("magnet attracts elevated coins during jetpack flight and stops movement on expiry", () => {
  const game = emptyGame();
  game.bonuses.activate(BonusKind.Jetpack);
  tick(game, 1);
  place(game, ObjectKind.Coin, game.x + 5, game.z, 0);
  game.bonuses.activate(BonusKind.Magnet);
  game.step(STEP);
  assert.ok(game.world.baseY[0] > 0.5);
  assert.equal(game.world.magnetized[0], 1);
  const x = game.world.x[0], y = game.world.baseY[0], z = game.world.z[0];
  game.bonuses.remaining[BonusKind.Magnet] = STEP;
  game.step(STEP);
  assert.equal(game.world.magnetized[0], 0);
  assert.equal(game.world.x[0], x);
  assert.equal(game.world.baseY[0], y);
  assert.equal(game.world.z[0], z);
});

test("bonus spawns stay rare, outside the start clearing, deterministic and consumed on resident revisits", () => {
  let bonuses = 0, pickups = 0;
  const kinds = new Set<BonusKind>();
  for (let seed = 1; seed <= 40; seed++) {
    const world = new WorldSpawner();
    world.reset(seed); world.update(0, 0);
    assert.equal(world.active.length, 2250);
    assert.equal(world.magnetized.length, 2250);
    for (let i = 0; i < world.active.length; i++) {
      if (!world.active[i]) continue;
      if (world.registry.get(world.kinds[i])?.spawnGroup === "pickup") pickups++;
      const kind = bonusKindForObject(world.kinds[i]);
      if (kind === undefined) continue;
      bonuses++; kinds.add(kind);
      assert.ok(Math.hypot(world.x[i], world.z[i]) >= 48);
      const x = world.x[i], z = world.z[i];
      world.magnetized[i] = 1;
      world.consume(i);
      world.update(1, 1, 24);
      world.update(0, 0, 12);
      assert.equal(world.active[i], 0);
      assert.equal(world.magnetized[i], 0);
      assert.equal(world.x[i], x);
      assert.equal(world.z[i], z);
    }
  }
  assert.equal(kinds.size, 7);
  assert.ok(bonuses / pickups > 0.01 && bonuses / pickups < 0.04, `${bonuses}/${pickups}`);
  const a = new WorldSpawner(), b = new WorldSpawner();
  a.reset(123); b.reset(123);
  a.update(-300, 500); b.update(-300, 500);
  assert.deepEqual(a.kinds, b.kinds);
  assert.deepEqual(a.active, b.active);
  const snapshot = a.active.slice();
  a.update(1000, 1000); a.update(-300, 500);
  assert.deepEqual(a.active, snapshot);
  assert.ok(a.magnetized.every((value) => value === 0));
});

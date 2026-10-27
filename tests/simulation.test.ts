import { test } from "node:test";
import assert from "node:assert/strict";
import { Simulation, STEP } from "../src/simulation.ts";
import { Rules } from "../src/config.ts";
import { ObjectRegistry, ObjectKind, WorldSpawner } from "../src/world.ts";
import { GameEvent, GameEvents } from "../src/events.ts";
import { Currency, Wallet } from "../src/progression.ts";
import { Surface } from "../src/landscape.ts";

function emptyGame(distance = 0, x = 0) {
  const registry = new ObjectRegistry();
  registry.register({
    kind: ObjectKind.Cactus,
    weight: 0,
    blocking: true,
    colliders: [{ halfX: 0.45, halfZ: 0.4, height: 1.5 }],
  });
  const game = new Simulation(123, registry);
  game.landscape.enabled = false;
  game.phase = "running";
  game.z = game.previousZ = game.distance = game.previousDistance = distance;
  game.x = game.previousX = x;
  game.world.update(x, distance);
  return game;
}
function obstacle(game: Simulation, x: number, forward: number, height = 1.5) {
  const w = game.world;
  w.active[0] = 1;
  w.kinds[0] = ObjectKind.Cactus;
  w.x[0] = x;
  w.z[0] = game.z + forward;
  w.halfX[0] = 0.45;
  w.halfZ[0] = 0.4;
  w.height[0] = height;
}

function routeContext(game: Simulation, seed: number, step: number) {
  const world = game.world;
  const blockers = [];
  for (let i = 0; i < world.active.length; i++) {
    if (!world.active[i] || !world.registry.get(world.kinds[i])?.blocking) continue;
    if (world.kinds[i] === ObjectKind.Bird && world.motion[i] !== 3) continue;
    const x = world.collisionX(i), z = world.collisionZ(i);
    const distance = Math.hypot(x - game.x, z - game.z);
    if (distance > 20) continue;
    blockers.push({
      slot: i, type: ObjectKind[world.kinds[i]], variant: world.variants[i],
      motion: world.motion[i], x, z, distance,
      halfX: world.halfX[i], halfZ: world.halfZ[i],
      baseY: world.baseY[i], height: world.height[i],
    });
  }
  blockers.sort((a, b) => a.distance - b.distance);
  return JSON.stringify({
    seed, step, elapsed: step * STEP, phase: game.phase,
    player: {
      x: game.x, z: game.z, y: game.y, groundY: game.groundY,
      previousX: game.previousX, previousZ: game.previousZ,
      previousY: game.previousY, previousGroundY: game.previousGroundY,
      heading: game.heading, speed: game.speed, crouch: game.crouch,
      velocityY: game.velocityY, lives: game.health.lives, immunity: game.health.immunity,
    },
    surface: Surface[game.landscape.surfaceAt(game.x, game.z)],
    fatalCause: Surface[game.fatalCause], falling: game.falling,
    routeX: world.safeCenter(game.z), blockers: blockers.slice(0, 5),
  });
}

test("continuous turns cover every heading; release preserves direction and running never stops", () => {
  const game = emptyGame();
  game.move(1);
  for (let i = 0; i < 560; i++) game.step(STEP);
  assert.ok(game.heading < -Math.PI * 2);
  assert.ok(game.distance > 50);
  const released = game.heading,
    x = game.x,
    z = game.z;
  game.move(0);
  for (let i = 0; i < 20; i++) game.step(STEP);
  assert.equal(game.heading, released);
  assert.ok(Math.hypot(game.x - x, game.z - z) > 1);
});
test("path distance counts actual travel independently of world position in all directions", () => {
  const game = emptyGame();
  let travelled = 0;
  for (let i = 0; i < 1500; i++) {
    const x = game.x,
      z = game.z;
    game.move(i < 800 ? 1 : -1);
    game.step(STEP);
    travelled += Math.hypot(game.x - x, game.z - z);
  }
  assert.ok(Math.abs(game.distance - travelled) < 1e-9);
  assert.ok(game.distance > Math.hypot(game.x, game.z) * 2);
});
test("score pauses after a 3s held turn and resumes 3s after release", () => {
  const game = emptyGame();
  game.move(1);
  const tick = (seconds: number) => {
    for (let i = 0; i < Math.round(seconds / STEP); i++) game.step(STEP);
  };
  tick(2);
  assert.ok(game.scoreDistance > 20);
  game.move(-1); // Changing sides without lifting still counts as one continuous hold.
  tick(1.1);
  const lockedScore = game.scoreDistance;
  assert.ok(game.scoreLocked);
  tick(0.5);
  assert.equal(game.scoreDistance, lockedScore);
  game.move(0);
  tick(2.9);
  assert.equal(game.scoreDistance, lockedScore);
  game.move(0); // Duplicate release/clear events must not strand or restart recovery.
  tick(0.2);
  assert.ok(game.scoreDistance > lockedScore);
  assert.ok(game.distance - game.scoreDistance > 30, "world travel continues while score accrual is suppressed");
  game.move(1);
  tick(3.1);
  assert.ok(game.scoreLocked, "a later long hold can trigger the guard again");
  const secondLockScore = game.scoreDistance;
  game.move(0);
  tick(3.1);
  assert.ok(game.scoreDistance > secondLockScore, "score recovers after every release");
});
test("short turns do not trigger the anti-circling score pause", () => {
  const game = emptyGame();
  game.move(-1);
  for (let i = 0; i < 2 * 120; i++) game.step(STEP);
  game.move(0);
  for (let i = 0; i < 120; i++) game.step(STEP);
  assert.equal(game.scoreLocked, false);
  assert.ok(Math.abs(game.scoreDistance - game.distance) < 1e-8);
});
test("2D cell pool is bounded, deterministic after reentry, and generates both axes", () => {
  const pool = new WorldSpawner();
  pool.reset(1979);
  pool.update(0, 100);
  const arrays = [pool.x, pool.z, pool.active];
  const snapshot = Array.from(pool.active, (active, i) => [
    active,
    pool.x[i],
    pool.z[i],
    pool.variants[i],
    pool.angles[i],
  ]);
  pool.update(1000, 100);
  pool.update(0, 100);
  for (let i = 0; i < pool.active.length; i++)
    if (snapshot[i][0])
      assert.deepEqual(
        [
          pool.active[i],
          pool.x[i],
          pool.z[i],
          pool.variants[i],
          pool.angles[i],
        ],
        snapshot[i],
      );
  let left = false,
    right = false,
    variants = 0;
  for (let i = 0; i < 2000; i++) {
    const x = (i % 2 ? -1 : 1) * i * 31.37;
    pool.update(x, i * 20);
    for (let slot = 0; slot < pool.active.length; slot++)
      if (pool.active[slot]) {
        assert.ok(
          Math.abs(pool.x[slot] - x) < (pool.radius + 1) * Rules.chunkSize,
        );
        left ||= pool.x[slot] < x;
        right ||= pool.x[slot] > x;
        variants |= 1 << pool.variants[slot];
        if (pool.registry.get(pool.kinds[slot])!.blocking)
          assert.equal(
            pool.isRouteClear(
              pool.x[slot],
              pool.z[slot],
              pool.halfX[slot],
              pool.halfZ[slot],
            ),
            false,
          );
        assert.notEqual(pool.x[slot] % Rules.chunkSize, 0);
        assert.notEqual(pool.z[slot] % Rules.chunkSize, 0);
      }
  }
  assert.equal(left && right, true);
  assert.equal(variants, 127);
  assert.equal(pool.x, arrays[0]);
  assert.equal(pool.z, arrays[1]);
  assert.equal(pool.active, arrays[2]);
  assert.equal(pool.active.length, Rules.poolSize);
});
test("continuous safe routes have bounded slope across unbounded X", () => {
  const pool = new WorldSpawner();
  for (let seed = 1; seed <= 100; seed++) {
    pool.reset(seed);
    for (let row = 1; row < 1000; row++) {
      assert.ok(
        Math.abs(pool.safeCenter(row) - pool.safeCenter(row - 1)) <= 0.081,
      );
      for (const corridor of [-1000, 0, 1000])
        assert.equal(
          pool.isRouteClear(pool.safeCenter(row, corridor), row, 1, 1),
          true,
        );
    }
  }
});
test("100 seeds: unassisted safe route survives 5 minutes at max speed with 300ms reaction and all 3 lives", () => {
  for (let seed = 1; seed <= 100; seed++) {
    // Validate terrain/obstacle reachability without optional effects changing
    // the pilot's steering or masking hits through flight/invisibility.
    const registry = ObjectRegistry.defaults();
    for (let kind = ObjectKind.Jetpack; kind <= ObjectKind.Shake; kind++) registry.setWeight(kind, 0);
    const game = new Simulation(seed, registry);
    let hits = 0, step = 0, firstHit = "";
    game.events.on(GameEvent.Hit, () => {
      hits++;
      // Hit is emitted before the swept contact pose is clamped. Preserve the
      // whole attempted step so a generator failure can be reproduced exactly.
      firstHit ||= routeContext(game, seed, step);
    });
    game.phase = "running";
    game.distance = game.previousDistance = 4000;
    game.z = game.previousZ = 2000;
    game.x = game.previousX = game.world.safeCenter(game.z);
    game.groundY = game.previousGroundY = game.landscape.heightAt(game.x, game.z);
    game.speed = game.runSpeed = Rules.maxSpeed;
    game.world.update(game.x, game.z, game.runSpeed);
    assert.equal(game.landscape.enabled, true, "route challenge uses terrain, hazards and dynamics");
    for (let n = 0; n < 300 / STEP; n++) {
      step = n;
      // Perceive dynamic hazards at 15 Hz; steering and physics remain 120 Hz.
      let birdNear = false;
      if (n % 8 === 0) for (let i = 0; i < game.world.active.length; i++) {
        if (!game.world.active[i] || (game.world.motion[i] !== 3 && game.world.motion[i] !== 4)) continue;
        const distanceSq = (game.world.x[i] - game.x) ** 2 + (game.world.z[i] - game.z) ** 2;
        const forward = -(game.world.x[i] - game.x) * Math.sin(game.heading) +
          (game.world.z[i] - game.z) * Math.cos(game.heading);
        if (game.world.kinds[i] === ObjectKind.Bird && distanceSq < 20 ** 2 && forward > -0.5) birdNear = true;
      }
      if (n % 8 === 0) {
        if (birdNear) game.down();
        else for (let i = 0; i < game.world.active.length; i++) {
          const w = game.world;
          if (!w.active[i] || w.kinds[i] !== ObjectKind.Tumbleweed || w.motion[i] !== 3) continue;
          const dx = w.x[i] - game.x, dz = w.z[i] - game.z,
            vx = (w.x[i] - w.previousX[i]) / STEP + Math.sin(game.heading) * game.speed,
            vz = (w.z[i] - w.previousZ[i]) / STEP - Math.cos(game.heading) * game.speed,
            time = -(dx * vx + dz * vz) / (vx * vx + vz * vz);
          if (time >= 0 && time < 0.4 && Math.hypot(dx + vx * time, dz + vz * time) < 1) game.jump();
        }
      }
      const delayedZ = game.z - 0.3 * Rules.maxSpeed;
      const slope =
        (game.world.safeCenter(delayedZ + 0.1) -
          game.world.safeCenter(delayedZ - 0.1)) /
        0.2;
      const desired = -Math.atan(
        slope + (game.world.safeCenter(delayedZ) - game.x) * 0.2,
      );
      const error = desired - game.heading;
      game.move(
        Math.abs(error) > Rules.turnSpeed * STEP * 0.5 ? -Math.sign(error) : 0,
      );
      game.step(STEP);
      assert.equal(game.health.lives, 3, firstHit || (game.health.lives !== 3 ? routeContext(game, seed, n) : `seed ${seed}, step ${n}`));
    }
    assert.equal(
      hits,
      0,
      `hearts must not mask route collisions for seed ${seed}`,
    );
  }
});
test("swept cactus collision works at arbitrary positive and negative world coordinates", () => {
  for (const x of [-5000.25, 0.35, 7340.7]) {
    const game = emptyGame(2000, x);
    obstacle(game, x, 2);
    game.step(0.2);
    assert.equal(game.health.lives, 2);
  }
});
test("swept lateral collision does not tunnel through a cactus", () => {
  const game = emptyGame(0, -2);
  game.heading = game.previousHeading = -Math.PI / 2;
  obstacle(game, 0, 0);
  game.step(0.5);
  assert.equal(game.health.lives, 2);
});
test("jump clears tall cactus, double jump is rejected, landing emits exactly once", () => {
  for (const distance of [0, 2000]) {
    const game = emptyGame(distance);
    if (distance) { game.distance = 4000; game.speed = game.runSpeed = Rules.maxSpeed; }
    obstacle(game, 0, distance ? 14 : 7, 3.1);
    let landed = 0;
    game.events.on(GameEvent.Land, () => landed++);
    game.jump();
    game.step(STEP);
    const velocity = game.velocityY;
    game.jump();
    assert.equal(game.velocityY, velocity);
    for (let i = 0; i < 180; i++) game.step(STEP);
    assert.equal(game.health.lives, 3);
    assert.equal(game.y, 0);
    assert.equal(landed, 1);
  }
});
test("down swipe dives with swept descent, lands once and does not teleport", () => {
  const game = emptyGame();
  let landings = 0;
  game.events.on(GameEvent.Land, () => landings++);
  game.jump();
  for (let i = 0; i < 30; i++) game.step(STEP);
  const height = game.y;
  assert.ok(height > 2);
  game.down();
  assert.equal(game.diving, true);
  assert.ok(game.velocityY <= -22);
  game.step(STEP);
  assert.ok(game.y > 0 && game.y < height);
  for (let i = 0; i < 30; i++) game.step(STEP);
  assert.equal(game.y, 0);
  assert.equal(game.diving, false);
  assert.equal(landings, 1);
  game.jump();
  game.down();
  game.step(STEP);
  assert.equal(game.y, 0);
  assert.equal(game.diving, false);
  assert.equal(landings, 2);
});
test("ground down swipe ducks for a bounded duration, with a real shorter collision body", () => {
  for (const duck of [false, true]) {
    const game = emptyGame();
    obstacle(game, 0, 4, 1);
    game.world.baseY[0] = 0.9;
    if (duck) game.down();
    for (let i = 0; i < 50; i++) game.step(STEP);
    assert.equal(game.health.lives, duck ? 3 : 2);
    if (duck) {
      assert.equal(game.crouch, 1);
      assert.equal(game.bodyHeight, Rules.duckBodyHeight);
      game.phase = "paused";
      const remaining = game.crouchRemaining;
      game.step(10);
      assert.equal(game.crouchRemaining, remaining);
      game.phase = "running";
      game.world.active.fill(0);
      for (let i = 0; i < 100; i++) game.step(STEP);
      assert.equal(game.crouch, 0);
      assert.equal(game.bodyHeight, Rules.playerBodyHeight);
      game.down();
      game.jump();
      assert.equal(game.crouchRemaining, 0);
      game.reset(123);
      assert.equal(game.crouch, 0);
      assert.equal(game.diving, false);
    }
  }
});
test("lives, damage immunity, game over, pause and reset retain bounded pools", () => {
  const game = emptyGame(),
    pool = game.world.active;
  for (let hit = 0; hit < 3; hit++) {
    game.health.immunity = 0;
    obstacle(game, game.x, 0.3);
    game.step(STEP);
    assert.equal(game.health.lives, 2 - hit);
    for (let i = 0; i < 120; i++) game.step(STEP);
    if (hit < 2) {
      game.step(STEP);
      assert.equal(game.health.lives, 2 - hit);
    }
  }
  assert.equal(game.phase, "dying");
  const stoppedDistance=game.distance;
  for(let i=0;i<150;i++)game.step(STEP);
  assert.equal(game.phase,"over");
  assert.equal(game.distance,stoppedDistance);
  game.reset(999);
  assert.equal(game.world.active, pool);
  assert.equal(game.health.lives, 3);
  assert.equal(game.distance, 0);
  assert.equal(game.steering, 0);
  game.phase = "paused";
  game.step(1);
  assert.equal(game.distance, 0);
});
test("hit gives exactly two seconds of immunity and temporary start speed, then recovers gradually", () => {
  const game = emptyGame(2000);
  obstacle(game, game.x, 0.3);
  game.step(STEP);
  assert.equal(game.health.lives, 2);
  assert.equal(game.health.immunity, 2);
  assert.equal(game.speed, Rules.startSpeed);
  const frozen = [
    game.x,
    game.y,
    game.distance,
    game.time,
    game.health.immunity,
  ];
  for (let i = 0; i < 120; i++) {
    game.move(1);
    game.jump();
    game.down();
    game.step(STEP);
    assert.deepEqual(
      [game.x, game.y, game.distance, game.time, game.health.immunity],
      frozen,
    );
  }
  assert.equal(game.hitStopRemaining, 0);
  assert.ok(game.feedbackTime > 1);
  for (let i = 0; i < 239; i++) {
    obstacle(game, game.x, 0.3);
    game.step(STEP);
    assert.equal(game.health.lives, 2);
    assert.equal(game.speed, Rules.startSpeed);
  }
  game.world.active.fill(0);
  game.step(STEP);
  assert.equal(game.health.immunity, 0);
  assert.ok(game.speed > Rules.startSpeed && game.speed < Rules.startSpeed + 0.1);
  obstacle(game, game.x, 0.3);
  game.step(STEP);
  assert.equal(game.health.lives, 1);
});
test("wallet/registry remain extensible; only requested pickups are enabled", () => {
  const events = new GameEvents(),
    wallet = new Wallet(events);
  wallet.add(Currency.Coin, 4);
  wallet.add(Currency.Diamond, 2);
  assert.equal(wallet.coins, 4);
  assert.equal(wallet.diamonds, 2);
  assert.throws(() => wallet.add(Currency.Coin, -1));
  const registry = ObjectRegistry.defaults();
  assert.equal(registry.get(ObjectKind.Enemy)?.weight, 0);
  assert.equal(registry.get(ObjectKind.Coin)?.weight, 250);
  assert.equal(registry.get(ObjectKind.Diamond)?.weight, 10);
  assert.equal(registry.get(ObjectKind.Heart)?.weight, 1);
  assert.equal(registry.get(ObjectKind.Cactus)?.destruction, undefined);
});
test("registered pickups flow through the same pool and speed stays within route budget", () => {
  const game = emptyGame(2000);
  game.world.registry.register({
    kind: ObjectKind.Coin,
    weight: 0,
    blocking: false,
    colliders: [{ halfX: 0.25, halfZ: 0.25, height: 0.6 }],
    reward: 3,
  });
  obstacle(game, game.x, 0.3, 0.6);
  game.world.kinds[0] = ObjectKind.Coin;
  game.step(STEP);
  assert.equal(game.wallet.coins, 3);
  assert.equal(game.world.active[0], 0);
  game.step(STEP);
  assert.equal(game.wallet.coins, 3);
  game.distance = 1_000_000;
  game.step(STEP);
  assert.ok(game.speed > Rules.startSpeed && game.speed < Rules.maxSpeed);
  game.jump();
  assert.equal(game.velocityY, Rules.jumpSpeed);
});

test("floating item collider has a real vertical range for future pickups/enemies", () => {
  const game = emptyGame();
  game.world.registry.register({
    kind: ObjectKind.Coin,
    weight: 0,
    blocking: false,
    colliders: [{ halfX: 0.25, halfZ: 0.25, height: 0.5, baseY: 1.5 }],
    reward: 1,
  });
  obstacle(game, 0, 0.3, 0.5);
  game.world.kinds[0] = ObjectKind.Coin;
  game.world.baseY[0] = 1.5;
  game.step(STEP);
  assert.equal(game.wallet.coins, 0);
  game.y = game.previousY = 0.5;
  game.step(STEP);
  assert.equal(game.wallet.coins, 1);
});

test("fixed steps preserve motion at 15/30/60/120Hz", () => {
  const results: number[] = [];
  for (const hz of [15, 30, 60, 120]) {
    const game = emptyGame();
    game.move(1);
    let accumulator = 0;
    for (let frame = 0; frame < hz * 2; frame++) {
      accumulator += 1 / hz;
      while (accumulator + 1e-12 >= STEP) {
        game.step(STEP);
        accumulator -= STEP;
      }
    }
    results.push(game.distance);
    assert.ok(Math.abs(game.heading + Rules.turnSpeed * 2) < 1e-10 && game.x > 12);
  }
  assert.ok(results.every((value) => Math.abs(value - results[0]) < 1e-10));
});

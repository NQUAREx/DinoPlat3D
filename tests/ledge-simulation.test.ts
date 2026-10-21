import test from "node:test";
import assert from "node:assert/strict";
import { Simulation, STEP } from "../src/simulation.ts";
import { Rules } from "../src/config.ts";
import { GameEvent } from "../src/events.ts";
import { Surface } from "../src/landscape.ts";
import { ObjectKind, ObjectRegistry } from "../src/world.ts";

const directions = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
function isolated(x: number, z: number, heading: number) {
  const registry = new ObjectRegistry();
  registry.register({ kind: ObjectKind.Cactus, weight: 0, blocking: true,
    colliders: [{ halfX: 0.45, halfZ: 0.4, height: 1.5 }] });
  const game = new Simulation(1, registry);
  game.phase = "running";
  game.x = game.previousX = x; game.z = game.previousZ = z;
  game.heading = game.previousHeading = heading;
  game.world.update(x, z); game.world.active.fill(0);
  return game;
}

test("supported rises and descents are traversable in four headings and at signed world origins", () => {
  for (const [ox, oz] of [[0, 0], [-173, -291], [1_000_000, -1_000_000], [-1_000_000, 1_000_000]]) for (const heading of directions) {
    const game = isolated(ox, oz, heading), dx = -Math.sin(heading), dz = Math.cos(heading);
    const along = (x: number, z: number) => (x - ox) * dx + (z - oz) * dz;
    game.landscape.heightAt = (x, z) => 7 + 1.5 * Math.sin(along(x, z) / 2);
    game.landscape.surfaceAt = () => Surface.Land;
    game.groundY = game.previousGroundY = 7;
    let hits = 0, minimum = Infinity, maximum = -Infinity;
    game.events.on(GameEvent.Hit, () => hits++);
    for (let i = 0; i < 180; i++) {
      game.step(STEP);
      assert.equal(game.groundY, game.landscape.heightAt(game.x, game.z));
      assert.equal(game.y, 0); assert.equal(game.falling, false);
      assert.equal(game.health.immunity, 0); assert.equal(game.hitStopRemaining, 0);
      minimum = Math.min(minimum, game.groundY); maximum = Math.max(maximum, game.groundY);
    }
    assert.ok(along(game.x, game.z) > 12);
    assert.ok(minimum < 5.6 && maximum > 8.4);
    assert.equal(game.health.lives, 3); assert.equal(hits, 0);
  }
});

test("fallen obstacles are harmless while upright and partially falling obstacles damage", () => {
  for (const [motion, lean, damaging] of [[0, 0, true], [1, 0.3, true], [2, 0, false], [1, Math.PI / 2, false]] as const) {
    for (const heading of directions) {
      const game = isolated(-173, -291, heading), pool = game.world;
      game.landscape.enabled = false;
      const dx = -Math.sin(heading), dz = Math.cos(heading);
      pool.active[0] = 1; pool.kinds[0] = ObjectKind.Cactus;
      pool.x[0] = game.x + dx * 1.5; pool.z[0] = game.z + dz * 1.5;
      pool.previousX[0] = pool.x[0]; pool.previousZ[0] = pool.z[0];
      pool.halfX[0] = 0.45; pool.halfZ[0] = 0.4; pool.height[0] = 1.5;
      pool.baseY[0] = pool.previousBaseY[0] = 0;
      (pool as unknown as { originalHeight: Float32Array }).originalHeight[0] = 0; // Same collider centre for every damage-state fixture.
      pool.motion[0] = motion; pool.lean[0] = lean;
      let hits = 0;
      game.events.on(GameEvent.Hit, () => hits++);
      for (let i = 0; i < 30 && !game.hitStopRemaining; i++) game.step(STEP);
      assert.equal(hits, damaging ? 1 : 0, `motion ${motion}, lean ${lean}, heading ${heading}`);
      assert.equal(game.health.lives, damaging ? 2 : 3);
      assert.equal(game.hitStopRemaining, damaging ? Rules.hitStopSeconds : 0);
      assert.equal(game.health.immunity, damaging ? Rules.immunitySeconds : 0);
      if (!damaging) assert.ok((game.x + 173) * dx + (game.z + 291) * dz > 2.5);
    }
  }
});

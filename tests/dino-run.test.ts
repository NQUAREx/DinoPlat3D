import { test } from "node:test";
import assert from "node:assert/strict";
import { Simulation, STEP } from "../src/simulation.ts";
import { ObjectRegistry, ObjectKind, WorldSpawner } from "../src/world.ts";
import { Rules } from "../src/config.ts";
import { CameraRig, ObjectVisibility } from "../src/camera.ts";
import { FootDust } from "../src/character.ts";
import { GameEvent } from "../src/events.ts";
import { GameSettings } from "../src/settings.ts";
import { GestureRecognizer } from "../src/gesture.ts";

test("shorter hold classification and sharper turning still exclude swipes", () => {
  assert.equal(GestureRecognizer.holdDelay, 30);
  let steering = 0;
  const g = new GestureRecognizer(
    (v) => (steering = v),
    () => {},
  );
  g.begin(100, 500, 0, 1);
  g.update(29.9);
  assert.equal(steering, 0);
  g.update(30);
  assert.equal(steering, 1);
  g.clear();
  g.begin(100, 500, 100, 1);
  g.move(100, 480, 1);
  g.update(500);
  g.move(100, 440, 1);
  assert.equal(steering, 0);
  assert.equal(Rules.turnSpeed, 1.76);
});

test("forgiving cactus AABBs do not change rendering bounds or pickup reach", () => {
  const registry = new ObjectRegistry();
  registry.register({
    kind: ObjectKind.Cactus,
    weight: 0,
    blocking: true,
    colliders: [{ halfX: 0.8, halfZ: 0.8, height: 3 }],
  });
  const game = new Simulation(1, registry);
  game.phase = "running";
  const w = game.world;
  w.active.fill(0);
  w.active[0] = 1;
  w.kinds[0] = 0;
  w.x[0] = 0;
  w.z[0] = 1;
  w.halfX[0] = w.halfZ[0] = 0.8;
  w.height[0] = 3;
  game.step(STEP);
  assert.equal(
    game.health.lives,
    3,
    "old .8+.32 box hit from more than a metre away",
  );
  for (let i = 0; i < 8; i++) game.step(STEP);
  assert.equal(game.health.lives, 2);
  assert.equal(w.halfZ[0], Math.fround(0.8));
});

test("pickup density is a deterministic 90% subset, cactus field is unchanged", () => {
  const before = new WorldSpawner(ObjectRegistry.defaults(), 1),
    after = new WorldSpawner();
  let full = 0,
    reduced = 0;
  for (let seed = 1; seed <= 30; seed++) {
    before.reset(seed);
    after.reset(seed);
    before.update(seed * 123.4, -seed * 241.3);
    after.update(seed * 123.4, -seed * 241.3);
    for (let i = 0; i < before.active.length; i++) {
      if (before.active[i] && before.kinds[i] !== ObjectKind.Cactus) {
        full++;
        if (after.active[i]) reduced++;
      }
      if (before.kinds[i] === ObjectKind.Cactus && before.active[i])
        assert.equal(after.active[i], 1);
      if (after.active[i]) assert.equal(before.active[i], 1);
    }
  }
  assert.ok(
    reduced / full > 0.88 && reduced / full < 0.92,
    `${reduced}/${full}`,
  );
});

test("first person follows jump/duck height and restores rear projection after a smooth transition", () => {
  const rig = new CameraRig(true);
  rig.firstPerson = true;
  rig.heading = Math.PI / 2;
  rig.update(0, 0, 0.65, false, Math.PI / 2, 2, 0);
  assert.equal(rig.heading, Math.PI / 2);
  assert.equal(rig.camera.fov, 65);
  assert.equal(rig.camera.position.y, 3.45);
  assert.ok(Math.abs(rig.camera.position.x + 0.05) < 1e-10);
  rig.update(0, 0, 0, false, Math.PI / 2, 0, 1);
  assert.ok(Math.abs(rig.camera.position.y - 0.8) < 1e-10);
  rig.firstPerson = false;
  rig.update(0, 0, 0.65, false, Math.PI / 2);
  assert.equal(rig.camera.fov, 50);
  assert.equal(rig.camera.near, 0.2);
  assert.ok(Math.abs(rig.camera.position.x - 12) < 1e-10);
  assert.equal(new GameSettings().shake, 2.9);
});

test("denser step/landing dust stays inside one fixed 256-particle instanced pool", () => {
  const game = new Simulation(1),
    dust = new FootDust(game, false),
    view = new ObjectVisibility();
  const camera = new CameraRig(true);
  camera.resize(390 / 844);
  view.update(camera.camera);
  game.events.emit(GameEvent.Step);
  dust.update(game, 0, view);
  assert.equal(dust.mesh.count, 42);
  game.events.emit(GameEvent.Land);
  dust.update(game, 0, view);
  assert.equal(dust.mesh.count, 114);
  for (let i = 0; i < 100; i++) game.events.emit(GameEvent.Step);
  dust.update(game, 0, view);
  assert.equal(dust.mesh.count, 256);
  assert.equal(dust.mesh.geometry.attributes.position.count / 3, 8);
  assert.equal(dust.mesh.material.type, "MeshLambertMaterial");
  assert.equal(dust.mesh.castShadow, false);
  assert.equal(dust.mesh.receiveShadow, false);
  dust.update(game, 1, view);
  assert.equal(dust.mesh.count, 0);
  dust.dispose();
});

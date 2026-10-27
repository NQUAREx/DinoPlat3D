import { test } from "node:test";
import assert from "node:assert/strict";
import { DayCycle } from "../src/day-cycle.ts";
import { LightingRig } from "../src/lighting.ts";
import { Simulation, STEP } from "../src/simulation.ts";
import { Rules } from "../src/config.ts";
import { Tuning } from "../src/tuning.ts";
import { ObjectKind } from "../src/world.ts";
import { LandscapeField, Surface } from "../src/landscape.ts";
import { Ground } from "../src/ground.ts";
import { RenderPose } from "../src/render-pose.ts";

test("automatic day advances 30 percent faster with proportionate dusk and night", () => {
  const day = new DayCycle(), light = new LightingRig();
  try {
    assert.equal(day.automatic, true); assert.equal(day.cycleSeconds, 360 / 1.3);
    assert.equal(day.sample(0), 9); assert.equal(day.sample(105 / 1.3), 16);
    assert.equal(day.sample(135 / 1.3), 18); assert.equal(day.sample(180 / 1.3), 21);
    assert.equal(day.sample(360 / 1.3), 9);
    light.update(0); const morning = light.fogColour.getHex();
    light.update(180 / 1.3); assert.notEqual(light.fogColour.getHex(), morning);
    assert.equal(light.source, "moon");
    light.update(360 / 1.3); assert.equal(light.fogColour.getHex(), morning);
    assert.equal(light.cycle.cycleSeconds, 360 / 1.3); assert.equal(light.cycle.automatic, true);
    const game = new Simulation(1); game.phase = "running";
    game.step(STEP); const time = game.time;
    game.phase = "paused"; game.step(30); assert.equal(game.time, time);
    game.phase = "running"; game.hitStopRemaining = 1;
    game.step(STEP); assert.equal(game.time, time, "hit freeze does not advance day time");
  } finally { light.dispose(); }
});

test("fall eligibility doubles without changing pickup weights or candidate locations", () => {
  assert.equal(Tuning.landscape.fallChance, 0.32);
  const original = Tuning.landscape.fallChance;
  let before = 0, after = 0;
  try {
    for (let seed = 1; seed <= 12; seed++) {
      const game = new Simulation(seed), w = game.world;
      for (const chance of [0.16, 0.32]) {
        Tuning.landscape.fallChance = chance;
        w.reset(seed); w.update(500, 500);
        for (let i = 0; i < w.active.length; i++)
          if (w.active[i] && (w.kinds[i] === ObjectKind.Cactus || w.kinds[i] === ObjectKind.Tree || w.kinds[i] === ObjectKind.DeadTree) && w.motion[i] !== 0) {
            if (chance === 0.16) before++; else after++;
          }
      }
    }
    assert.ok(after / before > 1.8 && after / before < 2.2, `${before} -> ${after}`);
    assert.equal(Tuning.generation.coinWeight, 250);
    assert.equal(Tuning.generation.diamondWeight, 10);
    assert.equal(Rules.pickupSpawnChance, 0.9);
  } finally { Tuning.landscape.fallChance = original; }
});

test("dry pit vertices produce a deep unbridged hole even inside a bridge corridor", () => {
  class PitField extends LandscapeField {
    override vertexHeight() { return 0; }
    override hazardAt() { return 1; }
    override hazardKindAt() { return Surface.Pit; }
    override pitMaskAt() { return 1; }
    override bridgeMaskAt() { return 1; }
  }
  const f = new PitField(), ground = new Ground(f);
  try {
    ground.surface.update(new RenderPose());
    assert.equal(f.surfaceAt(4, 4), Surface.Pit);
    assert.equal(f.supportAt(4, 4), false);
    assert.ok(ground.mesh.geometry.drawRange.count > 0);
    for (const mesh of ground.extraMeshes) assert.equal(mesh.geometry.drawRange.count, 0);
    assert.equal(ground.mesh.geometry.getAttribute("position").getY(0), -14);
  } finally { ground.dispose(); }
});

test("jump inherits uphill/downhill running velocity instead of being caught by the slope", () => {
  for (const grade of [-1.6, -0.6, 0, 0.6, 1.1, 1.6]) {
    const g = new Simulation(1);
    for (let kind = ObjectKind.Jetpack; kind <= ObjectKind.Shake; kind++) g.world.registry.setWeight(kind, 0);
    g.landscape.heightAt = (_x, z) => grade * z;
    g.landscape.surfaceAt = () => Surface.Land;
    for (const kind of [ObjectKind.Cactus, ObjectKind.Coin, ObjectKind.Diamond, ObjectKind.Heart]) g.world.registry.setWeight(kind, 0);
    g.world.active.fill(0); g.phase = "running";
    g.distance = g.previousDistance = 4000;
    g.runSpeed = Rules.maxSpeed;
    for (let i = 0; i < 20; i++) g.step(STEP);
    const verticalRunSpeed = g.speed * grade;
    g.jump();
    assert.ok(Math.abs(g.velocityY - Rules.jumpSpeed - verticalRunSpeed) < 1e-8);
    const firstVelocity = g.velocityY;
    g.jump(); assert.equal(g.velocityY, firstVelocity, "no same-tick double jump");
    let peak = 0;
    for (let i = 0; i < 125; i++) { g.step(STEP); peak = Math.max(peak, g.y); }
    assert.ok(peak > 3.95 && peak < 4.1, `grade ${grade}, relative peak ${peak}`);
    assert.equal(g.y, 0); assert.equal(g.health.lives, 3);
  }
});

test("ground travel has equal surface speed uphill, downhill and on flat ground", () => {
  const speed: number[] = [];
  for (const grade of [1, 0, -1]) {
    const g = new Simulation(1);
    // Ground-speed comparison excludes optional flight and acceleration pickups.
    for (let kind = ObjectKind.Jetpack; kind <= ObjectKind.Shake; kind++) g.world.registry.setWeight(kind, 0);
    g.landscape.heightAt = (_x, z) => grade * z;
    g.landscape.surfaceAt = () => Surface.Land;
    for (const kind of [ObjectKind.Cactus, ObjectKind.Coin, ObjectKind.Diamond, ObjectKind.Heart]) g.world.registry.setWeight(kind, 0);
    g.phase = "running"; g.distance = g.previousDistance = 4000; g.runSpeed = Rules.maxSpeed;
    for (let i = 0; i < 120; i++) g.step(STEP);
    speed.push(g.speed * Math.hypot(1, grade));
  }
  for (const value of speed) assert.ok(Math.abs(value - Rules.maxSpeed) < 1e-8, `${speed}`);
});

test("acceleration increases gradually and recovers smoothly after damage", () => {
  const g = new Simulation(1); g.landscape.enabled = false;
  g.phase = "running"; g.distance = g.previousDistance = 4000;
  g.world.registry.setWeight(ObjectKind.Cactus, 0); g.world.active.fill(0);
  g.step(STEP);
  assert.ok(g.runSpeed > Rules.startSpeed && g.runSpeed < Rules.startSpeed + 0.1);
  let previous = g.runSpeed;
  for (let i = 0; i < 120; i++) {
    g.step(STEP); assert.ok(g.runSpeed >= previous && g.runSpeed - previous < 0.1); previous = g.runSpeed;
  }
  assert.ok(g.runSpeed < Rules.maxSpeed - 1);
  g.health.immunity = 1; g.step(STEP); assert.equal(g.runSpeed, Rules.startSpeed);
  g.health.immunity = 0; g.step(STEP); assert.ok(g.runSpeed < Rules.startSpeed + 0.1);
});

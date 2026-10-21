import test from "node:test";
import assert from "node:assert/strict";
import { WorldSpawner, ObjectKind } from "../src/world";
import { LandscapeField, Biome } from "../src/landscape";
import { Rules, GridMath } from "../src/config";
import { Tuning } from "../src/tuning";
import { Simulation, STEP } from "../src/simulation";
import { GameEvent } from "../src/events";

function moving(kind: ObjectKind) {
  const world = new WorldSpawner(undefined, undefined, new LandscapeField(1979));
  world.reset(1979);
  world.update(0, 0);
  const slot = world.active.findIndex((active, i) => !!active && world.kinds[i] === kind);
  assert.ok(slot >= 0);
  world.active.fill(0);
  world.active[slot] = 1;
  world.motion[slot] = 0;
  return { world, slot };
}

test("bird launch cone uses actual camera origin and facing, including both 45 degree edges", () => {
  for (const facing of [0, 1.2, -2.4, 8]) for (const angle of [-180, -90, -45.001, -45, -30, 0, 30, 45, 45.001, 90, 180]) {
    const { world: w, slot: i } = moving(ObjectKind.Bird);
    const cameraX = Math.sin(facing) * 12, cameraZ = -Math.cos(facing) * 12;
    const bearing = facing + angle * Math.PI / 180;
    const offset = angle * Math.PI / 180;
    const range = 12 * Math.cos(offset) + Math.sqrt(56 ** 2 - (12 * Math.sin(offset)) ** 2);
    w.x[i] = cameraX - Math.sin(bearing) * range;
    w.z[i] = cameraZ + Math.cos(bearing) * range;
    // Dino faces the candidate even when the camera cannot see it.
    const heading = Math.atan2(-w.x[i], w.z[i]);
    w.step(0, STEP, 0, 0, heading, 24, facing, cameraX, cameraZ);
    assert.equal(w.motion[i], Math.abs(angle) <= 45 ? 3 : 0, `facing=${facing}, angle=${angle}`);
    if (w.motion[i] === 3)
      assert.ok(Math.abs(Math.hypot(w.x[i] - w.previousX[i], w.z[i] - w.previousZ[i]) / STEP - 9) < 1e-5);
  }
  // A player-relative angle outside 45 degrees is visible from the rear camera.
  const { world: w, slot: i } = moving(ObjectKind.Bird);
  w.x[i] = 40; w.z[i] = 35;
  w.step(0, STEP, 0, 0, Math.PI, 24, 0, 0, -12);
  assert.equal(w.motion[i], 3);
});

test("bird launch distance is player-relative and omitted/NaN camera inputs fall back", () => {
  for (const distance of [47.99, 48, 56, 64, 64.01]) {
    const { world: w, slot: i } = moving(ObjectKind.Bird);
    w.x[i] = 0; w.z[i] = distance;
    w.step(0, STEP, 0, 0, 0, 24, 0, 0, -12);
    assert.equal(w.motion[i], distance >= 48 && distance <= 64 ? 3 : 0);
  }
  for (const invalid of [false, true]) {
    const { world: w, slot: i } = moving(ObjectKind.Bird);
    w.x[i] = -56; w.z[i] = 0;
    if (invalid) w.step(0, STEP, 0, 0, Math.PI / 2, 24, NaN, NaN, NaN);
    else w.step(0, STEP, 0, 0, Math.PI / 2, 24);
    assert.equal(w.motion[i], 3);
  }
});

test("bird waits when a rolling obstacle will require a jump on the runner's path", () => {
  const w = new WorldSpawner(undefined, undefined, new LandscapeField(1979));
  w.reset(1979); w.update(0, 0);
  const bird = w.active.findIndex((v, i) => !!v && w.kinds[i] === ObjectKind.Bird),
    weed = w.active.findIndex((v, i) => !!v && w.kinds[i] === ObjectKind.Tumbleweed);
  assert.ok(bird >= 0 && weed >= 0);
  w.active.fill(0); w.active[bird] = w.active[weed] = 1;
  w.motion[bird] = 0; w.x[bird] = 0; w.z[bird] = 56;
  const crossing = 0.8, angle = w.angles[weed];
  w.x[weed] = -Math.sin(angle) * 7.5 * crossing;
  w.z[weed] = (24 - Math.cos(angle) * 7.5) * crossing;
  w.step(0, STEP, 0, 0, 0, 24);
  assert.equal(w.motion[bird], 0, "crouch and jump hazards cannot launch together");
  assert.equal(w.motion[weed], 3, "rolling does not stop to defer the attack");
  w.active[weed] = 0;
  w.step(STEP, STEP, 0, 0, 0, 24);
  assert.equal(w.motion[bird], 3, "attack resumes once the ground path is clear");
});

test("rear birds wait; tumbleweed moves 7.5m/s and records its previous collider", () => {
  const rear = moving(ObjectKind.Bird);
  rear.world.x[rear.slot] = 0;
  rear.world.z[rear.slot] = -56;
  rear.world.step(0, 1 / 120, 0, 0, 0, 24);
  assert.equal(rear.world.motion[rear.slot], 0);
  const { world: w, slot: i } = moving(ObjectKind.Tumbleweed);
  w.x[i] = 0;
  w.z[i] = 40;
  w.step(0, 1 / 120, 0, 0, 0, 24);
  assert.equal(w.previousX[i], 0);
  assert.equal(w.previousZ[i], 40);
  assert.ok(Math.abs(w.x[i] - 7.5 / 120) < 1e-8);
});

test("every generated tumbleweed moves from spawn, including behind the runner", () => {
  let checked = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const field = new LandscapeField(seed), w = new WorldSpawner(undefined, undefined, field);
    w.reset(seed); w.update(500, -500);
    const positions = [];
    for (let i = 0; i < w.active.length; i++)
      if (w.active[i] && w.kinds[i] === ObjectKind.Tumbleweed && Math.hypot(w.x[i] - 500, w.z[i] + 500) < 80) {
        assert.equal(w.motion[i], 3); positions.push([i, w.x[i], w.z[i]]);
      }
    w.step(30, STEP, 500, -500, Math.PI);
    for (const [i, x, z] of positions) {
      assert.equal(w.active[i], 1, "no lifetime retirement while visible");
      assert.ok(Math.abs(Math.hypot(w.x[i] - x, w.z[i] - z) / STEP - 7.5) < 1e-5);
      checked++;
    }
  }
  assert.ok(checked > 5);
});

test("high-speed generation thins new hazards while preserving every pickup and live object", () => {
  let low = 0, high = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const a = new WorldSpawner(), b = new WorldSpawner();
    a.reset(seed); b.reset(seed); a.update(400, 400, Rules.startSpeed); b.update(400, 400, Rules.maxSpeed);
    for (let i = 0; i < a.active.length; i++) {
      if (a.registry.get(a.kinds[i])?.spawnGroup === "pickup") {
        assert.equal(a.active[i], b.active[i]);
      } else { low += +!!a.active[i]; high += +!!b.active[i]; }
    }
    const original = a.active.slice(); a.update(400, 400, Rules.maxSpeed);
    assert.deepEqual(a.active, original, "speed changes never cull live objects");
  }
  assert.ok(high / low > 0.6 && high / low < 0.8, `${low} -> ${high}`);
});

test("committed bird wings clear crouched runners on steep uphill and downhill passes", () => {
  for (const grade of [-1.6, -0.6, 0.6, 1.6]) {
    const { world: w, slot: i } = moving(ObjectKind.Bird);
    w.landscape!.heightAt = (_x, z) => grade * z;
    w.x[i] = 0; w.z[i] = 8; w.motion[i] = 3;
    w.fallStart[i] = 0;
    w.step(0, STEP, 0, 0, 0, 24);
    w.z[i] = -0.9;
    w.previousX[i] = 0; w.previousZ[i] = -0.9;
    w.step(1, STEP, 0, 0, 0, 24);
    assert.ok(w.baseY[i] >= Rules.duckBodyHeight + 0.39, `grade ${grade}`);
    assert.equal(w.motion[i], 4, "clearance does not reacquire horizontal target");
    assert.ok(Math.abs((w.z[i] + 0.9) / STEP + 9) < 1e-8);
    if (grade > 0)
      assert.ok(w.baseY[i] < Rules.playerBodyHeight, "standing uphill runner still meets bird");
  }
});

test("rocks/logs offer indexed smooth absolute support without pickup or damage metadata", () => {
  const w = new WorldSpawner(undefined, undefined, new LandscapeField(1979));
  w.reset(1979); w.update(0, 0);
  const slot = w.active.findIndex((active, i) => !!active && w.kinds[i] === ObjectKind.Rock);
  assert.ok(slot >= 0);
  w.active.fill(0);
  for (const kind of [ObjectKind.Rock, ObjectKind.Log]) {
    const definition = w.registry.get(kind)!;
    assert.equal(definition.walkable, true);
    assert.equal(definition.blocking, false);
    assert.equal(definition.spawnGroup, undefined);
    w.active[slot] = 1;
    w.kinds[slot] = kind;
    w.x[slot] = 10; w.z[slot] = 20;
    w.halfX[slot] = w.halfZ[slot] = 1;
    w.baseY[slot] = 3; w.height[slot] = 0.5;
    assert.equal(w.walkHeightAt(10, 20, 3), 3.5);
    assert.equal(w.walkHeightAt(11, 20, 3), 3);
    assert.ok(w.walkHeightAt(10.99, 20, 3) < 3.001);
    assert.equal(w.walkHeightAt(10, 20, 4), 4);
  }
  w.consume(slot);
  assert.equal(w.walkHeightAt(10, 20, 3), 3);
  w.reset(1979);
  assert.equal(w.walkHeightAt(10, 20, 3), 3);
});

test("bird commits full velocity on encounter and never follows after a duck", () => {
  const { world: w, slot: i } = moving(ObjectKind.Bird);
  w.x[i] = 0; w.z[i] = 56;
  w.step(0, 1 / 120, 0, 0, 0, 24);
  w.x[i] = 0; w.z[i] = 0.5;
  w.step(1, 1 / 120, 0, 0, 0, 24);
  assert.equal(w.motion[i], 4);
  assert.ok(Math.abs(w.z[i] - 0.425) < 1e-6);
  for (let tick = 1; tick < 120; tick++) w.step(1 + tick / 120, 1 / 120, 10, 10, 0, 24);
  assert.equal(w.motion[i], 4);
  assert.equal(w.x[i], 0);
  assert.ok(Math.abs(w.z[i] - (0.5 - 9)) < 1e-5);
  w.step(11, 1 / 120, 0, 0, 0, 24);
  assert.equal(w.active[i], 0);
});

// Freeze terrain support/biome so density measures generation rather than changing terrain.
class DensityField extends LandscapeField {
  override supportAt() { return true; }
  override heightAt() { return 0; }
  override biomeAt() { return Biome.Desert; }
}

/** Original acceptance, 40% minor-object share and full-distance hard-core thinning.
 * Independent candidate enumeration: no snapshot counts or new-population filtering. */
function originalMajors(w: WorldSpawner, seed: number) {
  const random = (cx: number, rz: number, n: number, salt: number) =>
    GridMath.hash(cx, rz, seed ^ Math.imul(n + 1, 0x9e3779b9) ^ salt) / 4294967296;
  const colliders = w.registry.get(ObjectKind.Cactus)!.colliders;
  const center = Math.floor(500 / Rules.chunkSize);
  let count = 0;
  for (let row = center - w.radius; row <= center + w.radius; row++)
    for (let col = center - w.radius; col <= center + w.radius; col++)
      for (let n = 0; n < Rules.candidatesPerChunk; n++) {
        const x = (col + random(col, row, n, 0x311a)) * Rules.chunkSize;
        const z = (row + random(col, row, n, 0x741d)) * Rules.chunkSize;
        const radius = Math.hypot(x, z);
        const speed = Math.min(Rules.maxSpeed, Rules.startSpeed + radius * Tuning.generation.speedGrowth);
        if (radius < Rules.firstRow || random(col, row, n, 0x17f3) >
          Tuning.generation.acceptance - (speed - Rules.startSpeed) * Tuning.generation.speedPenalty) continue;
        if (random(col, row, n, 0xa12c) < 0.4) continue;
        const bounds = colliders[Math.floor(random(col, row, n, 0x51ac) * colliders.length)];
        const angle = random(col, row, n, 0xad27) * Math.PI * 2;
        const cos = Math.abs(Math.cos(angle)), sin = Math.abs(Math.sin(angle));
        if (w.isRouteClear(x, z, bounds.halfX * cos + bounds.halfZ * sin,
          bounds.halfZ * cos + bounds.halfX * sin)) continue;
        const priority = random(col, row, n, 0xa193);
        let thinned = false;
        for (let rz = row - 1; rz <= row + 1; rz++)
          for (let cx = col - 1; cx <= col + 1; cx++)
            for (let k = 0; k < Rules.candidatesPerChunk; k++) {
              if (random(cx, rz, k, 0xa193) >= priority) continue;
              const nx = (cx + random(cx, rz, k, 0x311a)) * Rules.chunkSize;
              const nz = (rz + random(cx, rz, k, 0x741d)) * Rules.chunkSize;
              if ((nx - x) ** 2 + (nz - z) ** 2 < Tuning.generation.spacing ** 2) thinned = true;
            }
        if (!thinned) count++;
      }
  return count;
}

test("major obstacle density approaches twice the original with fixed capacity and clear routes", (t) => {
  let majors = 0, original = 0;
  const fallChance = Tuning.landscape.fallChance;
  Tuning.landscape.fallChance = 0;
  t.after(() => { Tuning.landscape.fallChance = fallChance; });
  for (let seed = 1; seed <= 12; seed++) {
    const w = new WorldSpawner(undefined, undefined, new DensityField(seed));
    w.reset(seed); w.update(500, 500);
    original += originalMajors(w, seed);
    assert.equal(w.active.length, 2250);
    for (let i = 0; i < w.active.length; i++) {
      if (!w.active[i]) continue;
      if ([ObjectKind.Cactus, ObjectKind.Tree, ObjectKind.DeadTree].includes(w.kinds[i])) {
        majors++;
        assert.equal(w.isRouteClear(w.x[i], w.z[i], w.halfX[i], w.halfZ[i]), false);
      }
      assert.ok(Number.isFinite(w.previousX[i]));
      assert.ok(Number.isFinite(w.previousZ[i]));
    }
  }
  t.diagnostic(`original=${original}, new=${majors}, ratio=${majors / original}`);
  assert.ok(majors / original > 1.9 && majors / original < 2.1,
    `major count ${majors}, original ${original}`);
});

function flatSimulation(kind: ObjectKind) {
  const game = new Simulation(1979);
  // Keep enabled: world dynamics and previous-collider snapshots still execute.
  game.landscape.vertexHeight = () => 0;
  game.landscape.hazardAt = () => -1;
  game.reset(1979);
  const w = game.world;
  let slot = -1, nearest = Infinity;
  for (let i = 0; i < w.active.length; i++) {
    if (!w.active[i] || w.kinds[i] !== kind) continue;
    const distance = Math.hypot(w.x[i], w.z[i]);
    if (distance < nearest) { nearest = distance; slot = i; }
  }
  assert.ok(slot >= 0, `natural ${ObjectKind[kind]} slot`);
  w.active.fill(0);
  w.active[slot] = 1;
  // Isolate this encounter even when chunk updates populate the far edge.
  for (const kind of [ObjectKind.Cactus, ObjectKind.Coin, ObjectKind.Diamond, ObjectKind.Heart])
    w.registry.setWeight(kind, 0);
  game.groundY = game.previousGroundY = 0;
  game.phase = "running";
  return { game, w, slot };
}

test("simulation: natural birds hit standing runners and timed ducks clear the full flight", () => {
  for (const angle of [-45, 0, 45]) for (const duck of [false, true]) {
    const { game, w, slot: i } = flatSimulation(ObjectKind.Bird);
    w.x[i] = w.previousX[i] = Math.sin(angle * Math.PI / 180) * 56;
    w.z[i] = w.previousZ[i] = Math.cos(angle * Math.PI / 180) * 56;
    w.baseY[i] = w.previousBaseY[i] = 1.05;
    game.distance = 4000; game.runSpeed = Rules.maxSpeed;
    game.heading = game.previousHeading = -angle * Math.PI / 180;
    let ducked = false, passed = false;
    for (let tick = 0; tick < 1200; tick++) {
      const dx = w.x[i] - game.x, dz = w.z[i] - game.z;
      const distance = Math.hypot(dx, dz);
      const closingSpeed = 18 + 24 * (-Math.sin(game.heading) * dx + Math.cos(game.heading) * dz) / distance;
      if (duck && !ducked && (w.motion[i] === 3 || w.motion[i] === 4) && distance / closingSpeed < 0.4) {
        game.down(); ducked = true;
      }
      game.step(STEP);
      if (w.motion[i] === 4) passed = true;
      if (!duck && game.health.lives < 3) break;
    }
    assert.equal(game.health.lives, duck ? 3 : 2, `angle=${angle}, duck=${duck}`);
    if (duck) {
      assert.ok(ducked && passed);
      assert.equal(game.crouchRemaining, 0);
      assert.equal(game.crouch, 0);
      assert.equal(w.active[i], 0, "full flight expires without a delayed hit");
    } else {
      assert.equal(w.active[i], 0, "actual bird damage consumes its slot");
      assert.equal(game.hitStopRemaining, Rules.hitStopSeconds);
    }
  }
});

test("simulation: relative bird sweep crosses the runner between disjoint frame endpoints", () => {
  const { game, w, slot: i } = flatSimulation(ObjectKind.Bird);
  // Launch naturally to establish full forward velocity, then exercise a fly-through.
  w.x[i] = 0; w.z[i] = 56;
  w.step(0, STEP, 0, 0, 0, 24);
  w.motion[i] = 4;
  w.x[i] = w.previousX[i] = 0;
  w.z[i] = w.previousZ[i] = 0.7;
  w.baseY[i] = w.previousBaseY[i] = 1.05;
  const extent = w.halfZ[i] * Rules.cactusHitScale + Rules.blockingRadius;
  assert.ok(w.z[i] > extent);
  // At 9m/s a 200ms sweep still crosses both separated collider endpoints.
  game.step(1 / 5);
  assert.ok(w.z[i] < -extent, "final collider also lies outside the player endpoint");
  assert.equal(game.health.lives, 2);
  assert.equal(w.active[i], 0);
  assert.equal(game.hitStopRemaining, Rules.hitStopSeconds);
  assert.ok(game.z > 0 && game.z < Rules.startSpeed / 10, "impact clamps within the tick");
});

test("simulation: slower head-on birds give 1.4–2.0 seconds of warning", (t) => {
  for (const distance of [48, 64]) {
    const { game, w, slot: i } = flatSimulation(ObjectKind.Bird);
    w.x[i] = w.previousX[i] = 0;
    w.z[i] = w.previousZ[i] = distance;
    w.baseY[i] = w.previousBaseY[i] = 1.05;
    game.distance = 4000; game.runSpeed = Rules.maxSpeed;
    // Launch at the exact band edge before the runner's first movement tick.
    w.step(0, 0, 0, 0, 0, 24);
    assert.equal(w.motion[i], 3);
    let ticks = 0;
    while (game.health.lives === 3 && ticks < 240) {
      game.step(STEP); ticks++;
      if (ticks === 1) assert.equal(w.motion[i], 3);
    }
    const warning = ticks * STEP;
    t.diagnostic(`${distance}m: contact after ${warning.toFixed(3)}s`);
    assert.equal(game.health.lives, 2);
    assert.ok(warning >= 1.4 && warning <= 2, `${distance}m: ${warning}s`);
  }
});

test("bird lock predicts a steady 24m/s runner with a 3m lateral launch offset", (t) => {
  const { world: w, slot: i } = moving(ObjectKind.Bird);
  w.x[i] = 3; w.z[i] = 56;
  let closest = Infinity, locked = false, velocityX = 0, velocityZ = 0;
  for (let tick = 0; tick < 360; tick++) {
    const z = tick * 24 * STEP;
    w.step(tick * STEP, STEP, 0, z, 0, 24);
    closest = Math.min(closest, Math.hypot(w.x[i], w.z[i] - z));
    if (w.motion[i] === 4) {
      const vx = (w.x[i] - w.previousX[i]) / STEP;
      const vz = (w.z[i] - w.previousZ[i]) / STEP;
      if (!locked) {
        locked = true; velocityX = vx; velocityZ = vz;
        assert.ok(Math.abs(Math.hypot(vx, vz) - 9) < 1e-5);
      }
      assert.ok(Math.abs(vx - velocityX) < 1e-8);
      assert.ok(Math.abs(vz - velocityZ) < 1e-8);
    }
  }
  assert.ok(locked);
  const contactRadius = 0.48 * Rules.cactusHitScale + Rules.blockingRadius;
  t.diagnostic(`3m offset: closest=${closest.toFixed(3)}m, collider=${contactRadius.toFixed(3)}m`);
  assert.ok(closest < contactRadius);

  const { game, w: world, slot } = flatSimulation(ObjectKind.Bird);
  world.x[slot] = world.previousX[slot] = game.x + 3;
  world.z[slot] = world.previousZ[slot] = game.z + 56;
  world.baseY[slot] = world.previousBaseY[slot] = 1.05;
  game.distance = 4000; game.runSpeed = Rules.maxSpeed;
  for (let tick = 0; tick < 360 && game.health.lives === 3; tick++) game.step(STEP);
  assert.equal(game.health.lives, 2, "steady standing runner must take the bird hit");
  assert.equal(world.active[slot], 0);
});

test("simulation: a late legal turn sidesteps a locked bird without ducking", () => {
  for (const direction of [-1, 1]) {
    const { game, w, slot: i } = flatSimulation(ObjectKind.Bird);
    w.x[i] = w.previousX[i] = 0;
    w.z[i] = w.previousZ[i] = 56;
    w.baseY[i] = w.previousBaseY[i] = 1.05;
    game.distance = 4000; game.runSpeed = Rules.maxSpeed;
    let locked = false, lockZ = 0, lockTime = 0;
    for (let tick = 0; tick < 1200; tick++) {
      game.step(STEP);
      if (!locked && w.motion[i] === 4) {
        locked = true; lockZ = w.z[i]; lockTime = game.time;
        assert.ok(Math.hypot(w.x[i] - game.x, w.z[i] - game.z) > 9);
        game.move(direction);
      }
      if (locked && w.active[i]) {
        assert.equal(w.motion[i], 4);
        assert.equal(w.x[i], 0, "locked flight cannot chase lateral movement");
        assert.ok(Math.abs(w.z[i] - (lockZ - 9 * (game.time - lockTime))) < 1e-5);
      }
      assert.equal(game.health.lives, 3);
    }
    assert.ok(locked);
    assert.equal(game.crouch, 0);
    assert.equal(w.active[i], 0, "complete flight expires without reacquiring");
  }
});

test("simulation: cached natural rock supports a smooth walk-over without gameplay rewards or damage", () => {
  const { game, w, slot: i } = flatSimulation(ObjectKind.Rock);
  w.x[i] = w.previousX[i] = 0;
  w.z[i] = w.previousZ[i] = 3;
  w.baseY[i] = w.previousBaseY[i] = 0;
  game.health.lives = 2; // Healing must be observable rather than hidden by full health.
  let collected = 0, visuals = 0;
  game.events.on(GameEvent.Collected, () => collected++);
  game.events.on(GameEvent.CollectedVisual, () => visuals++);
  let maximum = 0, rose = false, fell = false;
  const coins = game.wallet.coins, diamonds = game.wallet.diamonds;
  for (let tick = 0; tick < 80; tick++) {
    const before = game.groundY;
    game.step(STEP);
    maximum = Math.max(maximum, game.groundY);
    rose ||= game.groundY > before;
    fell ||= game.groundY < before;
    const slopeBound = 1.54 * w.height[i] / w.halfZ[i];
    assert.ok(Math.abs(game.groundY - before) <= slopeBound * game.speed * STEP + 1e-6);
    assert.equal(game.y, 0);
    assert.equal(game.falling, false);
    assert.equal(w.active[i], 1);
    assert.equal(game.health.lives, 2);
  }
  assert.ok(rose && fell && maximum > w.height[i] * 0.95);
  assert.equal(game.groundY, 0);
  assert.equal(game.hitStopRemaining, 0);
  assert.equal(game.wallet.coins, coins);
  assert.equal(game.wallet.diamonds, diamonds);
  assert.equal(collected, 0);
  assert.equal(visuals, 0);
});

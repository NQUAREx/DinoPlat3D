import { test } from "node:test";
import assert from "node:assert/strict";
import { LandscapeField, Surface } from "../src/landscape.ts";
import { Simulation, STEP } from "../src/simulation.ts";
import { ObjectKind } from "../src/world.ts";

test("three irregular coordinate biomes and nine covers are deterministic on revisits", () => {
  const field = new LandscapeField(1979),
    again = new LandscapeField(1979),
    counts = new Uint32Array(3),
    covers = new Set<number>();
  const sample = {
    biome: 0,
    cover: 0,
    surface: 0,
    height: 0,
    floor: 0,
    colour: 0,
    waterLevel: 0,
  };
  for (let z = -700; z < 700; z += 19)
    for (let x = -700; x < 700; x += 17) {
      field.sample(x, z, sample);
      counts[sample.biome]++;
      covers.add(sample.biome * 3 + sample.cover);
      assert.equal(field.heightAt(x, z), again.heightAt(x, z));
      assert.equal(field.biomeAt(x, z), again.biomeAt(x, z));
      assert.ok(Number.isFinite(sample.height));
    }
  assert.equal(covers.size, 9);
  assert.ok(counts[0] > counts[1] * 4 && counts[0] > counts[2] * 4);
  assert.ok(counts[1] > 100 && counts[2] > 100);
  assert.notEqual(field.heightAt(200, 200), field.heightAt(204, 200));
});
test("rivers, lava, pits and bridge crossings exist; safe corridors retain support", () => {
  const field = new LandscapeField(23),
    seen = new Set<Surface>();
  for (let z = -500; z <= 500; z += 4)
    for (let x = -500; x <= 500; x += 4)
      seen.add(field.surfaceAt(x + 2, z + 2));
  for (const type of [
    Surface.Land,
    Surface.Water,
    Surface.Lava,
    Surface.Pit,
    Surface.Bridge,
  ])
    assert.ok(seen.has(type));
  for (let z = -1000; z < 1000; z += 0.8)
    for (const corridor of [-4, 0, 4])
      assert.equal(field.supportAt(field.routeX(z, corridor), z), true);
});
test("walking follows actual hills and an unsupported fall is fatal even with immunity", () => {
  const game = new Simulation(17);
  game.phase = "running";
  game.world.active.fill(0);
  game.x = game.previousX = game.landscape.routeX(100);
  game.z = game.previousZ = 100;
  for (let i = 0; i < 30; i++) {
    game.step(STEP);
    game.world.active.fill(0);
    assert.equal(game.y, 0);
    assert.ok(
      Math.abs(game.groundY - game.landscape.heightAt(game.x, game.z)) < 1e-8,
    );
  }
  let found = false;
  for (let z = 40; z < 500 && !found; z += 4)
    for (let x = 10; x < 500 && !found; x += 4) {
      if (game.landscape.surfaceAt(x + 2, z + 2) === Surface.Pit) {
        game.x = game.previousX = x + 2;
        game.z = game.previousZ = z + 2;
        game.groundY = game.previousGroundY = game.landscape.heightAt(game.x, game.z);
        game.y = game.previousY = game.velocityY = 0;
        found = true;
      }
    }
  assert.ok(found);
  game.health.immunity = 20;
  game.world.active.fill(0);
  for (let i = 0; i < 80 && game.phase === "running"; i++) {
    game.step(STEP);
    game.world.active.fill(0);
  }
  assert.equal(game.health.lives, 0);
  assert.equal(game.falling, true);
});
test("birds are overhead hazards: crouch clears their simple coordinate collider", () => {
  for (const duck of [false, true]) {
    const game = new Simulation(1);
    game.landscape.enabled = false;
    game.phase = "running";
    game.world.active.fill(0);
    const w = game.world;
    w.active[0] = 1;
    w.kinds[0] = ObjectKind.Bird;
    w.motion[0] = 3;
    w.x[0] = 0;
    w.z[0] = 6;
    w.baseY[0] = 1.05;
    w.previousX[0] = w.x[0];
    w.previousZ[0] = w.z[0];
    w.previousBaseY[0] = w.baseY[0];
    w.height[0] = 0.38;
    w.halfX[0] = w.halfZ[0] = 0.48;
    if (duck) game.down();
    for (let i = 0; i < 70; i++) game.step(STEP);
    assert.equal(game.health.lives, duck ? 3 : 2);
  }
});

test("incoming birds intercept a running target instead of its old position",()=>{
  const game=new Simulation(1979),w=game.world;
  const i=w.active.findIndex((active,n)=>!!active&&w.kinds[n]===ObjectKind.Bird);
  assert.ok(i>=0);const px=w.x[i]-3,pz=w.z[i]-56,speed=24;
  w.active.fill(0);w.active[i]=1;let closest=Infinity;
  for(let frame=0;frame<360;frame++){
    const time=frame/120;w.step(time,STEP,px,pz+speed*time,0,speed);
    closest=Math.min(closest,Math.hypot(w.x[i]-px,w.z[i]-(pz+speed*(time+STEP))));
  }
  assert.ok(closest<.48*.65+.22,`encounter must enter the simple collider, distance ${closest}`);
});

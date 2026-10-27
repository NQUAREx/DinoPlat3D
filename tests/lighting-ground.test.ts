import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Scene,
  BoxGeometry,
  MeshBasicMaterial,
  WebGLRenderTarget,
  Vector3,
} from "three";
import { DayCycle } from "../src/day-cycle.ts";
import { LightingRig } from "../src/lighting.ts";
import { Ground } from "../src/ground.ts";
import { Simulation } from "../src/simulation.ts";
import { RenderPose } from "../src/render-pose.ts";
import { LandscapeField, Surface } from "../src/landscape.ts";
import { InstancedObjectType } from "../src/object-renderer.ts";
import { ObjectKind } from "../src/world.ts";
import { CachedShadows } from "../src/shadows.ts";

test("day/night model is fixed-time deterministic, wraps and supports frozen time", () => {
  const day = new DayCycle();
  assert.equal(day.sample(0), 9);
  assert.equal(day.sample(180 / 1.3), 21);
  assert.equal(day.sample(360 / 1.3), 9);
  day.setTime(18);
  assert.equal(day.sample(999), 18);
  day.setTime(-1);
  assert.equal(day.sample(0), 23);
  day.setTime(6, true);
  day.cycleSeconds = 240;
  assert.equal(day.sample(60), 12);
  assert.throws(() => day.setTime(NaN));
  assert.throws(() => (day.cycleSeconds = 0));
});
test("moving sun reverses shadows and day/night changes fog and visibility without new lights", () => {
  const light = new LightingRig(),
    key = light.key,
    ambient = light.ambient;
  light.setTimeOfDay(9);
  light.update(0);
  const x = light.shadowSlope.x,
    morning = light.fogColour.getHex();
  assert.ok(light.shadowStrength > 0 && x > 0);
  light.setTimeOfDay(15);
  light.update(0);
  assert.ok(light.shadowSlope.x < 0);
  light.setTimeOfDay(0);
  light.update(0);
  assert.ok(light.shadowStrength > 0);
  assert.equal(light.source, "moon");
  assert.equal("moon" in light, false);
  assert.notEqual(light.fogColour.getHex(), morning);
  assert.ok(light.ambient.intensity > 0.3);
  light.setTimeOfDay(18);
  light.update(0);
  assert.notEqual(light.fogColour.getHex(), morning);
  light.setSunPosition(-8, 12, 4);
  light.update(0);
  assert.equal(light.key.position.x, -8);
  assert.ok(light.shadowSlope.x < 0);
  assert.ok(Math.hypot(light.shadowSlope.x, light.shadowSlope.y) <= 3.001);
  light.shadowsEnabled = false;
  light.update(0);
  assert.equal(light.shadowStrength, 0);
  assert.equal(light.key, key);
  assert.equal(light.ambient, ambient);
  assert.throws(() => light.setSunPosition(NaN, 0, 0));
  light.dispose();
});
test("field meshes share the interpolated render origin at negative and million-metre coordinates", () => {
  const game = new Simulation(1979),
    pose = new RenderPose();
  const field = new LandscapeField(1979), ground = new Ground(field);
  assert.equal(LandscapeField.tile, 4);
  game.x = -4.9;
  game.previousX = -5.1;
  game.distance = 500.1;
  game.previousDistance = 499.9;
  game.z = 500.1;
  game.previousZ = 499.9;
  pose.update(game, 0.25);
  ground.update(game, pose);
  assert.ok(Math.abs(pose.x + 5.05) < 1e-9);
  assert.ok(Math.abs(pose.distance - 499.95) < 1e-9);
  for (const base of [-1000000, 0, 1000000]) {
    const pointX = base + 12, pointZ = -base + 12;
    const expectedY = field.heightAt(pointX, pointZ);
    for (const offset of [-0.01, 0.01, 3.99, 4.01]) {
      pose.x = base + offset;
      pose.z = -base + offset;
      pose.distance = 987654321;
      ground.update(game, pose);
      assert.equal(ground.surface.heightAt(pointX, pointZ), expectedY);
      for (const mesh of [ground.mesh, ...ground.extraMeshes]) {
        assert.equal(mesh.position.x, ground.surface.anchorX - pose.x);
        assert.equal(mesh.position.z, pose.z - ground.surface.anchorDistance);
        assert.equal(mesh.material.map, null);
        assert.equal(mesh.material.vertexColors, true);
      }
      const positions = ground.surface.geometry.getAttribute("position");
      const x = (positions.getX(0) + positions.getX(1) + positions.getX(2)) / 3 + ground.surface.anchorX;
      const z = ground.surface.anchorDistance - (positions.getZ(0) + positions.getZ(1) + positions.getZ(2)) / 3;
      const kind = field.surfaceAt(x, z);
      const y = (positions.getY(0) + positions.getY(1) + positions.getY(2)) / 3;
      const drop = y - field.heightAt(x, z);
      const depth = kind === Surface.Land ? 0 : field.hazardKindAt(x, z) === Surface.Pit ? 14 : 4.8;
      assert.ok(Math.abs(drop + depth) < 0.00003);
      assert.equal(ground.mesh.position.y, 0);
    }
  }
  assert.equal(ground.material.isMeshLambertMaterial, true);
  assert.equal(ground.mesh.receiveShadow, true);
  assert.equal(ground.surface.geometry.index, null, "flat faces need no identity index allocation");
  assert.ok(ground.surface.geometry.drawRange.count / 3 > 56 * 56 * 2);
  ground.dispose();
});

test("cached shadow map is rebased continuously, throttled even at minimum quality and invalidated on manual light/reset", () => {
  const game = new Simulation(),
    pose = new RenderPose(),
    light = new LightingRig(),
    cache = new CachedShadows();
  light.key.shadow.map = new WebGLRenderTarget(256, 256);
  light.update(0);
  pose.update(game, 1);
  assert.equal(cache.prepare(game, pose, light, 0.5), true);
  light.key.updateMatrixWorld();
  light.key.target.updateMatrixWorld();
  light.key.shadow.updateMatrices(light.key);
  cache.complete(light);
  const point = new Vector3(3, 0.02, -8).applyMatrix4(light.key.shadow.matrix);
  game.time = 0.02;
  pose.x = 0.1;
  pose.z = pose.distance = 0.24;
  light.update(game.time);
  assert.equal(cache.prepare(game, pose, light, 0.5), false);
  const moved = new Vector3(3 - pose.x, 0.02, pose.distance - 8).applyMatrix4(
    light.key.shadow.matrix,
  );
  assert.ok(point.distanceTo(moved) < 1e-10);
  for (let i = 3; i <= 100; i++) {
    game.time = i / 100;
    pose.z = pose.distance = game.time * 12;
    light.update(game.time);
    if (cache.prepare(game, pose, light, 0.5)) {
      light.key.updateMatrixWorld();
      light.key.target.updateMatrixWorld();
      light.key.shadow.updateMatrices(light.key);
      cache.complete(light);
    }
  }
  assert.ok(cache.updates <= 5);
  light.setTimeOfDay(0);
  light.update(game.time);
  assert.equal(cache.prepare(game, pose, light, 0.5), true);
  cache.invalidate();
  assert.equal(cache.prepare(game, pose, light, 0.5), true);
  light.dispose();
});
test("instance uploads reuse one range and send only the live prefix, empty banks are invisible", () => {
  const geometry = new BoxGeometry(),
    material = new MeshBasicMaterial();
  const instances = new InstancedObjectType(
    ObjectKind.Cactus,
    [geometry],
    material,
    new Scene(),
  );
  const mesh = instances.meshes[0];
  instances.begin();
  instances.place(0, 1, 2, 0);
  instances.finish();
  const range = mesh.instanceMatrix.updateRanges[0];
  assert.equal(range.count, 16);
  assert.equal(mesh.visible, true);
  mesh.instanceMatrix.clearUpdateRanges();
  instances.begin();
  instances.place(0, 2, 3, 0);
  instances.place(0, 3, 4, 0);
  instances.finish();
  assert.equal(mesh.instanceMatrix.updateRanges[0], range);
  assert.equal(range.count, 32);
  const version = mesh.instanceMatrix.version;
  instances.begin();
  instances.finish();
  assert.equal(mesh.visible, false);
  assert.equal(mesh.instanceMatrix.version, version);
  instances.dispose();
  geometry.dispose();
  material.dispose();
});

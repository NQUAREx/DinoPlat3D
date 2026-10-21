import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Mesh, Scene, Matrix4 } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { BiomeModels } from "../src/biome-models.ts";
import type { ObjectVisibility } from "../src/camera.ts";
import { LandscapeField, Surface } from "../src/landscape.ts";
import { RenderPose } from "../src/render-pose.ts";
import { Scenery } from "../src/scenery.ts";

const bytes = await readFile(new URL("../src/assets/biome-models.glb", import.meta.url));
const gltf = await new GLTFLoader().parseAsync(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "",
);
const models = { get(name: string) { return (gltf.scene.getObjectByName(name) as Mesh).geometry; } } as BiomeModels;
const all = { intersects: () => true } as unknown as ObjectVisibility;
type Cache = {
  count: number; x: Float64Array; z: Float64Array; y: Float32Array;
  angle: Float32Array; kinds: Uint8Array; radii: Float32Array;
};
function stones(scenery: Scenery) {
  const c = scenery as unknown as Cache;
  return Array.from({ length: c.count }, (_, i) => i).filter(i => c.kinds[i] >= 10)
    .map(i => [c.x[i], c.z[i], c.y[i], c.angle[i], c.kinds[i]]);
}

test("rim stones use cached assets, bounded banks, dry footprints and stable world coordinates", () => {
  const field = new LandscapeField(47), scene = new Scene(), pose = new RenderPose();
  const scenery = new Scenery(field, models, scene);
  try {
    assert.equal(scene.children.length, 13);
    for (const [x, z] of [[0, 0], [-240, -180], [1000000, -1000000]]) {
      pose.x = x; pose.z = z;
      scenery.update(pose, all);
      const before = stones(scenery), cache = scenery as unknown as Cache;
      assert.ok(before.length > 20, `populated rims at ${x},${z}`);
      assert.ok(before.length <= 4096);
      assert.ok(cache.count <= 5696);
      assert.deepEqual([...new Set(before.map(s => s[4]))].sort(), [10, 11, 12]);
      for (const [sx, sz, , , kind] of before) {
        const radius = cache.radii[kind];
        assert.ok(Math.max(field.pitMaskAt(sx, sz), field.pitMaskAt(sx, sz, 1)) < -radius);
        for (let p = 0; p < 9; p++) assert.equal(field.surfaceAt(
          sx + (p % 3 - 1) * radius, sz + (Math.floor(p / 3) - 1) * radius,
        ), Surface.Land);
      }
      pose.x += 32; scenery.update(pose, all);
      const overlap = new Map(stones(scenery).map(s => [`${s[0]},${s[1]}`, s]));
      let shared = 0;
      for (const stone of before) {
        const other = overlap.get(`${stone[0]},${stone[1]}`);
        if (other) { assert.deepEqual(other, stone); shared++; }
      }
      assert.ok(shared > before.length / 2);
      pose.x = x; scenery.update(pose, all);
      assert.deepEqual(stones(scenery), before, "revisit reproduces every cached transform");
      const matrix = new Matrix4();
      for (const object of scene.children) {
        const mesh = object as import("three").InstancedMesh;
        assert.ok(mesh.count <= mesh.instanceMatrix.count);
        for (let i = 0; i < mesh.count; i++) {
          mesh.getMatrixAt(i, matrix);
          assert.ok(Math.hypot(matrix.elements[12], matrix.elements[14]) <= 75.001);
        }
      }
    }
    const cache = scenery as unknown as Cache, arrays = [cache.x, cache.z, cache.y];
    scenery.update(pose, { intersects: () => false } as unknown as ObjectVisibility);
    assert.equal(scenery.visible, 0);
    assert.deepEqual([cache.x, cache.z, cache.y], arrays);
    assert.ok(scene.children.every(o => (o as import("three").InstancedMesh).count === 0));
  } finally { scenery.dispose(); }
  assert.equal(scene.children.length, 0);
});

test("both independent pit perimeters have continuous irregular rim coverage", () => {
  class DryPits extends LandscapeField {
    override pitMaskAt(x: number, z: number, family = 0) {
      return Math.min(4 - Math.abs(x - (family ? 38 : -22)), 14 - Math.abs(z - 12));
    }
    override surfaceAt(x: number, z: number) {
      return Math.max(this.pitMaskAt(x, z), this.pitMaskAt(x, z, 1)) > 0 ? Surface.Pit : Surface.Land;
    }
    override heightAt() { return 0; }
  }
  const field = new DryPits(19), scenery = new Scenery(field, models, new Scene());
  const pose = new RenderPose();
  try {
    scenery.update(pose, all);
    const rim = stones(scenery);
    for (const cx of [-22, 38]) {
      const family = rim.filter(s => Math.abs(s[0] - cx) < 10);
      assert.ok(family.length > 25);
      for (let t = -14; t <= 14; t++) for (const side of [-1, 1]) {
        assert.ok(Math.min(...family.map(s => Math.hypot(s[0] - (cx + side * 4), s[1] - (12 + t)))) < 4,
          "long rim has no gap larger than four metres");
      }
      for (let t = -4; t <= 4; t++) for (const side of [-1, 1]) {
        assert.ok(Math.min(...family.map(s => Math.hypot(s[0] - (cx + t), s[1] - (12 + side * 14)))) < 4);
      }
      assert.equal(new Set(family.map(s => s[4])).size, 3);
      assert.ok(new Set(family.map(s => s[3])).size > 20, "independent scattered yaw");
    }
    field.enabled = false;
    scenery.update(pose, all);
    assert.equal(stones(scenery).length, 0, "terrain toggle invalidates the rim cache");
    field.enabled = true;
    scenery.update(pose, all);
    assert.deepEqual(stones(scenery), rim);
    field.seed++;
    scenery.update(pose, all);
    assert.notDeepEqual(stones(scenery), rim, "seed changes scatter");
  } finally { scenery.dispose(); }
});

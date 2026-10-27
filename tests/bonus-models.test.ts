import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { BonusVisuals } from "../src/bonus-visuals.ts";
import { BonusKind } from "../src/bonuses.ts";
import { Simulation } from "../src/simulation.ts";
import { RenderPose } from "../src/render-pose.ts";
import { AnimatedDinosaur } from "../src/character.ts";
import type { BonusModels as Library } from "../src/bonus-models.ts";
import type { ModelLibrary } from "../src/models.ts";

const bytes = await readFile(new URL("../src/assets/bonus-models.glb", import.meta.url));
const source = (await readFile(new URL("../src/bonus-models.ts", import.meta.url), "utf8"))
  .replace(/import modelUrl from "[^"]+";/, 'const modelUrl = "https://bonus.test/models.glb";');
const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2020 } }).outputText
  .replace(/from "(three[^"]*)"/g, (_, name: string) => `from ${JSON.stringify(import.meta.resolve(name))}`);
const { BonusModels } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`) as { BonusModels: { load(): Promise<Library> } };
const oldFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(bytes);
const models = await BonusModels.load();
globalThis.fetch = oldFetch;
after(() => models.dispose());

test("bonus GLB is deterministic, compact, indexed, coloured and volumetric", async () => {
  const { buildBonusGlb } = await import(new URL("../tools/build-bonus-models.mjs", import.meta.url).href);
  assert.deepEqual(buildBonusGlb(), bytes);
  assert.ok(bytes.length < 50000);
  assert.equal(models.pickups.length, 7);
  assert.equal(models.geometries.size, 8);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), normal = new THREE.Vector3();
  for (const [name, geometry] of models.geometries) {
    const p = geometry.getAttribute("position"), n = geometry.getAttribute("normal"), colors = geometry.getAttribute("color"), index = geometry.index!;
    assert.ok(index.count / 3 <= 184, name);
    assert.ok(colors.array instanceof Uint8Array && colors.normalized);
    assert.equal(p.count, n.count);
    assert.equal(p.count, colors.count);
    assert.equal(geometry.groups.length, 0);
    let volume = 0;
    for (let i = 0; i < p.count; i++) {
      a.fromBufferAttribute(p, i); normal.fromBufferAttribute(n, i);
      assert.ok(a.toArray().every(Number.isFinite), name);
      assert.ok(Math.abs(normal.length() - 1) < 1e-6, name);
      if (name.startsWith("bonus-")) {
        assert.ok(a.y >= -1e-6 && a.y <= .83, name);
        assert.ok(Math.hypot(a.x, a.z) <= .45, name);
      }
    }
    for (let i = 0; i < index.count; i += 3) {
      a.fromBufferAttribute(p, index.getX(i)); b.fromBufferAttribute(p, index.getX(i+1)); c.fromBufferAttribute(p, index.getX(i+2));
      normal.crossVectors(b.clone().sub(a), c.clone().sub(a));
      assert.ok(normal.length() > 1e-9, `${name}: degenerate triangle`);
      volume += a.dot(b.clone().cross(c)) / 6;
    }
    assert.ok(volume > .0001, `${name}: positive volume`);
  }
});

function fixture(reducedMotion = false) {
  const game = new Simulation(123);
  game.reset(123);
  game.phase = "running";
  const avatar = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshLambertMaterial());
  const torso = new THREE.Bone(); torso.name = "dino-torso";
  avatar.add(torso); avatar.bind(new THREE.Skeleton([torso]));
  const scene = new THREE.Scene(); scene.add(avatar);
  scene.fog = new THREE.Fog(0x73d8ff, 36, 84);
  const camera = new THREE.PerspectiveCamera(), pose = new RenderPose();
  const visuals = new BonusVisuals(models, avatar, scene, game, reducedMotion);
  const frame = (dt = 1/30) => {
    game.previousTime = game.time; game.time += dt;
    camera.position.set(0, 0, 0); camera.quaternion.identity();
    scene.fog!.color.setHex(0x73d8ff);
    (scene.fog as THREE.Fog).near = 36; (scene.fog as THREE.Fog).far = 84;
    visuals.update(game, pose, camera, 1);
  };
  const dispose = () => { visuals.dispose(); avatar.geometry.dispose(); (avatar.material as THREE.Material).dispose(); avatar.skeleton.dispose(); };
  return { game, avatar, torso, scene, camera, pose, visuals, frame, dispose };
}

test("exhaust follows both rotated nozzles, is bounded, pauses/freezes, and rebases at huge coordinates", () => {
  const f = fixture();
  f.game.bonuses.activate(BonusKind.Jetpack);
  f.avatar.position.y = 5;
  f.avatar.rotation.set(.3, 1.4, 0);
  f.pose.x = 1e6; f.pose.z = -1e6;
  f.frame(); f.frame(.05);
  assert.equal(f.visuals.smoke.count, 10);
  const matrix = new THREE.Matrix4(), position = new THREE.Vector3();
  for (let side = 0; side < 2; side++) {
    f.visuals.smoke.getMatrixAt(side, matrix);
    position.setFromMatrixPosition(matrix);
    const expected = new THREE.Vector3(side ? .19 : -.19, 0, 0).applyMatrix4(f.visuals.backpack.matrixWorld);
    assert.ok(position.distanceTo(expected) < 1e-5, "actual transformed nozzle");
  }
  for (let i = 0; i < 100; i++) f.frame();
  assert.ok(f.visuals.smoke.count > 20 && f.visuals.smoke.count <= 160);
  const frozen = f.visuals.smoke.instanceMatrix.array.slice();
  f.game.phase = "paused"; f.frame(.5);
  assert.deepEqual(f.visuals.smoke.instanceMatrix.array, frozen);
  f.game.phase = "running"; f.game.hitStopRemaining = 1; f.frame(.5);
  assert.deepEqual(f.visuals.smoke.instanceMatrix.array, frozen);
  const previousX = f.visuals.smoke.instanceMatrix.array[12];
  f.pose.x += 100; f.frame(.5);
  assert.ok(Math.abs(f.visuals.smoke.instanceMatrix.array[12] - previousX + 100) < 1e-4);
  f.game.hitStopRemaining = 0; f.game.bonuses.reset();
  for (let i = 0; i < 30; i++) f.frame();
  assert.equal(f.visuals.smoke.count, 0);
  assert.equal(f.visuals.backpack.visible, false);
  f.dispose(); f.visuals.dispose();
  assert.equal(f.scene.getObjectByName("bonus-exhaust"), undefined);
});

test("soft fog eases to 5/22 then restores day fog; shake is bounded and reduced motion suppresses smoke/shake", () => {
  for (const reduced of [false, true]) {
    const f = fixture(reduced);
    for (const kind of [BonusKind.Blindness, BonusKind.Shake, BonusKind.Jetpack, BonusKind.Turbo]) f.game.bonuses.activate(kind);
    for (let i = 0; i < 60; i++) {
      f.frame();
      assert.ok(f.camera.position.length() < .38);
      assert.ok(f.camera.quaternion.angleTo(new THREE.Quaternion()) < .11);
    }
    assert.ok(Math.abs((f.scene.fog as THREE.Fog).near - 9) < .001);
    assert.ok(Math.abs((f.scene.fog as THREE.Fog).far - 16) < .001);
    assert.equal(f.scene.fog!.color.getHex(), 0);
    assert.equal(f.visuals.shakeStrength, reduced ? 0 : 1);
    assert.equal(f.visuals.turbo.visible, true);
    assert.equal(f.visuals.backpack.visible, true);
    if (reduced) assert.equal(f.visuals.smoke.count, 0);
    const fog = f.visuals.fogStrength;
    f.game.phase = "paused"; f.frame(1);
    assert.equal(f.visuals.fogStrength, fog);
    f.game.phase = "running"; f.game.bonuses.reset();
    for (let i = 0; i < 60; i++) f.frame();
    assert.equal(f.visuals.fogStrength, 0);
    assert.equal((f.scene.fog as THREE.Fog).near, 36);
    assert.equal((f.scene.fog as THREE.Fog).far, 84);
    assert.equal(f.scene.fog!.color.getHex(), 0x73d8ff);
    f.dispose();
  }
});

test("invisibility multiplies immunity opacity on the shared body/accessories material and restores depth", async () => {
  const data = await readFile(new URL("../src/assets/game-models.glb", import.meta.url));
  const gltf = await new GLTFLoader().parseAsync(data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength), "");
  const dinosaur = gltf.scene.getObjectByName("dinosaur") as THREE.SkinnedMesh;
  const game = new Simulation(123); game.reset(123);
  game.phase = "running";
  const character = new AnimatedDinosaur({ dinosaur, animations: gltf.animations } as ModelLibrary, game);
  game.health.immunity = 2;
  character.update(game, 1, true, .22);
  const material = dinosaur.material as THREE.MeshLambertMaterial;
  assert.equal(material.opacity, .11); assert.equal(material.transparent, true); assert.equal(material.depthWrite, false);
  character.update(game, 1);
  assert.equal(material.opacity, .5); assert.equal(material.depthWrite, true);
  game.health.immunity = 0; character.update(game, 1);
  assert.equal(material.opacity, 1); assert.equal(material.transparent, false);
  character.dispose();
  const materials = new Set<THREE.Material>();
  gltf.scene.traverse(object => { if (object instanceof THREE.Mesh) { object.geometry.dispose(); if (object !== dinosaur) for (const m of Array.isArray(object.material) ? object.material : [object.material]) materials.add(m); } });
  for (const material of materials) material.dispose();
  dinosaur.skeleton.dispose();
});

test("loader releases all resources once on success and validation failure", async t => {
  const geometries = new Map<THREE.BufferGeometry, number>(), materials = new Map<THREE.Material, number>();
  t.mock.method(THREE.BufferGeometry.prototype, "dispose", function(this: THREE.BufferGeometry) { geometries.set(this, (geometries.get(this) ?? 0) + 1); });
  t.mock.method(THREE.Material.prototype, "dispose", function(this: THREE.Material) { materials.set(this, (materials.get(this) ?? 0) + 1); });
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response(bytes));
  const loaded = await BonusModels.load(); loaded.dispose(); loaded.dispose();
  assert.equal(geometries.size, 8); assert.equal(materials.size, 1);
  assert.ok([...geometries.values(), ...materials.values()].every(n => n === 1));
  assert.throws(() => loaded.get("bonus-jetpack"), /disposed/);
  fetch.mock.mockImplementation(async () => new Response(null, { status: 503 }));
  await assert.rejects(BonusModels.load(), /Failed to load bonus/);
  fetch.mock.mockImplementation(async () => new Response(bytes));
  geometries.clear(); materials.clear();
  const parse = GLTFLoader.prototype.parseAsync;
  t.mock.method(GLTFLoader.prototype, "parseAsync", async function(this: GLTFLoader, data: ArrayBuffer, path: string) {
    const gltf = await parse.call(this, data, path);
    gltf.scene.getObjectByName("bonus-jetpack")!.name = "missing";
    return gltf;
  });
  await assert.rejects(BonusModels.load(), /Failed to load bonus/);
  assert.equal(geometries.size, 8); assert.equal(materials.size, 1);
  assert.ok([...geometries.values(), ...materials.values()].every(n => n === 1));
});

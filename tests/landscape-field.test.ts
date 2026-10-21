import { test } from "node:test";
import assert from "node:assert/strict";
import { Biome, LandscapeField, Surface, type LandscapeSample } from "../src/landscape.ts";
import { Tuning } from "../src/tuning.ts";

test("one-query cache reuses geometry across modes and observes seed, enable and tuning edits", (t) => {
  class CountedField extends LandscapeField {
    gridCalls = 0;
    override gridX(x: number, z: number) { this.gridCalls++; return super.gridX(x, z); }
    override gridZ(x: number, z: number) { this.gridCalls++; return super.gridZ(x, z); }
  }
  const field = new CountedField(23), x = -1000000.13, z = 1000000.37;
  field.heightAt(x, z); const located = field.gridCalls;
  field.surfaceAt(x, z); field.hazardKindAt(x, z); field.supportAt(x, z);
  assert.equal(field.gridCalls, located);
  field.seed = 1979;
  assert.equal(field.heightAt(x, z), new LandscapeField(1979).heightAt(x, z));
  assert.ok(field.gridCalls > located);
  field.reset(23); field.heightAt(x, z); const resetCalls = field.gridCalls;
  field.enabled = false;
  assert.equal(field.heightAt(x, z), 0); assert.equal(field.gridCalls, resetCalls);
  field.hazardKindAt(x, z); field.enabled = true;
  assert.equal(field.heightAt(x, z), new LandscapeField(23).heightAt(x, z));
  const scale = Tuning.landscape.heightScale, size = Tuning.landscape.biomeSize;
  try {
    Tuning.landscape.heightScale = scale * 2; Tuning.landscape.biomeSize = size * 1.1;
    const fresh = new LandscapeField(23);
    assert.equal(field.heightAt(x, z), fresh.heightAt(x, z));
    assert.equal(field.surfaceAt(x, z), fresh.surfaceAt(x, z));
    assert.equal(field.hazardKindAt(x, z), fresh.hazardKindAt(x, z));
  } finally { Tuning.landscape.heightScale = scale; Tuning.landscape.biomeSize = size; }
  let sum = 0, elapsed = 0;
  for (let pass = 0; pass < 3; pass++) {
    field.gridCalls = 0; const start = performance.now();
    for (let i = 0; i < 20000; i++) {
      const px = 100 + i * 0.017, pz = -400 + i * 0.031;
      sum += field.heightAt(px, pz) + field.surfaceAt(px, pz) + field.hazardKindAt(px, pz);
    }
    elapsed = performance.now() - start;
  }
  t.diagnostic(`20k query groups: ${elapsed.toFixed(1)}ms, ${field.gridCalls} lattice calls, checksum ${sum.toFixed(3)}`);
  assert.ok(field.gridCalls < 400000, "bounded central-first geometry work across 60,000 API calls");
});

test("thinned mountain cores retain scaled peaks and deterministic summit islands", () => {
  const field = new LandscapeField(1979); const seen = new Set<Biome>(); let cores = 0, mountains = 0;
  for (let iz = -8; iz <= 8; iz++) for (let ix = -8; ix <= 8; ix++) {
    if (field.hash(ix, iz, 114) >= 0.32) continue;
    mountains++;
    const x = (ix + 0.35 + 0.3 * field.hash(ix, iz, 115)) * 320;
    const z = (iz + 0.35 + 0.3 * field.hash(ix, iz, 116)) * 320;
    assert.ok(field.vertexHeight(x, z) > 40);
    if (field.hash(ix, iz, 118) >= 1 / 3) continue;
    const biome = field.biomeAt(x, z); assert.notEqual(biome, Biome.Desert);
    assert.equal(field.biomeAt(x + 20, z), biome); seen.add(biome); cores++;
  }
  assert.ok(cores > 20 && cores < 45); assert.equal(seen.size, 2);
  assert.ok(mountains / 289 > 0.27 && mountains / 289 < 0.37, "about one-third of macro cells contain tall mountains");
  assert.ok(cores / mountains > 0.25 && cores / mountains < 0.42, "about one-third of mountain cores receive summit islands");
});

test("seed-rotated bridge curves cover all heading sectors with matching tangents and support", () => {
  const field = new LandscapeField(), sectors = new Set<number>(), bridgeSectors = new Set<number>();
  let checked = 0;
  for (let seed = 1; seed <= 64; seed++) {
    field.reset(seed);
    const theta = field.hash(0, 0, 303) * Math.PI * 2, c = Math.cos(theta), s = Math.sin(theta);
    for (let along = -800; along <= 800; along += 57) {
      const n = 96 + 9 * Math.sin(along / 83);
      const x = c * n - s * along, z = s * n + c * along;
      assert.ok(field.bridgeMaskAt(x, z) >= 3.6 - 1e-10);
      assert.equal(field.supportAt(x, z), field.surfaceAt(x, z) !== Surface.Pit, `seed ${seed}, along ${along}`);
      assert.equal(field.supportAt(field.routeX(z), z), true);
      const d = x - field.routeX(z), route = 4.1 - Math.abs(d - Math.round(d / 32) * 32);
      if (route >= 3.59) continue; // At intersections the dominant route owns heading.
      const heading = field.bridgeAngleAt(x, z), step = 0.01;
      const dn = 9 * (Math.sin((along + step) / 83) - Math.sin((along - step) / 83));
      const tx = c * dn - s * 2 * step, tz = s * dn + c * 2 * step;
      const dot = (-Math.sin(heading) * tx + Math.cos(heading) * tz) / Math.hypot(tx, tz);
      assert.ok(dot > 1 - 1e-10, "heading matches numerical curved-path tangent");
      const sector = Math.floor(((heading + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4));
      sectors.add(sector);
      if (field.surfaceAt(x, z) === Surface.Bridge) bridgeSectors.add(sector);
      checked++;
    }
  }
  assert.ok(checked > 1000); assert.equal(sectors.size, 8); assert.equal(bridgeSectors.size, 8);
  field.seed = 1979;
  assert.equal(field.bridgeMaskAt(133, -277), new LandscapeField(1979).bridgeMaskAt(133, -277));
  assert.equal(field.bridgeAngleAt(133, -277), new LandscapeField(1979).bridgeAngleAt(133, -277));
});

test("warped triangles interpolate heights and clipping scalars at both diagonals and world signs", () => {
  const field = new LandscapeField(1979);
  for (const origin of [0, -250000, 250000]) for (let j = -4; j <= 4; j++) {
    const ix = origin + j, iz = -origin + j * 3;
    assert.ok(Math.hypot(field.gridX(ix, iz) - ix * 4, field.gridZ(ix, iz) - iz * 4) <= 0.85);
    for (const indices of [[[ix, iz], [ix + 1, iz], [ix, iz + 1]], [[ix + 1, iz + 1], [ix, iz + 1], [ix + 1, iz]]]) {
      const points = indices.map(([i, k]) => [field.gridX(i, k), field.gridZ(i, k)]);
      const cx = points.reduce((s, p) => s + p[0], 0) / 3, cz = points.reduce((s, p) => s + p[1], 0) / 3;
      for (const weights of [[0.2, 0.3, 0.5], [0.8, 0.1, 0.1], [0, 0.4, 0.6], [1, 0, 0]]) {
        const x = points.reduce((s, p, i) => s + p[0] * weights[i], 0);
        const z = points.reduce((s, p, i) => s + p[1] * weights[i], 0);
        const expected = points.reduce((s, p, i) => s + field.vertexHeight(p[0], p[1]) * weights[i], 0);
        assert.ok(Math.abs(field.heightAt(x, z) - expected) < 1e-7);
        const hazard = points.reduce((s, p, i) => s + field.hazardAt(p[0], p[1]) * weights[i], 0);
        const bridge = points.reduce((s, p, i) => s + field.bridgeMaskAt(p[0], p[1]) * weights[i], 0);
        if (weights.every(w => w > 0)) {
          assert.equal(field.hazardKindAt(x, z), field.hazardKindAt(cx, cz));
          const kind = field.hazardKindAt(cx, cz);
          assert.equal(field.surfaceAt(x, z), hazard <= 0 ? Surface.Land : kind === Surface.Pit ? Surface.Pit : bridge > 0 ? Surface.Bridge : kind);
        }
      }
    }
  }
});

test("bridge plank coordinates do not tear between adjacent faces at million-metre origins", () => {
  const field = new LandscapeField(1979);
  for (const origin of [-1000000, 1000000]) {
    for (let i = 0; i < 200; i++) {
      const z = origin + i * 0.41, x = field.routeX(z, Math.round(origin / 32));
      // Route centre dominates away from intersections, where two grain
      // directions deliberately join. Equal references select the same family.
      const a = field.bridgePlankAt(x, z, x - 0.02, z - 0.02),
        b = field.bridgePlankAt(x, z, x + 0.02, z + 0.02);
      if (Math.abs(field.bridgeAngleAt(x - 0.02, z - 0.02)) < 0.09 && Math.abs(field.bridgeAngleAt(x + 0.02, z + 0.02)) < 0.09)
        assert.ok(Math.abs(a - b) < 1e-8);
      const next = field.bridgePlankAt(x + 0.1, z + 0.2, x, z);
      assert.ok(Math.abs(next - field.bridgePlankAt(x, z, x, z)) <= Math.hypot(0.1, 0.2) + 1e-8);
    }
  }
});

test("desert-majority field distribution, scaled relief, startup and stable resets", (t) => {
  const field = new LandscapeField(), counts = [0, 0, 0];
  let n = 0, low = 0, high = 0, maximum = -Infinity, minimum = Infinity, maxSlope = 0;
  for (const seed of [1, 23, 1979, 98541]) {
    field.reset(seed);
    for (let z = -3200; z < 3200; z += 71) for (let x = -3200; x < 3200; x += 67) {
      counts[field.biomeAt(x, z)]++; n++;
      const h = field.vertexHeight(x, z);
      maximum = Math.max(maximum, h); minimum = Math.min(minimum, h);
      if (Math.abs(h) < 3) low++;
      if (h > 25) high++;
      maxSlope = Math.max(maxSlope, Math.abs(field.heightAt(x + 1, z) - field.heightAt(x, z)));
      assert.ok(h >= -16.6 && h <= 42);
    }
    for (let angle = 0; angle < Math.PI * 2; angle += 0.1) {
      assert.equal(field.heightAt(18 * Math.cos(angle), 18 * Math.sin(angle)), 0);
      assert.equal(field.surfaceAt(36 * Math.cos(angle), 36 * Math.sin(angle)), Surface.Land);
    }
  }
  const fractions = counts.map(c => c / n);
  t.diagnostic(`biomes ${fractions.map(f => (f * 100).toFixed(2)).join("/")}%; low relief ${(100 * low / n).toFixed(2)}%; heights ${minimum.toFixed(2)}..${maximum.toFixed(2)}m; slope ${maxSlope.toFixed(3)}`);
  assert.ok(fractions[Biome.Desert] >= 0.91 && fractions[Biome.Desert] <= 0.95);
  for (const biome of [Biome.Lava, Biome.Meadow]) assert.ok(fractions[biome] >= 0.02 && fractions[biome] <= 0.05);
  assert.ok(low / n > 0.85 && low / n < 0.95 && high / n > 0.005 && high / n < 0.025 && maximum > 40 && minimum < -10);
  assert.ok(maxSlope > 0.6 && maxSlope < 1.5);
  field.reset(23); const h = field.heightAt(-1000000.1, 1000000.3);
  field.reset(1); field.reset(23); assert.equal(field.heightAt(-1000000.1, 1000000.3), h);
});

test("curved routes stay supported and bridge samples preserve underlying bed", () => {
  const field = new LandscapeField();
  const sample = {} as LandscapeSample;
  const seen = new Set<Surface>(); let oblique = false;
  for (const seed of [1, 23, 1979]) {
    field.reset(seed);
    for (let z = -1200; z < 1200; z += 3.7) for (const corridor of [-4, 0, 4]) {
      assert.equal(field.supportAt(field.routeX(z, corridor), z), true);
    }
    for (let z = -400; z < 400; z += 5.3) for (let x = -400; x < 400; x += 5.7) {
      assert.equal(field.sample(x, z, sample), sample);
      seen.add(sample.surface);
      assert.equal(sample.waterLevel, sample.height - 0.9);
      assert.equal(sample.floor, sample.surface === Surface.Land ? sample.height : sample.height - (sample.surface === Surface.Pit ? 14 : 4.8));
      assert.equal(field.supportAt(x, z), sample.surface === Surface.Land || sample.surface === Surface.Bridge);
      if (sample.surface === Surface.Bridge && Math.abs(field.bridgeAngleAt(x, z)) > 0.5) oblique = true;
    }
  }
  assert.equal(seen.size, 5); assert.ok(oblique);
  field.enabled = false;
  assert.equal(field.heightAt(-1000000.5, 1000000.3), 0);
  assert.equal(field.surfaceAt(100, 100), Surface.Land);
  assert.equal(field.gridX(-12, 9), -48);
});

test("lava contours vary in shape and linear diameter within the old-to-sixfold cap", (t) => {
  const field = new LandscapeField(1979), base = Tuning.landscape.biomeSize * 0.085;
  let smallest = Infinity, largest = 0, irregular = 0, candidates = 0, enabled = 0;
  for (let gz = -20; gz <= 20; gz++) for (let gx = -20; gx <= 20; gx++) {
    if (field.hash(gx, gz, 9) >= 0.5) continue;
    candidates++;
    enabled += +(field.hash(gx, gz, 205) < 1 / 3);
    const px = (gx + 0.15 + 0.7 * field.hash(gx, gz, 2)) * Tuning.landscape.biomeSize;
    const pz = (gz + 0.15 + 0.7 * field.hash(gx, gz, 3)) * Tuning.landscape.biomeSize;
    let min = Infinity, max = 0;
    for (let i = 0; i < 32; i++) {
      const a = i * Math.PI / 16;
      // At a fixed angle the signed field is radius minus radial distance.
      const radius = field.lavaPatchMaskAt(px + base * Math.cos(a), pz + base * Math.sin(a), gx, gz) + base;
      assert.ok(radius >= base - 1e-9 && radius <= base * 6 + 1e-9);
      assert.ok(Math.abs(field.lavaPatchMaskAt(px + radius * Math.cos(a), pz + radius * Math.sin(a), gx, gz)) < 1e-8);
      min = Math.min(min, radius); max = Math.max(max, radius);
    }
    assert.ok(max / min > 1.1, "even the smallest patches have a visible noncircular contour");
    if (max / min > 1.4) irregular++;
    smallest = Math.min(smallest, max / base); largest = Math.max(largest, max / base);
  }
  t.diagnostic(`lava maximum radial scales ${smallest.toFixed(2)}..${largest.toFixed(2)}; ${irregular} strongly irregular patches`);
  assert.ok(smallest < 1.4 && largest > 5 && irregular > 50);
  assert.ok(enabled / candidates > 0.28 && enabled / candidates < 0.38, "about one-third of deterministic lava candidates remain enabled");
});

test("second ravine family doubles generated footprints rather than widening old pits", (t) => {
  const field = new LandscapeField(23);
  let oldFootprints = 0, newFootprints = 0;
  for (let row = -10; row <= 10; row++) for (let column = -10; column <= 10; column++) {
    const z = row * 180, x = column * 150 - 11 * Math.sin(z / 53);
    for (const family of [0, 1]) {
      const originalX = family ? 91 - z : x, originalZ = family ? x - 73 : z;
      const cz = Math.floor(originalZ / 64) * 64 + 32;
      const route = field.routeX(cz), cx = route + (Math.floor((originalX - route) / 32) + 0.5) * 32;
      assert.ok(Math.abs(field.pitMaskAt(cx, cz, family) - 4) < 1e-10);
      // The complete bent rectangle survives relocation, with no route cuts.
      for (const dz of [-13.9, 0, 13.9]) for (const dx of [-3.9, 0, 3.9]) {
        const px = cx + dx - 10 * Math.sin(dz / 53), pz = cz + dz;
        assert.ok(field.pitMaskAt(px, pz, family) > 0);
        assert.equal(field.safeAt(px, pz, 8), false);
      }
      if (family) newFootprints++; else oldFootprints++;
    }
  }
  assert.equal(oldFootprints + newFootprints, oldFootprints * 2);
  let old = 0, second = 0, union = 0, newOnly = 0;
  for (let z = -1800; z < 1800; z += 2.71) for (let x = -1500; x < 1500; x += 3.17) {
    const baseline = field.pitMaskAt(x, z);
    const a = baseline > 0, b = field.pitMaskAt(x, z, 1) > 0;
    old += +a; second += +b; union += +(a || b); newOnly += +(!a && b);
  }
  t.diagnostic(`old pit samples ${old}; second ${second}; union ${(union / old).toFixed(3)}x; new-only ${newOnly}`);
  assert.ok(second / old > 0.95 && second / old < 1.05);
  assert.ok(union / old > 1.93 && union / old < 2.05);
});

test("dry pits survive every seed and world sign, reject bridge masks, and leave routes supported", (t) => {
  const field = new LandscapeField(), sample = {} as LandscapeSample;
  let maskedPits = 0, pits = 0;
  for (let seed = 1; seed <= 100; seed++) {
    field.reset(seed);
    for (const origin of [-1000000, -500, 1000000]) {
      let found = 0;
      for (let i = 0; i < 1000; i++) {
        const x = origin + (i % 40) * 4.7, z = origin + Math.floor(i / 40) * 7.3;
        if (field.surfaceAt(x, z) !== Surface.Pit) continue;
        found++; pits++;
        assert.equal(field.surfaceAt(x, z), Surface.Pit);
        assert.equal(field.supportAt(x, z), false);
        field.sample(x, z, sample);
        assert.equal(sample.floor, sample.height - 14);
        if (field.bridgeMaskAt(x, z) > 0) maskedPits++;
      }
      assert.ok(found > 0, `dry pits seed ${seed}, origin ${origin}`);
      for (let i = 0; i < 120; i++) {
        const z = origin + i * 2.3;
        for (const corridor of [-31250, -3, 0, 3, 31250])
          assert.equal(field.supportAt(field.routeX(z, corridor), z), true, `route seed ${seed}, z ${z}`);
      }
    }
  }
  t.diagnostic(`${pits} dry pit samples, ${maskedPits} with positive bridge masks; 180000 route centres supported`);
  assert.ok(maskedPits > 100, "rotated bridge masks still cross pits, but never supply support");
});

test("raw pit kind has no negative-mask band beside a river", () => {
  class RiverField extends LandscapeField {
    mask = -0.5;
    override pitMaskAt() { return this.mask; }
    override biomeAt() { return Biome.Meadow; }
    override hazardAt() { return 2; }
    override bridgeMaskAt() { return 2; }
  }
  const field = new RiverField();
  assert.equal(field.hazardKindAt(100, 100), Surface.Water);
  assert.equal(field.surfaceAt(100, 100), Surface.Bridge);
  field.mask = 0;
  assert.equal(field.hazardKindAt(100, 100), Surface.Water);
  field.mask = 0.01;
  assert.equal(field.hazardKindAt(100, 100), Surface.Pit);
  assert.equal(field.surfaceAt(100, 100), Surface.Pit);
  assert.equal(field.supportAt(100, 100), false);
});

test("early seeded foothills retain visible relief at one-third height", () => {
  const field = new LandscapeField();
  for (let seed = 1; seed <= 100; seed++) {
    field.reset(seed); let peak = 0;
    for (let z = 60; z <= 150; z += 10) for (let x = -70; x <= 70; x += 10) peak = Math.max(peak, field.heightAt(x, z));
    assert.ok(peak > 4 && peak <= 42, `visible early foothill for seed ${seed}: ${peak}`);
  }
});

test("new feature queries retain fixed storage, deterministic revisits and continuous cell seams", () => {
  const field = new LandscapeField(23), keys = Object.keys(field);
  const buffers = Object.values(field).filter(v => ArrayBuffer.isView(v));
  assert.equal(buffers.length, 1); assert.equal(buffers[0].byteLength, 64);
  for (let i = 0; i < 5000; i++) {
    const x = -1000000 + i * 403.17, z = 1000000 - i * 389.31;
    const height = field.heightAt(x, z);
    assert.equal(height, new LandscapeField(23).heightAt(x, z));
    for (const period of [48, 96, 320]) {
      const edge = Math.round(x / period) * period;
      assert.ok(Math.abs(field.vertexHeight(edge - 1e-6, z) - field.vertexHeight(edge + 1e-6, z)) < 0.0001);
    }
  }
  assert.deepEqual(Object.keys(field), keys);
  assert.deepEqual(Object.values(field).filter(v => ArrayBuffer.isView(v)), buffers);
  field.enabled = false; assert.equal(field.heightAt(100, 100), 0);
});

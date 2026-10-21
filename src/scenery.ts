import { MeshLambertMaterial, type Scene, type BufferGeometry } from "three";
import { InstancedObjectType } from "./object-renderer";
import { ObjectKind } from "./world";
import { Biome, Surface, type LandscapeField } from "./landscape";
import type { BiomeModels } from "./biome-models";
import type { ObjectVisibility } from "./camera";
import type { RenderPose } from "./render-pose";

const CAPACITY = 5696; // 1600 ordinary decorations + at most 4096 rim stones.

/** Cheap deterministic decorations are rebuilt only on 16m chunk crossings. */
export class Scenery {
  private readonly material = new MeshLambertMaterial({ vertexColors: true });
  private readonly geometries: BufferGeometry[] = [];
  private readonly banks: InstancedObjectType[] = [];
  private readonly x = new Float64Array(CAPACITY);
  private readonly z = new Float64Array(CAPACITY);
  private readonly y = new Float32Array(CAPACITY);
  private readonly angle = new Float32Array(CAPACITY);
  private readonly kinds = new Uint8Array(CAPACITY);
  private readonly radii = new Float32Array(13);
  private readonly heights = new Float32Array(13);
  private count = 0;
  private anchorX = Infinity;
  private anchorZ = Infinity;
  private seed = 0;
  private revision = -1;
  private enabled = false;
  visible = 0;
  constructor(
    private readonly field: LandscapeField,
    models: BiomeModels,
    scene: Scene,
  ) {
    const names = [
      "grass-0",
      "grass-1",
      "grass-2",
      "shrub-0",
      "flower-0",
      "reed-0",
      "stump-0",
      "rock-0",
      "rock-1",
      "rock-2",
      "rock-0",
      "rock-1",
      "rock-2",
    ];
    for (let i = 0; i < names.length; i++) {
      const geometry = models.get(names[i]).clone();
      // Three cached authored silhouettes also provide three distinct sizes.
      if (i >= 7) {
        const scale = i < 10 ? 0.28 : i === 10 ? 0.45 : i === 11 ? 0.8 : 1.2;
        geometry.scale(scale, scale, scale);
      }
      geometry.computeBoundingBox();
      const bounds = geometry.boundingBox!;
      this.radii[i] = Math.hypot(
        Math.max(Math.abs(bounds.min.x), Math.abs(bounds.max.x)),
        Math.max(Math.abs(bounds.min.z), Math.abs(bounds.max.z)),
      );
      this.heights[i] = bounds.max.y - Math.min(0, bounds.min.y);
      this.geometries.push(geometry);
      this.banks.push(
        new InstancedObjectType(
          ObjectKind.Enemy,
          [geometry],
          this.material,
          scene,
          undefined,
          i >= 10 ? 4096 : 1600,
        ),
      );
    }
  }
  update(pose: RenderPose, visibility: ObjectVisibility) {
    const ax = Math.floor(pose.x / 16) * 2,
      az = Math.floor(pose.z / 16) * 2;
    if (
      ax !== this.anchorX ||
      az !== this.anchorZ ||
      this.seed !== this.field.seed ||
      this.enabled !== this.field.enabled ||
      this.revision !== this.field.revision
    ) {
      this.anchorX = ax;
      this.anchorZ = az;
      this.seed = this.field.seed;
      this.enabled = this.field.enabled;
      this.count = 0;
      this.revision = this.field.revision;
      for (let iz = az - 13; iz <= az + 13; iz++)
        for (let ix = ax - 13; ix <= ax + 13; ix++) {
          const r = this.field.hash(ix, iz, 890),
            x = (ix + 0.15 + 0.7 * r) * 8,
            z = (iz + 0.15 + 0.7 * this.field.hash(ix, iz, 891)) * 8;
          if (this.field.surfaceAt(x, z) !== Surface.Land) continue;
          const biome = this.field.biomeAt(x, z),
            kind =
              biome === Biome.Meadow
                ? r < 0.45
                  ? Math.floor(r * 6)
                  : r < 0.67
                    ? 3
                    : r < 0.85
                      ? 4
                      : 6
                : biome === Biome.Lava
                  ? 8
                  : r < 0.15
                    ? 5
                    : 7 + Math.floor(r * 3);
          const i = this.count++;
          this.x[i] = x;
          this.z[i] = z;
          this.y[i] = this.field.heightAt(x, z);
          this.kinds[i] = kind;
          this.angle[i] = r * 6.283;
        }
      if (this.field.enabled) this.rebuildRims(ax, az);
    }
    for (const bank of this.banks) bank.begin();
    this.visible = 0;
    for (let i = 0; i < this.count; i++) {
      const x = this.x[i] - pose.x,
        z = this.z[i] - pose.z,
        kind = this.kinds[i], radius = this.radii[kind];
      if (
        x * x + z * z > 75 * 75 ||
        !visibility.intersects(x, z, radius, radius, this.heights[kind], this.y[i])
      )
        continue;
      this.banks[this.kinds[i]].place(0, x, -z, this.angle[i], this.y[i]);
      this.visible++;
    }
    for (const bank of this.banks) bank.finish();
  }
  /** Stateless world-lattice edge crossings: no contour objects or growing history.
   * Scan a guard beyond the 75m submission radius, including after chunk rebases.
   * The union avoids decorating an internal edge where the two families overlap. */
  private pitMask(x: number, z: number) {
    return Math.max(this.field.pitMaskAt(x, z), this.field.pitMaskAt(x, z, 1));
  }
  private rebuildRims(ax: number, az: number) {
    const limit = Math.min(CAPACITY, this.count + 4096);
    for (let iz = az * 4 - 52; iz <= az * 4 + 52; iz++)
      for (let ix = ax * 4 - 52; ix <= ax * 4 + 52; ix++) {
        const x = ix * 2, z = iz * 2, a = this.pitMask(x, z);
        for (let axis = 0; axis < 2; axis++) {
          const dx = axis === 0 ? 2 : 0, dz = axis === 1 ? 2 : 0;
          const b = this.pitMask(x + dx, z + dz);
          if ((a > 0) === (b > 0) || this.count >= limit) continue;
          const r = this.field.hash(ix, iz, 920 + axis);
          const kind = 10 + Math.min(2, Math.floor(r * 3));
          const radius = this.radii[kind], t = a / (a - b);
          const cx = x + dx * t, cz = z + dz * t;
          const gx = this.pitMask(cx + 0.25, cz) - this.pitMask(cx - 0.25, cz);
          const gz = this.pitMask(cx, cz + 0.25) - this.pitMask(cx, cz - 0.25);
          const length = Math.hypot(gx, gz);
          if (length < 1e-6) continue;
          const offset = radius + 0.35 + this.field.hash(ix, iz, 924 + axis) * 0.65;
          const scatter = (this.field.hash(ix, iz, 928 + axis) - 0.5) * 1.1;
          const px = cx - gx / length * offset - gz / length * scatter;
          const pz = cz - gz / length * offset + gx / length * scatter;
          // Conservative yaw-invariant footprint; reject interpolated pit/liquid
          // wedges too, rather than accepting a dry centre with submerged edges.
          let safe = this.pitMask(px, pz) < -radius;
          for (let probe = 0; probe < 9 && safe; probe++) {
            const sx = px + ((probe % 3) - 1) * radius;
            const sz = pz + (Math.floor(probe / 3) - 1) * radius;
            safe = this.field.surfaceAt(sx, sz) === Surface.Land;
          }
          if (!safe) continue;
          const i = this.count++;
          this.x[i] = px;
          this.z[i] = pz;
          this.y[i] = this.field.heightAt(px, pz);
          this.kinds[i] = kind;
          this.angle[i] = this.field.hash(ix, iz, 932 + axis) * Math.PI * 2;
        }
      }
  }
  dispose() {
    for (const b of this.banks) b.dispose();
    for (const g of this.geometries) g.dispose();
    this.material.dispose();
  }
}

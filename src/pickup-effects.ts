import * as THREE from "three";
import { GameEvent } from "./events";
import { ObjectKind } from "./world";
import type { Simulation } from "./simulation";
import type { ModelLibrary } from "./models";
import { Tuning } from "./tuning";
import { bonusKindForObject } from "./bonuses";

/** Bounded visual-only remnants. Rewards/collisions finish at contact, not fade. */
export class PickupEffects {
  private readonly active = new Uint8Array(32);
  private readonly kind = new Uint8Array(32);
  private readonly x = new Float64Array(32);
  private readonly z = new Float64Array(32);
  private readonly y = new Float32Array(32);
  private readonly born = new Float64Array(32);
  private readonly counts = new Uint8Array(10);
  private readonly matrix = new THREE.Matrix4();
  private readonly material = new THREE.MeshLambertMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    emissive: 0xffffff,
    emissiveIntensity: 0.025,
  });
  private readonly geometries: THREE.BufferGeometry[];
  private readonly fades: THREE.InstancedBufferAttribute[];
  readonly meshes: THREE.InstancedMesh[];
  private cursor = 0;
  private readonly off: (() => void)[];
  count = 0;
  firstAlpha = 0;
  firstY = 0;
  constructor(
    game: Simulation,
    models: Pick<ModelLibrary, "coin" | "diamond" | "heart">,
    private readonly scene: THREE.Scene,
  ) {
    this.material.onBeforeCompile = (shader) => {
      shader.vertexShader =
        "attribute float instanceFade;varying float vFade;\n" +
        shader.vertexShader.replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\nvFade=instanceFade;",
        );
      shader.fragmentShader =
        "varying float vFade;\n" +
        shader.fragmentShader.replace(
          "#include <color_fragment>",
          "#include <color_fragment>\ndiffuseColor.a*=vFade;",
        );
    };
    this.fades = Array.from({ length: 3 }, () =>
      new THREE.InstancedBufferAttribute(new Float32Array(32), 1).setUsage(
        THREE.DynamicDrawUsage,
      ),
    );
    this.geometries = [models.coin, models.diamond, models.heart].map(
      (geometry, i) => {
        const copy = geometry.clone();
        copy.setAttribute("instanceFade", this.fades[i]);
        return copy;
      },
    );
    this.meshes = this.geometries.map((geometry) => {
      const mesh = new THREE.InstancedMesh(geometry, this.material, 32);
      mesh.count = 0;
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      scene.add(mesh);
      return mesh;
    });
    this.off = [
      game.events.on(GameEvent.Start, () => {
        this.active.fill(0);
        this.count = this.cursor = 0;
      }),
      game.events.on(GameEvent.CollectedVisual, (slot) => {
        const kind = game.world.kinds[slot],
          bank =
            kind === ObjectKind.Coin
              ? 0
              : kind === ObjectKind.Diamond
                ? 1
                : kind === ObjectKind.Heart
                  ? 2
                  : bonusKindForObject(kind) === undefined ? -1 : 3 + bonusKindForObject(kind)!;
        if (bank < 0) return;
        if (!this.meshes[bank]) return;
        const i = this.cursor++ % 32;
        this.active[i] = 1;
        this.kind[i] = bank;
        this.x[i] = game.world.x[slot];
        this.z[i] = game.world.z[slot];
        this.y[i] = game.world.baseY[slot] + game.pickupMotion.bob;
        this.born[i] = game.feedbackTime;
      }),
    ];
  }
  /** Installed once during async model preload, never on a pickup/frame. */
  addBonuses(geometries: readonly THREE.BufferGeometry[]) {
    if (this.meshes.length !== 3 || geometries.length !== 7)
      throw new Error("Bonus pickup banks must be installed exactly once");
    for (const geometry of geometries) {
      const fade = new THREE.InstancedBufferAttribute(new Float32Array(32), 1)
        .setUsage(THREE.DynamicDrawUsage);
      const copy = geometry.clone();
      copy.setAttribute("instanceFade", fade);
      const mesh = new THREE.InstancedMesh(copy, this.material, 32);
      mesh.count = 0;
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.fades.push(fade);
      this.geometries.push(copy);
      this.meshes.push(mesh);
      this.scene.add(mesh);
    }
  }
  update(time: number, x: number, z: number, angle: number) {
    this.counts.fill(0);
    this.count = 0;
    for (let i = 0; i < 32; i++) {
      if (!this.active[i]) continue;
      const t = Math.max(0, (time - this.born[i]) / Tuning.effects.pickupFade);
      if (t >= 1) {
        this.active[i] = 0;
        continue;
      }
      const bank = this.kind[i],
        n = this.counts[bank]++;
      this.matrix.makeRotationY(angle + t * 0.7);
      this.matrix.setPosition(
        this.x[i] - x,
        this.y[i] + Tuning.effects.pickupLift * (1 - (1 - t) ** 2),
        z - this.z[i],
      );
      this.meshes[bank].setMatrixAt(n, this.matrix);
      this.fades[bank].setX(n, (1 - t) ** 1.5);
      if (this.count === 0) {
        this.firstAlpha = (1 - t) ** 1.5;
        this.firstY =
          this.y[i] + Tuning.effects.pickupLift * (1 - (1 - t) ** 2);
      }
      this.count++;
    }
    for (let i = 0; i < this.meshes.length; i++) {
      const mesh = this.meshes[i];
      mesh.count = this.counts[i];
      mesh.visible = mesh.count > 0;
      if (mesh.visible) {
        mesh.instanceMatrix.needsUpdate = true;
        this.fades[i].needsUpdate = true;
      }
    }
  }
  dispose() {
    for (const off of this.off) off();
    for (const mesh of this.meshes) {
      mesh.removeFromParent();
      mesh.dispose();
    }
    for (const geometry of this.geometries) geometry.dispose();
    this.material.dispose();
  }
}

import * as THREE from "three";
import { GameEvent } from "./events";
import type { Simulation } from "./simulation";
import type { ModelLibrary } from "./models";
import { Palette, Rules } from "./config";
import type { ObjectVisibility } from "./camera";
import { DeathMotion } from "./death-motion";
import { Tuning } from "./tuning";

export class AnimatedDinosaur {
  private readonly material = new THREE.MeshLambertMaterial({
    vertexColors: true,
    transparent: false,
    depthWrite: true,
  });
  readonly mesh: THREE.SkinnedMesh;
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions: THREE.AnimationAction[];
  frame = 0;
  state = "idle";
  private landedAt = -Infinity;
  groundLift = 0;
  private readonly death = new DeathMotion();
  private readonly leftFoot: THREE.Bone;
  private readonly rightFoot: THREE.Bone;
  private readonly off: (() => void)[];
  constructor(models: ModelLibrary, game: Simulation) {
    this.mesh = models.dinosaur;
    this.leftFoot = this.mesh.skeleton.bones.find(
      (b) => b.name === "dino-shin-l",
    )!;
    this.rightFoot = this.mesh.skeleton.bones.find(
      (b) => b.name === "dino-shin-r",
    )!;
    this.mesh.material = this.material;
    // Pitch/dive stays in the dinosaur's local frame while heading is unbounded.
    this.mesh.rotation.order = "YXZ";
    this.mixer = new THREE.AnimationMixer(this.mesh);
    this.actions = models.animations.map((clip) => {
      const action = this.mixer.clipAction(clip);
      action.setEffectiveTimeScale(0).play();
      return action;
    });
    this.mesh.frustumCulled = false;
    this.off = [
      game.events.on(GameEvent.Land, () => {
        this.landedAt = game.time;
      }),
      game.events.on(GameEvent.Start, () => {
        this.landedAt = -Infinity;
      }),
    ];
  }
  update(game: Simulation, alpha: number, animate = true, opacityMultiplier = 1) {
    const distance = THREE.MathUtils.lerp(
      game.previousDistance,
      game.distance,
      alpha,
    );
    const airborne = game.y > 0 || game.velocityY > 0;
    const dying =
      game.phase === "dying" ||
      (game.phase === "paused" &&
        !game.health.lives &&
        game.hitStopRemaining === 0);
    this.state = dying
      ? "dying"
      : game.hitStopRemaining > 0
        ? "hit"
        : game.phase === "over"
          ? "dead"
          : airborne
            ? game.diving
              ? "dive"
              : game.velocityY > 0
                ? "jump-up"
                : "jump-down"
            : game.crouch > 0
              ? "duck"
              : game.phase === "running"
                ? "run"
                : "idle";
    this.frame = (distance / (Rules.stepStride * 2)) % 1;
    const duckWeight = THREE.MathUtils.lerp(
      game.previousCrouch,
      game.crouch,
      alpha,
    );
    const airWeight = airborne
      ? Math.min(1, game.y / 0.15 + Math.abs(game.velocityY) / 20)
      : 0;
    if (animate && !dying)
      for (const action of this.actions) {
        const name = action.getClip().name;
        action.time =
          name === "run" || name === "duck"
            ? this.frame * action.getClip().duration
            : 0;
        const weight =
          game.hitStopRemaining > 0
            ? +(name === "hit")
            : game.phase === "over"
              ? +(name === "death")
              : name === "duck"
                ? duckWeight
                : name === "jump"
                  ? (1 - duckWeight) * airWeight
                  : name === "run"
                    ? (1 - duckWeight) * (1 - airWeight)
                    : 0;
        action.setEffectiveWeight(weight);
      }
    if (animate && !dying) this.mixer.update(0);
    this.mesh.position.set(
      0,
      THREE.MathUtils.lerp(
        game.previousGroundY + game.previousY,
        game.groundY + game.y,
        alpha,
      ) + this.groundLift,
      0,
    );
    this.mesh.rotation.set(
      game.bonuses.active(0)
        ? Math.PI / 2
        : airborne
        ? game.diving
          ? 0.18
          : game.velocityY > 0
            ? -0.055
            : 0.045
        : game.crouch * 0.12,
      THREE.MathUtils.lerp(game.previousHeading, game.heading, alpha),
      0,
    );
    const squash = Math.max(0, 1 - (game.time - this.landedAt) / 0.12) * 0.06;
    const duck =
      game.phase === "over"
        ? 0
        : THREE.MathUtils.lerp(game.previousCrouch, game.crouch, alpha);
    this.mesh.scale.set(
      1 + squash * 0.3 + duck * 0.12,
      1 - squash,
      1 + squash * 0.3 + duck * 0.12,
    );
    this.material.opacity =
      game.phase !== "over" &&
      game.hitStopRemaining === 0 &&
      game.health.immunity > 0 &&
      Math.floor((Rules.immunitySeconds - game.health.immunity) * 10) % 2 === 0
        ? 0.5
        : 1;
    if (dying) {
      this.death.sample(
        game.previousDeathTime +
          (game.deathTime - game.previousDeathTime) * alpha,
        game.heading,
        game.groundY + game.y + this.groundLift,
      );
      this.mesh.position.set(this.death.x, this.death.y, this.death.z);
      this.mesh.rotation.set(0, game.heading, this.death.roll);
      this.mesh.scale.setScalar(1);
      this.material.opacity = 1;
      if (game.falling) this.mesh.position.y -= game.deathTime * 5;
    }
    // Bonus transparency composes with immunity, including its original depth
    // behavior on expiry. Shared cosmetic materials follow the same opacity.
    this.material.opacity *= opacityMultiplier;
    this.material.depthWrite = opacityMultiplier === 1;
    if (this.material.transparent !== this.material.opacity < 1) {
      this.material.transparent = this.material.opacity < 1;
      this.material.needsUpdate = true;
    }
  }
  sampleContact(game: Simulation, side: number, out: THREE.Vector3) {
    this.update(game, 1, true);
    this.mesh.updateWorldMatrix(true, true);
    out
      .set(0, this.groundLift ? -0.39 : -0.34, -0.15)
      .applyMatrix4((side === 0 ? this.leftFoot : this.rightFoot).matrixWorld);
  }
  dispose() {
    for (const off of this.off) off();
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.mesh);
    this.material.dispose();
  }
}

/** Low-poly puffs, one instanced draw and a fixed particle pool. */
export class FootDust {
  private readonly geometry = new THREE.OctahedronGeometry(0.65, 0);
  private readonly material = new THREE.MeshLambertMaterial({
    color: Palette.dust,
  });
  readonly mesh = new THREE.InstancedMesh(this.geometry, this.material, 256);
  private readonly life = new Float32Array(256);
  private readonly worldX = new Float64Array(256);
  private readonly worldZ = new Float64Array(256);
  private readonly worldY = new Float32Array(256);
  private readonly driftX = new Float32Array(256);
  private readonly driftZ = new Float32Array(256);
  private readonly lift = new Float32Array(256);
  private readonly matrix = new THREE.Matrix4();
  private cursor = 0;
  private state = 1;
  private readonly foot = new THREE.Vector3();
  lastSide = 0;
  lastOriginX = 0;
  lastOriginZ = 0;
  private readonly off: (() => void)[];
  constructor(
    game: Simulation,
    private readonly reducedMotion: boolean,
    private readonly dinosaur?: AnimatedDinosaur,
  ) {
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.off = [
      game.events.on(GameEvent.Step, (side) =>
        this.emit(game, Tuning.effects.stepDust, side),
      ),
      game.events.on(GameEvent.Land, () => {
        this.emit(game, Tuning.effects.landDust / 2, 0);
        this.emit(game, Tuning.effects.landDust / 2, 1);
      }),
      game.events.on(GameEvent.Start, () => {
        this.life.fill(0);
        this.cursor = 0;
        this.state = game.seed || 1;
      }),
    ];
  }
  private emit(game: Simulation, amount: number, side: number) {
    if (this.reducedMotion) return;
    const sin = Math.sin(game.heading),
      cos = Math.cos(game.heading),
      sign = side === 0 ? -1 : 1;
    if (this.dinosaur) this.dinosaur.sampleContact(game, side, this.foot);
    else this.foot.set(sign * 0.22 * cos, 0.03, -sign * 0.22 * sin);
    const originX = game.x + this.foot.x,
      originZ = game.z - this.foot.z;
    this.lastSide = side;
    this.lastOriginX = originX;
    this.lastOriginZ = originZ;
    for (let n = 0; n < amount; n++) {
      const i = this.cursor++ % this.life.length;
      this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
      const spread = this.state / 4294967296 - 0.5;
      const variation = ((this.state >>> 16) & 255) / 255;
      this.life[i] = Tuning.effects.dustLife;
      this.worldX[i] = originX + spread * cos * 0.1;
      this.worldZ[i] = originZ + spread * sin * 0.1 + (variation - 0.5) * 0.1;
      this.worldY[i] = Math.max(game.groundY + 0.04, this.foot.y);
      this.lift[i] = 0.35 + variation * 0.9;
      this.driftX[i] = (sign * 0.45 + spread * 0.35) * cos + sin * 0.4;
      this.driftZ[i] = (sign * 0.45 + spread * 0.35) * sin - cos * 0.4;
    }
  }
  update(
    game: Simulation,
    dt: number,
    visibility: ObjectVisibility,
    renderX = game.x,
    renderDistance = game.z,
  ) {
    let count = 0;
    for (let i = 0; i < this.life.length; i++) {
      this.life[i] = Math.max(0, this.life[i] - dt);
      if (!this.life[i]) continue;
      const age = Math.max(0, Tuning.effects.dustLife - this.life[i]),
        size =
          ((0.22 + this.lift[i] * 0.1) * this.life[i]) /
          Tuning.effects.dustLife;
      const x = this.worldX[i] - renderX + this.driftX[i] * age;
      const z = renderDistance - this.worldZ[i] - this.driftZ[i] * age;
      const y = this.worldY[i] + age * this.lift[i];
      if (
        !visibility.intersects(x, -z, size / 2, size / 2, size, y - size / 2)
      ) {
        this.life[i] = 0;
        continue;
      }
      this.matrix.makeScale(size, size, size);
      this.matrix.setPosition(x, y, z);
      this.mesh.setMatrixAt(count++, this.matrix);
    }
    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
  dispose() {
    for (const off of this.off) off();
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}

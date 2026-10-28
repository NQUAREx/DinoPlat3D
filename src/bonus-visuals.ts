import * as THREE from "three";
import { BonusKind } from "./bonuses";
import { GameEvent } from "./events";
import type { BonusModels } from "./bonus-models";
import type { Simulation } from "./simulation";
import type { RenderPose } from "./render-pose";

const SMOKE_CAPACITY = 800, SMOKE_LIFE = .7;
const FLAME = new THREE.Color(0xff4b16), FLAME_TIP = new THREE.Color(0xffd52a), ASH = new THREE.Color(0x92999d);
const clamp = (value: number) => Math.max(0, Math.min(1, value));

/** Fixed visual resources, driven exclusively by active simulation time.
 * Geometry belongs to BonusModels; only materials/instances belong here. */
export class BonusVisuals {
  readonly backpack: THREE.Mesh;
  readonly turbo: THREE.Mesh;
  readonly smoke: THREE.InstancedMesh;
  private readonly attachmentMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
  private readonly smokeMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff });
  private readonly life = new Float32Array(SMOKE_CAPACITY);
  private readonly x = new Float64Array(SMOKE_CAPACITY);
  private readonly z = new Float64Array(SMOKE_CAPACITY);
  private readonly y = new Float32Array(SMOKE_CAPACITY);
  private readonly vx = new Float32Array(SMOKE_CAPACITY);
  private readonly vy = new Float32Array(SMOKE_CAPACITY);
  private readonly vz = new Float32Array(SMOKE_CAPACITY);
  private readonly matrix = new THREE.Matrix4();
  private readonly particleColor = new THREE.Color();
  private readonly nozzle = new THREE.Vector3();
  private readonly exhaustDirection = new THREE.Vector3();
  private readonly uploadRange = { start: 0, count: 0 };
  private readonly off: () => void;
  private cursor = 0;
  private emission = 0;
  private lastTime = NaN;
  private clock = 0;
  private previousX = NaN;
  private previousZ = NaN;
  private previousY = NaN;
  private disposed = false;
  fogStrength = 0;
  shakeStrength = 0;
  turboStrength = 0;

  constructor(models: BonusModels, private readonly avatar: THREE.SkinnedMesh,
    private readonly scene: THREE.Scene, game: Simulation, private readonly reducedMotion: boolean) {
    const torso = avatar.skeleton.bones.find(bone => bone.name === "dino-torso");
    if (!torso) throw new Error("Missing dinosaur torso for bonus attachments");
    this.backpack = new THREE.Mesh(models.pickups[BonusKind.Jetpack], this.attachmentMaterial);
    this.backpack.name = "bonus-backpack";
    this.backpack.scale.setScalar(.85);
    this.backpack.position.set(0, -.28, .39);
    this.backpack.visible = false;
    this.backpack.frustumCulled = false;
    torso.add(this.backpack);
    this.turbo = new THREE.Mesh(models.pickups[BonusKind.Turbo], this.attachmentMaterial);
    this.turbo.name = "bonus-turbo-cue";
    this.turbo.scale.setScalar(.55);
    this.turbo.position.set(-.4, -.16, .43);
    this.turbo.visible = false;
    this.turbo.frustumCulled = false;
    torso.add(this.turbo);
    this.smoke = new THREE.InstancedMesh(models.get("effect-smoke"), this.smokeMaterial, SMOKE_CAPACITY);
    this.smoke.name = "bonus-exhaust";
    this.smoke.count = 0;
    this.smoke.visible = false;
    this.smoke.frustumCulled = false;
    this.smoke.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.smoke);
    this.off = game.events.on(GameEvent.Start, () => this.reset());
  }

  avatarOpacity(game: Simulation): number {
    if (game.phase === "ready" || game.phase === "over" || !game.health.lives) return 1;
    return 1 - .78 * clamp(game.bonuses.strength(BonusKind.Invisibility));
  }

  /** Called after the camera rig has rebuilt its pose, so shake never accumulates.
   * The caller restores current day/night fog immediately before this method. */
  update(game: Simulation, pose: RenderPose, camera: THREE.PerspectiveCamera, alpha: number): void {
    if (this.disposed) return;
    if (game.phase === "ready" || game.phase === "over" || !game.health.lives) this.reset();
    const time = game.previousTime + (game.time - game.previousTime) * alpha;
    const dt = game.phase === "running" && !game.hitStopRemaining && Number.isFinite(this.lastTime)
      ? Math.max(0, Math.min(.1, time - this.lastTime)) : 0;
    this.lastTime = time;
    this.clock += dt;
    const inRun = game.health.lives > 0 && (game.phase === "running" || game.phase === "paused");
    const bonuses = game.bonuses;
    const jet = inRun && bonuses.active(BonusKind.Jetpack);
    this.backpack.visible = jet && this.avatar.visible;
    this.turboStrength = inRun ? clamp(bonuses.strength(BonusKind.Turbo)) : 0;
    this.turbo.visible = this.turboStrength > 0 && this.avatar.visible;
    // A static bolt remains readable with reduced motion. A small scale pulse
    // otherwise uses the same paused/frozen clock as smoke and shake.
    this.turbo.scale.setScalar(.55 * (1 + (this.reducedMotion ? 0 : .08 * Math.sin(this.clock * 16))));
    const opacity = (this.avatar.material as THREE.Material).opacity;
    const transparent = opacity < 1;
    if (this.attachmentMaterial.transparent !== transparent) {
      this.attachmentMaterial.transparent = transparent;
      this.attachmentMaterial.needsUpdate = true;
    }
    this.attachmentMaterial.opacity = opacity;
    this.attachmentMaterial.depthWrite = this.avatarOpacity(game) === 1;

    // Exponential arrival plus BonusState's smooth expiry envelope; snap the
    // tiny tail to zero so normal day/night fog is restored exactly.
    const fogTarget = inRun ? clamp(bonuses.strength(BonusKind.Blindness)) : 0;
    this.fogStrength += (fogTarget - this.fogStrength) * (1 - Math.exp(-dt / .12));
    if (!fogTarget && this.fogStrength < .001) this.fogStrength = 0;
    const fog = this.scene.fog as THREE.Fog;
    fog.color.multiplyScalar(1 - this.fogStrength);
    fog.near = THREE.MathUtils.lerp(fog.near, 9, this.fogStrength);
    fog.far = THREE.MathUtils.lerp(fog.far, 16, this.fogStrength);

    this.shakeStrength = inRun && !this.reducedMotion ? clamp(bonuses.strength(BonusKind.Shake)) : 0;
    if (this.shakeStrength || (jet && !this.reducedMotion)) {
      const strength = Math.max(this.shakeStrength, jet ? .25 : 0), t = this.clock;
      const flightShake = jet ? 2 : 1;
      camera.translateX(Math.sin(t * 49) * .16 * strength * flightShake);
      camera.translateY(Math.sin(t * 61) * .09 * strength * flightShake);
      camera.rotateZ(Math.sin(t * 43) * .035 * strength * flightShake);
      camera.rotateY(Math.sin(t * 37) * .018 * strength * flightShake);
      camera.updateMatrixWorld();
    }

    const height = this.avatar.position.y;
    const carry = Math.max(0, 1 - 8 / Math.max(1, game.speed));
    const dx = dt > 0 && Number.isFinite(this.previousX) ? (pose.x - this.previousX) * carry : 0;
    const dz = dt > 0 && Number.isFinite(this.previousZ) ? (pose.z - this.previousZ) * carry : 0;
    const dy = dt > 0 && Number.isFinite(this.previousY) ? (height - this.previousY) * .85 : 0;
    this.previousX = pose.x; this.previousZ = pose.z; this.previousY = height;
    // Carry the exhaust with the runner, leaving at most ~8m/s of backward
    // slip: even at maximum flight speed the .7s trail stays near the nozzles.
    for (let i = 0; i < SMOKE_CAPACITY; i++) {
      this.life[i] = Math.max(0, this.life[i] - dt);
      if (this.life[i]) { this.x[i] += dx; this.z[i] += dz; this.y[i] += dy; }
    }
    if (jet && dt > 0 && !this.reducedMotion) {
      this.backpack.updateWorldMatrix(true, false);
      this.exhaustDirection.set(0, -1, 0).transformDirection(this.backpack.matrixWorld);
      this.emission += dt * 500;
      // At most three pairs per update; the fixed circular pool cannot grow.
      const pairs = Math.min(50, Math.floor(this.emission));
      this.emission -= pairs;
      for (let pair = 0; pair < pairs; pair++) for (let side = 0; side < 2; side++) {
        const i = this.cursor++ % SMOKE_CAPACITY;
        this.nozzle.set(side ? .19 : -.19, 0, 0).applyMatrix4(this.backpack.matrixWorld);
        this.life[i] = SMOKE_LIFE;
        this.x[i] = pose.x + this.nozzle.x;
        this.z[i] = pose.z - this.nozzle.z;
        this.y[i] = this.nozzle.y;
        this.vx[i] = this.exhaustDirection.x * 1.6;
        this.vy[i] = this.exhaustDirection.y * 1.6;
        this.vz[i] = this.exhaustDirection.z * 1.6;
      }
    } else if (!jet) this.emission = 0;
    let count = 0;
    for (let i = 0; i < SMOKE_CAPACITY; i++) {
      if (!this.life[i]) continue;
      const age = SMOKE_LIFE - this.life[i];
      const phase = age / SMOKE_LIFE;
      const size = (.11 * (1 - phase) + .0175) * Math.min(1, this.life[i] / .12);
      const x = this.x[i] - pose.x + this.vx[i] * age;
      const y = this.y[i] + this.vy[i] * age + age * age * .3;
      const z = pose.z - this.z[i] + this.vz[i] * age;
      // Avoid an old world-anchored puff filling the foreground when the camera
      // travels through the trail (especially during a first-person transition).
      if ((x - camera.position.x) ** 2 + (y - camera.position.y) ** 2 +
          (z - camera.position.z) ** 2 < .6 ** 2) continue;
      this.matrix.makeScale(size, size, size);
      this.matrix.setPosition(x, y, z);
      this.smoke.setMatrixAt(count++, this.matrix);
      this.particleColor.copy(phase < .07 ? FLAME : FLAME_TIP).lerp(
        phase < .07 ? FLAME_TIP : ASH,
        phase < .07 ? phase / .07 : Math.min(1, (phase - .07) / .13),
      );
      this.smoke.setColorAt(count - 1, this.particleColor);
    }
    this.smoke.count = count;
    this.smoke.visible = count > 0;
    if (count) {
      this.uploadRange.count = count * 16;
      this.smoke.instanceMatrix.updateRanges[0] = this.uploadRange;
      this.smoke.instanceMatrix.updateRanges.length = 1;
      this.smoke.instanceMatrix.needsUpdate = true;
      if (this.smoke.instanceColor) this.smoke.instanceColor.needsUpdate = true;
    }
  }

  reset(): void {
    this.life.fill(0);
    this.cursor = this.emission = this.clock = 0;
    this.lastTime = NaN;
    this.previousX = this.previousZ = this.previousY = NaN;
    this.fogStrength = this.shakeStrength = this.turboStrength = 0;
    this.backpack.visible = this.turbo.visible = this.smoke.visible = false;
    this.smoke.count = 0;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.off();
    this.reset();
    this.backpack.removeFromParent();
    this.turbo.removeFromParent();
    this.smoke.removeFromParent();
    this.smoke.dispose();
    this.attachmentMaterial.dispose();
    this.smokeMaterial.dispose();
  }
}

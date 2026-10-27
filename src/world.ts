import { Rules, GridMath } from "./config";
import colliders from "./assets/model-colliders.json";
import { Tuning } from "./tuning";
import { LandscapeField, Biome } from "./landscape";
import { BONUS_DEFINITIONS, bonusKindForObject } from "./bonuses";

export enum ObjectKind {
  Cactus,
  Coin,
  Diamond,
  Enemy = 4,
  Heart,
  Tree,
  DeadTree,
  Rock,
  Log,
  Bird,
  Tumbleweed,
  Jetpack = 12,
  Invisibility = 13,
  Magnet = 14,
  Blindness = 15,
  Turbo = 16,
  Reverse = 17,
  Shake = 18,
}
export interface ColliderDefinition {
  readonly baseY?: number;
  readonly halfX: number;
  readonly halfZ: number;
  readonly height: number;
}
/** Metadata for a future destruction system; no break/damage action is implemented. */
export interface DestructionDefinition {
  readonly hitPoints: number;
  readonly debrisId: string;
}
export interface ObjectDefinition {
  readonly kind: ObjectKind;
  readonly weight: number;
  readonly blocking: boolean;
  readonly walkable?: boolean;
  readonly colliders: readonly ColliderDefinition[];
  readonly reward?: number;
  readonly healing?: number;
  readonly spawnGroup?: "pickup";
  readonly animation?: "spin-bob";
  readonly destruction?: DestructionDefinition;
}

export class ObjectRegistry {
  private readonly definitions: ObjectDefinition[] = [];
  private readonly byKind = new Map<ObjectKind, ObjectDefinition>();
  private totalWeight = 0;
  private pickupWeight = 0;
  register(definition: ObjectDefinition) {
    if (
      this.byKind.has(definition.kind) ||
      !Number.isInteger(definition.kind) ||
      definition.kind < 0 ||
      definition.kind > 255 ||
      !Number.isFinite(definition.weight) ||
      definition.weight < 0 ||
      (definition.healing !== undefined &&
        (!Number.isSafeInteger(definition.healing) ||
          definition.healing <= 0)) ||
      !definition.colliders.length ||
      definition.colliders.length > 256 ||
      definition.colliders.some(
        (bounds) =>
          !Number.isFinite(bounds.halfX) ||
          !Number.isFinite(bounds.halfZ) ||
          !Number.isFinite(bounds.height) ||
          !Number.isFinite(bounds.baseY ?? 0) ||
          bounds.halfX <= 0 ||
          bounds.halfZ <= 0 ||
          bounds.height <= 0,
      )
    )
      throw new Error("Invalid/duplicate world object definition");
    const entry = Object.freeze({
      ...definition,
      walkable: definition.walkable ?? false,
      colliders: definition.colliders.map((bounds) =>
        Object.freeze({ ...bounds }),
      ),
    });
    this.definitions.push(entry);
    this.byKind.set(entry.kind, entry);
    if (entry.spawnGroup === "pickup") this.pickupWeight += entry.weight;
    else this.totalWeight += entry.weight;
  }
  get(kind: ObjectKind) {
    return this.byKind.get(kind);
  }
  setWeight(kind: ObjectKind, weight: number) {
    if (!Number.isFinite(weight) || weight < 0) throw Error("Invalid weight");
    const old = this.byKind.get(kind);
    if (!old) return;
    const next = Object.freeze({ ...old, weight });
    this.definitions[this.definitions.indexOf(old)] = next;
    this.byKind.set(kind, next);
    this.totalWeight = this.pickupWeight = 0;
    for (const definition of this.definitions)
      if (definition.spawnGroup === "pickup")
        this.pickupWeight += definition.weight;
      else this.totalWeight += definition.weight;
  }
  pick(random: number, pickup = false) {
    let value = random * (pickup ? this.pickupWeight : this.totalWeight);
    for (const definition of this.definitions) {
      if ((definition.spawnGroup === "pickup") !== pickup) continue;
      if (!definition.weight) continue;
      value -= definition.weight;
      if (value < 0) return definition;
    }
    return undefined;
  }
  static defaults() {
    const registry = new ObjectRegistry();
    registry.register({
      kind: ObjectKind.Cactus,
      weight: 1,
      blocking: true,
      colliders: colliders.map((b) => ({
        halfX: b.halfX * Rules.cactusScale,
        halfZ: b.halfZ * Rules.cactusScale,
        height: b.height * Rules.cactusScale,
      })),
    });
    // Rotation-invariant envelope for all authored voxel models and bobbing.
    const pickup = [{ halfX: 0.46, halfZ: 0.46, height: 0.75, baseY: 0.5 }];
    registry.register({
      kind: ObjectKind.Coin,
      weight: 250,
      blocking: false,
      colliders: pickup,
      reward: 1,
      spawnGroup: "pickup",
      animation: "spin-bob",
    });
    registry.register({
      kind: ObjectKind.Diamond,
      weight: 10,
      blocking: false,
      colliders: pickup,
      reward: 1,
      spawnGroup: "pickup",
      animation: "spin-bob",
    });
    registry.register({
      kind: ObjectKind.Heart,
      weight: 1,
      blocking: false,
      colliders: pickup,
      healing: 1,
      spawnGroup: "pickup",
      animation: "spin-bob",
    });
    registry.register({
      kind: ObjectKind.Enemy,
      weight: 0,
      blocking: true,
      colliders: pickup,
    });
    for (const bonus of BONUS_DEFINITIONS)
      registry.register({
        kind: ObjectKind.Jetpack + bonus.kind,
        weight: bonus.weight,
        blocking: false,
        colliders: pickup,
        spawnGroup: "pickup",
        animation: "spin-bob",
      });
    for (const [kind, height, radius, count] of [
      [ObjectKind.Tree, 3.4, 0.58, 3],
      [ObjectKind.DeadTree, 3.1, 0.44, 3],
      [ObjectKind.Rock, 1.1, 0.7, 3],
      [ObjectKind.Log, 0.65, 1.0, 1],
      [ObjectKind.Bird, 0.38, 0.48, 1],
      [ObjectKind.Tumbleweed, 0.9, 0.45, 1],
    ])
      registry.register({
        kind,
        weight: 0,
        blocking: kind !== ObjectKind.Rock && kind !== ObjectKind.Log,
        walkable: kind === ObjectKind.Rock || kind === ObjectKind.Log,
        colliders: Array.from({ length: count }, () => ({
          halfX: radius,
          halfZ: radius,
          height,
        })),
      });
    return registry;
  }
}

/** Chunk keys are storage only. Multiple independent continuous points per chunk;
 * no rows, columns or quantization in the actual obstacle positions. */
export class WorldSpawner {
  readonly active = new Uint8Array(Rules.poolSize);
  readonly columns = new Float64Array(Rules.poolSize).fill(Infinity);
  readonly rows = new Float64Array(Rules.poolSize).fill(Infinity);
  readonly x = new Float64Array(Rules.poolSize);
  readonly z = new Float64Array(Rules.poolSize);
  readonly previousX = new Float64Array(Rules.poolSize);
  readonly previousZ = new Float64Array(Rules.poolSize);
  readonly previousBaseY = new Float32Array(Rules.poolSize);
  readonly kinds = new Uint8Array(Rules.poolSize);
  readonly variants = new Uint8Array(Rules.poolSize);
  readonly angles = new Float32Array(Rules.poolSize);
  readonly halfX = new Float32Array(Rules.poolSize);
  readonly halfZ = new Float32Array(Rules.poolSize);
  readonly height = new Float32Array(Rules.poolSize);
  readonly baseY = new Float32Array(Rules.poolSize);
  readonly lean = new Float32Array(Rules.poolSize);
  readonly fallStart = new Float64Array(Rules.poolSize).fill(-1);
  readonly motion = new Uint8Array(Rules.poolSize);
  /** Magnet coins use previousX/Z/BaseY for the same renderer interpolation as movers. */
  readonly magnetized = new Uint8Array(Rules.poolSize);
  private readonly velocityX = new Float32Array(Rules.poolSize);
  private readonly velocityZ = new Float32Array(Rules.poolSize);
  private readonly originalX = new Float32Array(Rules.poolSize);
  private readonly originalZ = new Float32Array(Rules.poolSize);
  private readonly originalHeight = new Float32Array(Rules.poolSize);
  private readonly dynamic = new Uint16Array(Rules.poolSize);
  private dynamicCount = 0;
  private readonly walkables = new Uint16Array(Rules.poolSize);
  private walkableCount = 0;
  private nextMovingTime = 0;
  radius = (Rules.maxColumns - 1) / 2;
  generated = 0;
  revision = 0;
  private seed = 1;
  private centerX = Infinity;
  private centerZ = Infinity;
  private encounterSpeed = Rules.startSpeed;
  constructor(
    readonly registry = ObjectRegistry.defaults(),
    readonly pickupRate?: number,
    readonly landscape?: LandscapeField,
  ) {}
  reset(seed: number) {
    this.seed = seed >>> 0 || 1;
    this.active.fill(0);
    this.motion.fill(0);
    this.magnetized.fill(0);
    this.lean.fill(0);
    this.fallStart.fill(-1);
    this.dynamicCount = 0;
    this.walkableCount = 0;
    this.nextMovingTime = 0;
    this.encounterSpeed = Rules.startSpeed;
    this.columns.fill(Infinity);
    this.rows.fill(Infinity);
    this.centerX = this.centerZ = Infinity;
    this.generated = 0;
    this.revision++;
  }
  setVisibleHalfWidth(width: number) {
    // Every heading must be resident before a turn reveals it. Numeric slots
    // only: full-volume camera culling happens before instance submission.
    const radius = Math.min(
      (Rules.maxColumns - 1) / 2,
      Math.max(7, Math.ceil(width / Rules.chunkSize) + 1),
    );
    if (radius !== this.radius) {
      this.radius = radius;
      this.centerX = Infinity;
    }
  }
  safeCenter(z: number, corridor = 0) {
    const phase = (this.seed % 4096) * 0.013;
    return (
      corridor * Tuning.generation.corridorSpacing +
      3 * (Math.sin(z / 48 + phase) - Math.sin(phase)) +
      2 * (Math.sin(z / 110 + phase * 2) - Math.sin(phase * 2))
    );
  }
  isRouteClear(x: number, z: number, halfX: number, halfZ: number) {
    const center = this.safeCenter(z);
    const spacing = Tuning.generation.corridorSpacing;
    const gap = Math.abs(
      x - center - Math.round((x - center) / spacing) * spacing,
    );
    // |route derivative| <= .081: Minkowski padding covers the full cactus,
    // avatar, 300ms delayed following and substep steering error, not just centres.
    return (
      gap <
      halfX +
        Rules.playerRadius +
        Tuning.generation.corridorPadding +
        0.081 * halfZ
    );
  }
  private random(column: number, row: number, candidate: number, salt: number) {
    return (
      GridMath.hash(
        column,
        row,
        this.seed ^ Math.imul(candidate + 1, 0x9e3779b9) ^ salt,
      ) / 4294967296
    );
  }
  update(worldX: number, distance: number, runSpeed = this.encounterSpeed) {
    this.encounterSpeed = runSpeed;
    const cx = Math.floor(worldX / Rules.chunkSize);
    const cz = Math.floor(distance / Rules.chunkSize);
    if (cx === this.centerX && cz === this.centerZ) return;
    this.centerX = cx;
    this.centerZ = cz;
    // Retire only cells outside a generous visible/entry window; no GPU objects.
    for (let i = 0; i < Rules.poolSize; i++)
      if (
        Math.abs(this.columns[i] - cx) > this.radius ||
        Math.abs(this.rows[i] - cz) > this.radius
      ) {
        this.active[i] = 0;
        this.columns[i] = this.rows[i] = Infinity;
      }
    for (let row = cz - this.radius; row <= cz + this.radius; row++)
      for (
        let column = cx - this.radius;
        column <= cx + this.radius;
        column++
      ) {
        const first =
          (GridMath.mod(row, Rules.rowSlots) * Rules.maxColumns +
            GridMath.mod(column, Rules.maxColumns)) *
          Rules.slotsPerChunk;
        if (this.columns[first] === column && this.rows[first] === row)
          continue;
        for (let candidate = 0; candidate < Rules.slotsPerChunk; candidate++)
          this.populate(first + candidate, column, row, candidate);
      }
    this.dynamicCount = 0;
    this.walkableCount = 0;
    for (let i = 0; i < this.active.length; i++) {
      if (this.active[i] && this.registry.get(this.kinds[i])?.walkable)
        this.walkables[this.walkableCount++] = i;
      if (
        this.active[i] &&
        (this.motion[i] === 1 ||
          this.kinds[i] === ObjectKind.Bird ||
          this.kinds[i] === ObjectKind.Tumbleweed)
      )
        this.dynamic[this.dynamicCount++] = i;
    }
    this.revision++;
  }
  private populate(
    slot: number,
    column: number,
    row: number,
    candidate: number,
  ) {
    this.columns[slot] = column;
    this.rows[slot] = row;
    this.active[slot] = 0;
    this.motion[slot] = 0;
    this.magnetized[slot] = 0;
    this.lean[slot] = 0;
    this.fallStart[slot] = -1;
    this.generated++;
    const pickup = candidate >= Rules.candidatesPerChunk;
    if (
      pickup &&
      this.random(column, row, candidate, 0x63f1) >=
        (this.pickupRate ?? Rules.pickupSpawnChance)
    )
      return;
    const x =
      (column + this.random(column, row, candidate, 0x311a)) * Rules.chunkSize;
    const z =
      (row + this.random(column, row, candidate, 0x741d)) * Rules.chunkSize;
    // Denser than old rows; fewer candidates per second as natural speed grows.
    // World-distance-based acceptance stays deterministic through slowdown/reentry.
    const radius = Math.hypot(x, z);
    const speed = Math.min(
      Rules.maxSpeed,
      Rules.startSpeed + radius * Tuning.generation.speedGrowth,
    );
    if (
      radius < (pickup ? Tuning.generation.pickupClearing : Rules.firstRow) ||
      this.random(column, row, candidate, 0x17f3) >
        (pickup ? 1 : 2) * (Tuning.generation.acceptance -
          (speed - Rules.startSpeed) * Tuning.generation.speedPenalty)
    )
      return;
    let definition = this.registry.pick(
      this.random(column, row, candidate, 0x8db3),
      pickup,
    );
    if (!definition) return;
    // Rare timed pickups use the existing one-shot slots, outside the opening.
    // No extra candidates or respawns when speed/input/effects change.
    if (bonusKindForObject(definition.kind) !== undefined && radius < 48) return;
    // Thin only new obstacle candidates, never already-visible objects or
    // pickups. Independent hash preserves deterministic visits at equal speed.
    const difficulty = Math.max(0, Math.min(1, (this.encounterSpeed - Rules.startSpeed) /
      Math.max(0.001, Rules.maxSpeed - Rules.startSpeed)));
    if (!pickup && this.random(column, row, candidate, 0x7051) < difficulty * Tuning.generation.highSpeedRelief)
      return;
    if (this.landscape?.enabled) {
      if (!this.landscape.supportAt(x, z)) return;
      if (definition.kind === ObjectKind.Cactus) {
        const biome = this.landscape.biomeAt(x, z),
          r = this.random(column, row, candidate, 0xa12c);
        const kind =
          r < Tuning.landscape.birdChance
            ? ObjectKind.Bird
            : r < 0.12 && biome === Biome.Desert
              ? ObjectKind.Tumbleweed
              : r < 0.15
                ? ObjectKind.Log
                : r < 0.17
                  ? ObjectKind.Rock
                  : biome === Biome.Meadow
                    ? ObjectKind.Tree
                    : biome === Biome.Lava
                      ? ObjectKind.DeadTree
                      : ObjectKind.Cactus;
        definition = this.registry.get(kind) ?? definition;
      }
    }
    const variant = Math.floor(
      this.random(column, row, candidate, 0x51ac) * definition.colliders.length,
    );
    const angle = this.random(column, row, candidate, 0xad27) * Math.PI * 2;
    const bounds = definition.colliders[variant],
      cos = Math.abs(Math.cos(angle)),
      sin = Math.abs(Math.sin(angle));
    this.kinds[slot] = definition.kind;
    this.variants[slot] = variant;
    this.angles[slot] = angle;
    this.x[slot] = x;
    this.z[slot] = z;
    if (definition.animation === "spin-bob") {
      // Authored pickup bounds already enclose every yaw. Do not rotate this
      // envelope again using the spawn angle (which the shared motion ignores).
      this.halfX[slot] = this.halfZ[slot] = Math.max(
        bounds.halfX,
        bounds.halfZ,
      );
    } else {
      this.halfX[slot] = bounds.halfX * cos + bounds.halfZ * sin;
      this.halfZ[slot] = bounds.halfZ * cos + bounds.halfX * sin;
    }
    this.height[slot] = bounds.height;
    this.baseY[slot] =
      (bounds.baseY ?? 0) +
      (this.landscape?.heightAt(x, z) ?? 0) +
      (definition.kind === ObjectKind.Bird ? 1.05 : 0);
    this.originalX[slot] = this.halfX[slot];
    this.originalZ[slot] = this.halfZ[slot];
    this.originalHeight[slot] = this.height[slot];
    if (
      this.landscape?.enabled &&
      (definition.kind === ObjectKind.Cactus ||
        definition.kind === ObjectKind.Tree ||
        definition.kind === ObjectKind.DeadTree) &&
      this.random(column, row, candidate, 0x8194) < Tuning.landscape.fallChance
    ) {
      this.motion[slot] =
        this.random(column, row, candidate, 0x6134) < 0.45 ? 2 : 1;
      if (this.isRouteClear(x, z, this.height[slot] + 1, this.height[slot] + 1))
        return;
      if (this.motion[slot] === 2) {
        this.lean[slot] = Math.PI / 2;
        this.updateFallBounds(slot);
      }
    }
    // Pickups must never be hidden inside a cactus. Check the deterministic
    // candidate field, not active slots (which depend on window/reentry order).
    // Conservative padding also excludes a few thinned/non-spawned candidates.
    if (pickup) {
      const cacti = this.registry.get(ObjectKind.Cactus);
      let reach = 0;
      if (cacti && cacti.weight > 0)
        for (const b of cacti.colliders)
          reach = Math.max(reach, Math.hypot(b.halfX, b.halfZ));
      if (reach > 0) {
        reach +=
          Math.hypot(bounds.halfX, bounds.halfZ) + Rules.playerRadius + 0.3;
        for (let rz = row - 1; rz <= row + 1; rz++)
          for (let cx = column - 1; cx <= column + 1; cx++)
            for (let n = 0; n < Rules.candidatesPerChunk; n++) {
              const nx =
                (cx + this.random(cx, rz, n, 0x311a)) * Rules.chunkSize;
              const nz =
                (rz + this.random(cx, rz, n, 0x741d)) * Rules.chunkSize;
              if ((nx - x) ** 2 + (nz - z) ** 2 < reach * reach) return;
            }
      }
    }
    if (
      (definition.blocking || definition.walkable) &&
      this.isRouteClear(x, z, this.halfX[slot], this.halfZ[slot])
    )
      return;
    // Deterministic hard-core thinning over this and neighbouring chunks avoids
    // interpenetrating clusters without storing an unbounded spatial index.
    if (definition.blocking || definition.walkable) {
      const priority = this.random(column, row, candidate, 0xa193);
      for (let rz = row - 1; rz <= row + 1; rz++)
        for (let cx = column - 1; cx <= column + 1; cx++)
          for (let n = 0; n < Rules.candidatesPerChunk; n++) {
            if (this.random(cx, rz, n, 0xa193) >= priority) continue;
            const nx = (cx + this.random(cx, rz, n, 0x311a)) * Rules.chunkSize;
            const nz = (rz + this.random(cx, rz, n, 0x741d)) * Rules.chunkSize;
            if ((nx - x) ** 2 + (nz - z) ** 2 < (Tuning.generation.spacing * 0.5) ** 2)
              return;
          }
    }
    this.previousX[slot] = this.collisionX(slot);
    this.previousZ[slot] = this.collisionZ(slot);
    this.previousBaseY[slot] = this.baseY[slot];
    if (definition.kind === ObjectKind.Tumbleweed) {
      this.motion[slot] = 3;
      this.velocityX[slot] = Math.sin(angle) * 7.5;
      this.velocityZ[slot] = Math.cos(angle) * 7.5;
      this.fallStart[slot] = 0;
    }
    this.active[slot] = 1;
  }
  /** Absolute support elevation; compact smooth mounds stay inside prop bounds. */
  walkHeightAt(x: number, z: number, baseHeight = this.landscape?.heightAt(x, z) ?? 0) {
    let height = baseHeight;
    for (let n = 0; n < this.walkableCount; n++) {
      const i = this.walkables[n];
      if (!this.active[i]) continue;
      if (Math.abs(x - this.x[i]) >= this.halfX[i] || Math.abs(z - this.z[i]) >= this.halfZ[i]) continue;
      const dx = (x - this.x[i]) / this.halfX[i],
        dz = (z - this.z[i]) / this.halfZ[i],
        r2 = dx * dx + dz * dz;
      if (r2 < 1) height = Math.max(height, this.baseY[i] + this.height[i] * (1 - r2) ** 2);
    }
    return height;
  }
  collisionX(i: number) {
    return (
      this.x[i] +
      Math.sin(this.angles[i]) *
        Math.sin(this.lean[i]) *
        this.originalHeight[i] *
        0.5
    );
  }
  collisionZ(i: number) {
    return (
      this.z[i] -
      Math.cos(this.angles[i]) *
        Math.sin(this.lean[i]) *
        this.originalHeight[i] *
        0.5
    );
  }
  private updateFallBounds(i: number) {
    const reach =
      this.originalHeight[i] * Math.abs(Math.sin(this.lean[i])) * 0.5;
    this.halfX[i] =
      this.originalX[i] + Math.abs(Math.sin(this.angles[i])) * reach;
    this.halfZ[i] =
      this.originalZ[i] + Math.abs(Math.cos(this.angles[i])) * reach;
    this.height[i] = Math.max(
      0.5,
      this.originalHeight[i] * Math.cos(this.lean[i]),
    );
  }
  step(time: number, dt: number, px: number, pz: number, heading: number, speed=Rules.startSpeed, viewHeading=heading, viewX=px, viewZ=pz) {
    if (!this.landscape?.enabled) return;
    const sin = -Math.sin(heading),
      cos = Math.cos(heading),
      facing = Number.isFinite(viewHeading) ? viewHeading : heading,
      viewSin = -Math.sin(facing), viewCos = Math.cos(facing),
      cameraX = Number.isFinite(viewX) ? viewX : px,
      cameraZ = Number.isFinite(viewZ) ? viewZ : pz;
    for (let n = 0; n < this.dynamicCount; n++) {
      const i = this.dynamic[n];
      if (!this.active[i]) continue;
      this.previousX[i] = this.collisionX(i);
      this.previousZ[i] = this.collisionZ(i);
      this.previousBaseY[i] = this.baseY[i];
      const dx = this.x[i] - px,
        dz = this.z[i] - pz,
        d2 = dx * dx + dz * dz;
      if (this.motion[i] === 1 && d2 < 24 * 24) {
        if (this.fallStart[i] < 0) this.fallStart[i] = time;
        const age = time - this.fallStart[i];
        this.lean[i] =
          age < 1.1
            ? 0.04 * Math.sin(age * 22)
            : Math.min(Math.PI / 2, (((age - 1.1) / 1.2) ** 2 * Math.PI) / 2);
        this.updateFallBounds(i);
        if (this.lean[i] >= Math.PI / 2) this.motion[i] = 2;
      }
      if (
        this.kinds[i] !== ObjectKind.Bird &&
        this.kinds[i] !== ObjectKind.Tumbleweed
      )
        continue;
      if (this.motion[i] === 0) {
        if (time < this.nextMovingTime) continue;
        const bird = this.kinds[i] === ObjectKind.Bird;
        if (bird) {
          // Slow approach keeps the overhead cue readable on small screens.
          if (d2 > 64 * 64 || d2 < 48 * 48) continue;
          const vx = this.x[i] - cameraX, vz = this.z[i] - cameraZ;
          const dot = (vx * viewSin + vz * viewCos) / Math.hypot(vx, vz);
          if (!(dot + Number.EPSILON * 4 >= Math.SQRT1_2)) continue;
          // A crouch-only attack must not coincide with a rolling jump hazard.
          // Predict nearby seeded tumbleweed paths before launching the bird.
          let groundThreat = false;
          for (let m = 0; m < this.dynamicCount; m++) {
            const j = this.dynamic[m];
            if (!this.active[j] || this.kinds[j] !== ObjectKind.Tumbleweed || this.motion[j] !== 3) continue;
            const rx = this.x[j] - px, rz = this.z[j] - pz,
              rvx = this.velocityX[j] - sin * speed, rvz = this.velocityZ[j] - cos * speed,
              vv = rvx * rvx + rvz * rvz,
              encounter = vv > 1e-9 ? Math.max(0, Math.min(5, -(rx * rvx + rz * rvz) / vv)) : 0;
            const closestX = rx + rvx * encounter, closestZ = rz + rvz * encounter;
            if (closestX * closestX + closestZ * closestZ < 2.5 * 2.5) {
              groundThreat = true; break;
            }
          }
          if (groundThreat) continue;
        } else if (d2 > 48 * 48 || d2 < 28 * 28 || dx * sin + dz * cos < -1e-9) continue;
        const inv = 1 / Math.sqrt(d2);
        this.velocityX[i] = bird ? -dx * inv * 9 : cos * 7.5;
        this.velocityZ[i] = bird ? -dz * inv * 9 : -sin * 7.5;
        this.angles[i] = Math.atan2(-this.velocityX[i], this.velocityZ[i]);
        this.motion[i] = 3;
        this.fallStart[i] = time;
        this.nextMovingTime = time + 5;
      }
      if (this.kinds[i] === ObjectKind.Bird && this.motion[i] === 3 && d2 <= 10 * 10) {
        // Solve |playerVelocity*t - birdOffset| = 9*t once at lock.
        // Keep the earliest positive intercept within one second; an escaping
        // runner with no reachable intercept leaves the existing course intact.
        const vx = sin * speed, vz = cos * speed,
          a = vx * vx + vz * vz - 9 * 9,
          b = -2 * (dx * vx + dz * vz),
          discriminant = b * b - 4 * a * d2;
        let intercept = Infinity;
        if (Math.abs(a) < 1e-9) {
          if (Math.abs(b) > 1e-9 && -d2 / b > 0) intercept = -d2 / b;
        } else if (discriminant >= 0) {
          const root = Math.sqrt(discriminant),
            first = (-b - root) / (2 * a),
            second = (-b + root) / (2 * a);
          if (first > 0) intercept = first;
          if (second > 0 && second < intercept) intercept = second;
        }
        if (intercept <= 1) {
          this.velocityX[i] = vx - dx / intercept;
          this.velocityZ[i] = vz - dz / intercept;
          this.angles[i] = Math.atan2(-this.velocityX[i], this.velocityZ[i]);
        }
        this.motion[i] = 4; // Fixed fly-through; never reacquire after a dodge.
      }
      if (this.motion[i] === 3 || this.motion[i] === 4) {
        if (this.kinds[i] === ObjectKind.Bird && this.motion[i] === 3) {
          // Track only at range; the last 10m are a dodgeable straight fly-through.
          const distance = Math.sqrt(d2),
            factor = distance > 0 ? Math.min(9, distance / dt) / distance : 0;
          this.velocityX[i] = -dx * factor;
          this.velocityZ[i] = -dz * factor;
          this.angles[i] = Math.atan2(-this.velocityX[i], this.velocityZ[i]);
        }
        this.x[i] += this.velocityX[i] * dt;
        this.z[i] += this.velocityZ[i] * dt;
        let ground = this.landscape.heightAt(this.x[i], this.z[i]);
        // The wing box reaches behind the bird's centre. On an uphill pass,
        // sampling only that centre lets its rear wing sweep into a crouching
        // runner. Clear the runner's supported ground throughout the encounter;
        // jumps do not raise this envelope and horizontal flight stays committed.
        if (this.kinds[i] === ObjectKind.Bird && d2 < 3 * 3)
          ground = Math.max(ground, this.walkHeightAt(px, pz, this.landscape.heightAt(px, pz)));
        this.baseY[i] = ground + (this.kinds[i] === ObjectKind.Bird ? 1.05 : 0);
        if (this.kinds[i] === ObjectKind.Bird
          ? time - this.fallStart[i] > 9 || d2 > 75 * 75
          : d2 > 115 * 115) this.active[i] = 0;
      }
    }
  }
  consume(slot: number) {
    this.active[slot] = 0;
    this.magnetized[slot] = 0;
  }
}

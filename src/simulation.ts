import { Rules } from "./config";
import { GameEvent, GameEvents } from "./events";
import { Currency, Health, Wallet } from "./progression";
import { ObjectKind, ObjectRegistry, WorldSpawner } from "./world";
import { PickupMotion } from "./pickup-motion";
import { Tuning } from "./tuning";
import { LandscapeField, Surface } from "./landscape";

export type Phase = "ready" | "running" | "dying" | "paused" | "over";
export const STEP = Rules.step;

/** Pure numerical simulation. World coordinates are Float64; the renderer uses
 * a moving player-centred origin before uploading any Float32 GPU positions. */
export class Simulation {
  readonly events = new GameEvents();
  readonly landscape = new LandscapeField();
  readonly wallet = new Wallet(this.events);
  readonly health = new Health(this.events);
  readonly pickupMotion = new PickupMotion();
  readonly world: WorldSpawner;
  phase: Phase = "ready";
  seed = 1;
  x = 0;
  previousX = 0;
  z = 0;
  previousZ = 0;
  y = 0;
  previousY = 0;
  groundY = 0;
  previousGroundY = 0;
  falling = false;
  fatalCause: Surface = Surface.Land;
  heading = 0;
  viewHeading = NaN;
  viewX = NaN;
  viewZ = NaN;
  previousHeading = 0;
  movingX = 0;
  steering = 0;
  velocityY = 0;
  private groundVelocity = 0;
  private jumpActive = false;
  diving = false;
  crouch = 0;
  previousCrouch = 0;
  crouchRemaining = 0;
  distance = 0;
  previousDistance = 0;
  /** Fair score distance; world distance continues driving movement/generation. */
  scoreDistance = 0;
  previousScoreDistance = 0;
  turnHoldElapsed = 0;
  scoreResumeRemaining = 0;
  scoreLocked = false;
  speed = Rules.startSpeed;
  runSpeed = Rules.startSpeed;
  terrainGrade = 0;
  slopeSpeedFactor = 1;
  time = 0;
  previousTime = 0;
  feedbackTime = 0;
  previousFeedbackTime = 0;
  hitStopRemaining = 0;
  deathTime = 0;
  previousDeathTime = 0;
  private nextFoot = 0;
  private previousBob = 0;
  private nextStep = 0;
  constructor(seed = 1, registry = ObjectRegistry.defaults()) {
    this.world = new WorldSpawner(registry, undefined, this.landscape);
    this.reset(seed);
  }
  reset(seed: number) {
    this.seed = seed >>> 0 || 1;
    this.phase = "ready";
    this.x = this.previousX = this.y = this.previousY = 0;
    this.z = this.previousZ = 0;
    this.heading = this.previousHeading = this.movingX = this.steering = 0;
    this.viewHeading = this.viewX = this.viewZ = NaN;
    this.velocityY = this.distance = this.previousDistance = this.time = 0;
    this.scoreDistance = this.previousScoreDistance = 0;
    this.turnHoldElapsed = this.scoreResumeRemaining = 0;
    this.scoreLocked = false;
    this.groundVelocity = 0;
    this.jumpActive = false;
    this.previousTime = this.previousBob = 0;
    this.feedbackTime = this.previousFeedbackTime = this.hitStopRemaining = 0;
    this.deathTime = this.previousDeathTime = 0;
    this.nextFoot = 0;
    this.landscape.reset(this.seed);
    this.groundY = this.previousGroundY = this.landscape.heightAt(0, 0);
    this.falling = false;
    this.fatalCause = Surface.Land;
    this.pickupMotion.update(0);
    this.diving = false;
    this.crouch = this.previousCrouch = this.crouchRemaining = 0;
    this.speed = Rules.startSpeed;
    this.runSpeed = Rules.startSpeed;
    this.terrainGrade = 0;
    this.slopeSpeedFactor = 1;
    this.nextStep = Rules.stepStride;
    this.world.reset(this.seed);
    this.world.update(0, 0);
    this.health.reset();
    this.events.emit(GameEvent.Start);
  }
  move(direction: number) {
    const next =
      this.phase === "running" && !this.hitStopRemaining
        ? Math.sign(direction)
        : 0;
    if (this.steering && !next) {
      if (this.scoreLocked)
        this.scoreResumeRemaining = Rules.turnScoreReleaseDelay;
      else this.turnHoldElapsed = 0;
    }
    this.steering = next;
  }
  jump() {
    if (
      this.phase !== "running" ||
      this.hitStopRemaining ||
      this.y !== 0 ||
      this.jumpActive ||
      this.falling
    )
      return;
    // Running uphill already has vertical momentum. Preserve it at take-off,
    // otherwise the rising surface catches the feet immediately after a jump.
    this.velocityY = Rules.jumpSpeed + this.groundVelocity;
    this.jumpActive = true;
    this.diving = false;
    this.crouch = this.previousCrouch = this.crouchRemaining = 0;
    this.events.emit(GameEvent.Jump);
  }
  get bodyHeight() {
    return (
      Rules.playerBodyHeight +
      (Rules.duckBodyHeight - Rules.playerBodyHeight) * this.crouch
    );
  }
  down() {
    if (this.phase !== "running" || this.hitStopRemaining) return;
    if (this.y > 0 || this.velocityY > 0 || this.jumpActive) {
      this.velocityY = Math.min(this.velocityY, -Rules.diveSpeed);
      if (!this.diving) this.events.emit(GameEvent.Dive);
      this.diving = true;
    } else {
      this.crouchRemaining = Rules.duckDuration;
      this.events.emit(GameEvent.Duck);
    }
  }
  step(dt: number) {
    if (this.phase === "dying") {
      this.previousDeathTime = this.deathTime;
      this.deathTime = Math.min(Rules.deathSeconds, this.deathTime + dt);
      this.previousFeedbackTime = this.feedbackTime;
      this.feedbackTime += dt;
      if (this.deathTime >= Rules.deathSeconds - 1e-9) this.phase = "over";
      return;
    }
    if (this.phase !== "running") return;
    this.previousFeedbackTime = this.feedbackTime;
    this.feedbackTime += dt;
    this.previousX = this.x;
    this.previousZ = this.z;
    this.previousY = this.y;
    this.previousGroundY = this.groundY;
    this.previousCrouch = this.crouch;
    this.previousHeading = this.heading;
    this.previousDistance = this.distance;
    this.previousScoreDistance = this.scoreDistance;
    this.previousTime = this.time;
    if (this.hitStopRemaining > 0) {
      this.hitStopRemaining = Math.max(0, this.hitStopRemaining - dt);
      if (this.hitStopRemaining < 1e-9) {
        this.hitStopRemaining = 0;
        if (!this.health.lives) this.phase = "dying";
      }
      return;
    }
    this.previousBob = this.pickupMotion.bob;
    this.time += dt;
    this.pickupMotion.update(this.time);
    this.health.step(dt);
    const ducking = this.crouchRemaining > 0;
    this.crouchRemaining = Math.max(0, this.crouchRemaining - dt);
    this.crouch +=
      Math.sign((ducking ? 1 : 0) - this.crouch) *
      Math.min(
        Math.abs((ducking ? 1 : 0) - this.crouch),
        Rules.duckBlendSpeed * dt,
      );
    // Unwrapped heading: releasing input preserves the new running direction.
    this.heading -= this.steering * Rules.turnSpeed * dt;
    this.movingX = -Math.sin(this.heading);
    const airborne =
      this.y > 0 || this.velocityY > 0 || this.jumpActive || this.diving || this.falling;
    let feet = this.groundY + this.y;
    if (airborne) {
      feet += this.velocityY * dt - (Rules.gravity * dt * dt) / 2;
      this.velocityY -= Rules.gravity * dt;
    }
    const moveSin = -Math.sin(this.heading), moveCos = Math.cos(this.heading),
      grade = (this.landscape.heightAt(this.x + moveSin, this.z + moveCos) -
        this.landscape.heightAt(this.x - moveSin, this.z - moveCos)) * 0.5;
    this.terrainGrade = grade;
    this.slopeSpeedFactor = 1 / Math.hypot(1, grade);
    const progress = Math.min(1, Math.max(0, this.distance * Tuning.generation.speedGrowth /
      Math.max(0.001, Rules.maxSpeed - Rules.startSpeed))),
      targetSpeed = Rules.startSpeed + (Rules.maxSpeed - Rules.startSpeed) * progress * progress * (3 - 2 * progress);
    if (this.health.immunity > 0) this.runSpeed = Rules.startSpeed;
    else this.runSpeed += (targetSpeed - this.runSpeed) * (1 - Math.exp(-dt / Tuning.generation.accelerationTime));
    this.speed = this.runSpeed * this.slopeSpeedFactor;
    this.distance += this.runSpeed * dt;
    let scoreDt = dt;
    if (this.steering !== 0) {
      scoreDt = this.scoreLocked
        ? 0
        : Math.min(dt, Math.max(0, Rules.turnScoreHoldLimit - this.turnHoldElapsed));
      this.turnHoldElapsed += dt;
      if (this.turnHoldElapsed >= Rules.turnScoreHoldLimit) {
        this.scoreLocked = true;
        this.scoreResumeRemaining = 0;
      }
    } else {
      this.turnHoldElapsed = 0;
      if (this.scoreLocked) {
        const wait = Math.min(dt, this.scoreResumeRemaining);
        scoreDt = Math.max(0, dt - wait);
        this.scoreResumeRemaining -= wait;
        if (this.scoreResumeRemaining <= 1e-9) {
          this.scoreResumeRemaining = 0;
          this.scoreLocked = false;
        }
      }
    }
    this.scoreDistance += this.runSpeed * scoreDt;
    const midHeading = (this.heading + this.previousHeading) * 0.5;
    this.x -= Math.sin(midHeading) * this.speed * dt;
    this.z += Math.cos(midHeading) * this.speed * dt;
    this.world.update(this.x, this.z, this.runSpeed);
    const terrain = this.landscape.heightAt(this.x, this.z),
      ground = this.world.walkHeightAt(this.x, this.z, terrain),
      surface = this.landscape.surfaceAt(this.x, this.z);
    const support = surface === Surface.Land || surface === Surface.Bridge;
    if (!this.falling) this.groundY = ground;
    if (!airborne && support) {
      this.y = 0;
      this.groundVelocity = dt > 0 ? (this.groundY - this.previousGroundY) / dt : 0;
    } else {
      this.groundVelocity = 0;
      this.y = feet - this.groundY;
      if (support && this.y <= 0 && !this.falling) {
        this.y = 0;
        this.velocityY = 0;
        this.jumpActive = false;
        this.diving = false;
        this.events.emit(GameEvent.Land);
      }
      if (!support && this.y <= 0) this.falling = true;
    }
    if (this.falling && this.y < -0.8) {
      this.fatalCause = surface;
      this.health.kill();
      this.phase = "dying";
      this.move(0);
      return;
    }
    this.world.step(this.time, dt, this.x, this.z, this.heading, this.speed,
      Number.isFinite(this.viewHeading) ? this.viewHeading : this.heading,
      Number.isFinite(this.viewX) ? this.viewX : this.x,
      Number.isFinite(this.viewZ) ? this.viewZ : this.z);
    this.collisions();
    if (!this.hitStopRemaining && this.distance >= this.nextStep) {
      this.nextStep += Rules.stepStride;
      if (!this.y && !this.velocityY) {
        this.events.emit(GameEvent.Step, this.nextFoot);
        this.nextFoot = 1 - this.nextFoot;
      }
    }
  }
  private collisions() {
    const pool = this.world,
      dx = this.x - this.previousX,
      dz = this.z - this.previousZ,
      minZ = Math.min(this.previousZ, this.z),
      maxZ = Math.max(this.previousZ, this.z);
    for (let i = 0; i < pool.active.length; i++) {
      if (!pool.active[i]) continue;
      if (pool.motion[i] === 2 || (pool.motion[i] === 1 && pool.lean[i] >= Math.PI / 2 - 1e-5)) continue;
      if (pool.kinds[i] === ObjectKind.Bird && pool.motion[i] !== 3 && pool.motion[i] !== 4) continue;
      const obstacleX = pool.collisionX(i),
        obstacleZ = pool.collisionZ(i);
      const dynamic = pool.motion[i] === 1 || pool.motion[i] === 3 || pool.motion[i] === 4;
      const oldX = dynamic ? pool.previousX[i] : obstacleX,
        oldZ = dynamic ? pool.previousZ[i] : obstacleZ,
        oldBase = dynamic ? pool.previousBaseY[i] : pool.baseY[i];
      // Broad phase uses full render bounds before any registry lookup. The
      // forgiving blocking box below is a subset, never a culling replacement.
      const broadZ = pool.halfZ[i] + Rules.playerRadius;
      if (Math.max(oldZ, obstacleZ) < minZ - broadZ || Math.min(oldZ, obstacleZ) > maxZ + broadZ) continue;
      const definition = pool.registry.get(pool.kinds[i]);
      if (!definition || definition.walkable || (definition.blocking && this.health.immunity > 0))
        continue;
      const blocking = definition.blocking;
      const scale = definition.blocking ? Rules.cactusHitScale : 1;
      const radius = blocking ? Rules.blockingRadius : Rules.playerRadius;
      const extentX = pool.halfX[i] * scale + radius,
        extentZ = pool.halfZ[i] * scale + radius;
      if (Math.max(oldZ, obstacleZ) < minZ - extentZ || Math.min(oldZ, obstacleZ) > maxZ + extentZ) continue;
      const relativeX = this.previousX - oldX, relativeZ = this.previousZ - oldZ,
        relativeDX = dx - (obstacleX - oldX), relativeDZ = dz - (obstacleZ - oldZ);
      let enter = 0,
        leave = 1;
      if (Math.abs(relativeDZ) < 1e-9) {
        if (Math.abs(relativeZ) >= extentZ) continue;
      } else {
        const a = (-extentZ - relativeZ) / relativeDZ;
        const b = (extentZ - relativeZ) / relativeDZ;
        enter = Math.max(enter, Math.min(a, b));
        leave = Math.min(leave, Math.max(a, b));
      }
      if (Math.abs(relativeDX) < 1e-9) {
        if (Math.abs(relativeX) >= extentX) continue;
      } else {
        const a = (-extentX - relativeX) / relativeDX,
          b = (extentX - relativeX) / relativeDX;
        enter = Math.max(enter, Math.min(a, b));
        leave = Math.min(leave, Math.max(a, b));
      }
      if (enter > leave) continue;
      const oldFeet = this.previousGroundY + this.previousY,
        newFeet = this.groundY + this.y;
      const yEnter = oldFeet + (newFeet - oldFeet) * enter;
      const yLeave = oldFeet + (newFeet - oldFeet) * leave;
      const previousTop =
        oldFeet +
        Rules.playerBodyHeight +
        (Rules.duckBodyHeight - Rules.playerBodyHeight) * this.previousCrouch;
      const top = newFeet + this.bodyHeight;
      const topEnter = previousTop + (top - previousTop) * enter;
      const topLeave = previousTop + (top - previousTop) * leave;
      const animated = definition.animation === "spin-bob";
      const bobEnter = animated
        ? this.previousBob + (this.pickupMotion.bob - this.previousBob) * enter
        : 0;
      const bobLeave = animated
        ? this.previousBob + (this.pickupMotion.bob - this.previousBob) * leave
        : 0;
      const baseEnter = oldBase + (pool.baseY[i] - oldBase) * enter,
        baseLeave = oldBase + (pool.baseY[i] - oldBase) * leave;
      if (
        Math.min(yEnter - bobEnter - baseEnter, yLeave - bobLeave - baseLeave) >= pool.height[i] ||
        Math.max(topEnter - bobEnter - baseEnter, topLeave - bobLeave - baseLeave) <= 0
      )
        continue;
      if (definition.blocking) {
        if (this.health.damage()) {
          if (pool.kinds[i] === ObjectKind.Bird) pool.consume(i);
          this.speed = Rules.startSpeed;
          this.runSpeed = Rules.startSpeed;
          this.groundVelocity = 0;
          // Hold the swept contact pose, not a later penetrated/end-of-step pose.
          this.x = this.previousX + dx * enter;
          this.z = this.previousZ + dz * enter;
          this.distance =
            this.previousDistance +
            (this.distance - this.previousDistance) * enter;
          this.scoreDistance =
            this.previousScoreDistance +
            (this.scoreDistance - this.previousScoreDistance) * enter;
          this.y = this.previousY + (this.y - this.previousY) * enter;
          this.previousX = this.x;
          this.previousZ = this.z;
          this.previousDistance = this.distance;
          this.previousScoreDistance = this.scoreDistance;
          this.previousY = this.y;
          this.groundY =
            this.previousGroundY +
            (this.groundY - this.previousGroundY) * enter;
          this.previousGroundY = this.groundY;
          this.hitStopRemaining = Rules.hitStopSeconds;
          this.move(0);
          return;
        }
      } else {
        let amount = definition.reward ?? 1;
        if (definition.kind === ObjectKind.Coin)
          this.wallet.add(Currency.Coin, definition.reward ?? 1);
        else if (definition.kind === ObjectKind.Diamond)
          this.wallet.add(Currency.Diamond, definition.reward ?? 1);
        else if (definition.healing !== undefined) {
          const before = this.health.lives;
          this.health.heal(definition.healing);
          amount = this.health.lives - before;
        }
        this.events.emit(GameEvent.CollectedVisual, i);
        pool.consume(i);
        this.events.emit(GameEvent.Collected, definition.kind, amount);
      }
    }
  }
}

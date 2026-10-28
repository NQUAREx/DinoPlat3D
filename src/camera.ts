import {
  Box3,
  Frustum,
  Matrix4,
  PerspectiveCamera,
  Quaternion,
  Vector3,
} from "three";
import { Rules } from "./config";
import { Tuning } from "./tuning";

export const CAMERA_FOV = 50;
export const CAMERA_FAR = 96;
export const FOG_START = 36;
export const FOG_END = 84;
export interface CameraPose {
  offsetX: number;
  height: number;
  distance: number;
  targetY: number;
  targetZ: number;
  fov: number;
}
export interface HeightSampler {
  heightAt(x: number, z: number): number;
}

/** Event-driven camera extension point; allocations happen only at construction. */
export class CameraRig {
  flight = false;
  private flightBlend = 0;
  readonly camera = new PerspectiveCamera(CAMERA_FOV, 1, 0.2, CAMERA_FAR);
  private readonly current: CameraPose = {
    offsetX: 0,
    height: 8.5,
    distance: 12,
    targetY: 1,
    targetZ: -5,
    fov: CAMERA_FOV,
  };
  private readonly target: CameraPose = { ...this.current };
  private readonly look = new Vector3();
  private blendTime = 0.35;
  private shake = 0;
  private shakeTime = 0;
  private shakeAge = 0;
  private walkingBlend = 0;
  heading = 0;
  terrainPitch = 0;
  slopeFovBoost = 0;
  get followDelay() {
    return Tuning.camera.followDelay;
  }
  shakeMultiplier = 2.9;
  private mode = false;
  private modeFrom = 0;
  private modeTime = 0.65;
  private modeValue = 0;
  get transitionSeconds() {
    return Tuning.camera.transitionSeconds;
  }
  private readonly rearPosition = new Vector3();
  private readonly frontPosition = new Vector3();
  private readonly rearRotation = new Quaternion();
  private readonly frontRotation = new Quaternion();
  private readonly rotationMatrix = new Matrix4();
  get firstPerson() {
    return this.mode;
  }
  set firstPerson(value: boolean) {
    if (value === this.mode) return;
    this.modeFrom = this.modeValue;
    this.modeTime = 0;
    this.mode = value;
  }
  get firstPersonBlend() {
    return this.modeValue;
  }
  get transitioning() {
    return this.modeTime < this.transitionSeconds;
  }
  get avatarVisible() {
    return this.modeValue < 0.94;
  }
  constructor(private readonly reducedMotion = false) {
    this.update(0, 0, 0, false);
  }
  resize(aspect: number) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
  setPose(pose: Partial<CameraPose>, seconds = 0.35) {
    if (pose.offsetX !== undefined)
      this.target.offsetX = Math.max(-2, Math.min(2, pose.offsetX));
    if (pose.height !== undefined)
      this.target.height = Math.max(1, pose.height);
    if (pose.distance !== undefined)
      this.target.distance = Math.max(1, pose.distance);
    if (pose.targetY !== undefined) this.target.targetY = pose.targetY;
    if (pose.targetZ !== undefined) this.target.targetZ = pose.targetZ;
    if (pose.fov !== undefined)
      this.target.fov = Math.max(25, Math.min(90, pose.fov));
    this.blendTime = Math.max(0.01, seconds);
    if (seconds === 0) Object.assign(this.current, this.target);
  }
  impulse(strength: number, seconds: number) {
    this.shake = Math.min(0.12, Math.max(this.shake, strength));
    this.shakeTime = Math.max(0, seconds);
    this.shakeAge = 0;
  }
  update(
    distance: number,
    localPlayerX: number,
    dt: number,
    walking: boolean,
    heading = 0,
    playerY = 0,
    crouch = 0,
    groundY = 0,
    terrain?: HeightSampler,
    worldX = 0,
    worldZ = 0,
  ) {
    this.heading +=
      (heading - this.heading) *
      (1 - Math.exp(-Math.max(0, dt) / this.followDelay));
    this.modeTime = Math.min(
      this.transitionSeconds,
      this.modeTime + Math.max(0, dt),
    );
    const ease =
      (1 - Math.cos((Math.PI * this.modeTime) / this.transitionSeconds)) * 0.5;
    this.modeValue =
      this.modeFrom + ((this.mode ? 1 : 0) - this.modeFrom) * ease;
    const viewBlend = this.modeValue;
    const blend = 1 - Math.exp((-dt * 4) / this.blendTime);
    const p = this.current,
      t = this.target;
    p.offsetX += (t.offsetX - p.offsetX) * blend;
    p.height += (t.height - p.height) * blend;
    p.distance += (t.distance - p.distance) * blend;
    p.targetY += (t.targetY - p.targetY) * blend;
    p.targetZ += (t.targetZ - p.targetZ) * blend;
    p.fov += (t.fov - p.fov) * blend;
    const near =
        Tuning.camera.rearNear +
        (Tuning.camera.frontNear - Tuning.camera.rearNear) * viewBlend;
    const phase = (distance * Math.PI * 2) / Rules.stepStride;
    const intensity = Math.max(0, Math.min(3, this.shakeMultiplier)) * 1.5;
    const rearFactor = 0.85,
      frontFactor = 1.3;
    this.walkingBlend +=
      ((walking ? 1 : 0) - this.walkingBlend) *
      (1 - Math.exp(-Math.max(0, dt) * 12));
    const bob = !this.reducedMotion
      ? Math.sin(phase) *
        Tuning.camera.walkBob *
        intensity *
        1.5 *
        this.walkingBlend
      : 0;
    this.shakeTime = Math.max(0, this.shakeTime - dt);
    this.shakeAge += dt;
    const shake =
      this.shakeTime > 0 && !this.reducedMotion
        ? this.shake *
          intensity *
          Math.sin(this.shakeAge * 55) *
          Math.min(1, this.shakeTime * 8)
        : 0;
    const sin = Math.sin(this.heading),
      cos = Math.cos(this.heading);
    // Probe actual terrain along the delayed camera direction, not jump/bob
    // height. Look ahead before climbing, then ease over crests and descents.
    const ahead = Tuning.camera.slopeAhead, behind = Tuning.camera.slopeBehind;
    const grade = terrain
      ? (terrain.heightAt(worldX - sin * ahead, worldZ + cos * ahead) -
         terrain.heightAt(worldX + sin * behind, worldZ - cos * behind)) / (ahead + behind)
      : 0;
    const targetPitch = Math.max(-Tuning.camera.slopeDown, Math.min(Tuning.camera.slopeUp, Math.atan(grade)));
    this.terrainPitch += (targetPitch - this.terrainPitch) * (1 - Math.exp(-Math.max(0, dt) / Tuning.camera.slopeDelay));
    const targetFovBoost = Math.min(Tuning.camera.slopeFov, Math.abs(this.terrainPitch) * Tuning.camera.slopeFov);
    this.slopeFovBoost += (targetFovBoost - this.slopeFovBoost) *
      (1 - Math.exp(-Math.max(0, dt) / Tuning.camera.slopeDelay));
    this.flightBlend += ((this.flight ? 1 : 0) - this.flightBlend) * (1 - Math.exp(-Math.max(0, dt) / .3));
    const fov = Math.min(150, (p.fov + (Tuning.camera.frontFov - p.fov) * viewBlend + this.slopeFovBoost) * (1 + this.flightBlend));
    if (Math.abs(fov - this.camera.fov) > 0.001 || near !== this.camera.near) {
      this.camera.fov = fov;
      this.camera.near = near;
      this.camera.updateProjectionMatrix();
    }
    const pitchSin = Math.sin(this.terrainPitch), pitchCos = Math.cos(this.terrainPitch);
    const x = p.offsetX + localPlayerX * 0.75;
    const eye =
      Tuning.camera.frontEye +
      playerY -
      crouch * Tuning.camera.frontDuck +
      bob * 0.2 * frontFactor;
    this.frontPosition.set(
      -sin * 0.05 + shake * cos * 0.35 * frontFactor,
      eye,
      -cos * 0.05 - shake * sin * 0.35 * frontFactor,
    );
    if (terrain) this.frontPosition.y = Math.max(this.frontPosition.y,
      terrain.heightAt(worldX + this.frontPosition.x, worldZ - this.frontPosition.z) + 0.2);
    this.look.set(-sin * 10, eye - 0.12 + Math.tan(this.terrainPitch) * 10, -cos * 10);
    this.rotationMatrix.lookAt(this.frontPosition, this.look, this.camera.up);
    this.frontRotation.setFromRotationMatrix(this.rotationMatrix);
    const slopeDistance = p.distance * pitchCos + p.height * pitchSin;
    this.rearPosition.set(
      (x + (bob * 0.25 + shake) * rearFactor) * cos + slopeDistance * sin,
      p.height * pitchCos - p.distance * pitchSin + groundY + bob * rearFactor,
      slopeDistance * cos - (x + (bob * 0.25 + shake) * rearFactor) * sin,
    );
    if (terrain) this.rearPosition.y = Math.max(this.rearPosition.y,
      terrain.heightAt(worldX + this.rearPosition.x, worldZ - this.rearPosition.z) + Tuning.camera.terrainClearance);
    const targetDistance = p.targetZ * pitchCos + p.targetY * pitchSin;
    this.look.set(
      x * cos + targetDistance * sin,
      p.targetY * pitchCos - p.targetZ * pitchSin + groundY,
      targetDistance * cos - x * sin,
    );
    this.rotationMatrix.lookAt(this.rearPosition, this.look, this.camera.up);
    this.rearRotation.setFromRotationMatrix(this.rotationMatrix);
    this.camera.position.lerpVectors(
      this.rearPosition,
      this.frontPosition,
      viewBlend,
    );
    if (terrain) this.camera.position.y = Math.max(this.camera.position.y,
      terrain.heightAt(worldX + this.camera.position.x, worldZ - this.camera.position.z) + 0.2);
    this.camera.quaternion.slerpQuaternions(
      this.rearRotation,
      this.frontRotation,
      viewBlend,
    );
    this.camera.rotateZ(
      bob *
        (0.025 * rearFactor * (1 - viewBlend) +
          0.015 * frontFactor * viewBlend),
    );
    this.camera.updateMatrixWorld();
  }
  reset() {
    this.flight = false;
    this.flightBlend = 0;
    this.shake = this.shakeTime = 0;
    this.shakeAge = 0;
    this.walkingBlend = 0;
    this.heading = 0;
    this.terrainPitch = 0;
    this.slopeFovBoost = 0;
    this.modeValue = this.modeFrom = this.mode ? 1 : 0;
    this.modeTime = this.transitionSeconds;
    this.setPose(
      {
        ...Tuning.camera,
      },
      0.01,
    );
  }
}

/** Full-volume visibility check; retain partially visible models. */
export class ObjectVisibility {
  private readonly frustum = new Frustum();
  private readonly matrix = new Matrix4();
  private readonly bounds = new Box3();
  update(camera: PerspectiveCamera) {
    this.matrix.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    );
    this.frustum.setFromProjectionMatrix(this.matrix);
  }
  intersects(
    x: number,
    forward: number,
    halfX: number,
    halfZ: number,
    height: number,
    baseY = 0,
  ) {
    this.bounds.min.set(x - halfX, baseY, -forward - halfZ);
    this.bounds.max.set(x + halfX, baseY + height, -forward + halfZ);
    return this.frustum.intersectsBox(this.bounds);
  }
}

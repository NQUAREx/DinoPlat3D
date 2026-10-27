import * as THREE from "three";
import { CameraRig, ObjectVisibility, FOG_START, FOG_END } from "./camera";
import { Rules, Palette } from "./config";
import { GameEvent } from "./events";
import { Ground } from "./ground";
import { AnimatedDinosaur, FootDust } from "./character";
import { ObjectKind } from "./world";
import { InstancedObjectType, ObjectRendererRegistry } from "./object-renderer";
import type { BiomeModels } from "./biome-models";
import { Scenery } from "./scenery";
import type { Simulation } from "./simulation";
import type { ModelLibrary } from "./models";
import { LightingRig } from "./lighting";
import { RenderPose } from "./render-pose";
import { CachedShadows } from "./shadows";
import { PickupMotion } from "./pickup-motion";
import { DinosaurShadow } from "./dinosaur-shadow";
import { FloatingFeedback } from "./floating-feedback";
import { RenderQuality } from "./render-quality";
import type { CosmeticInventory } from "./cosmetics";
import { DinosaurCosmetics } from "./dinosaur-cosmetics";
import { MenuPreview } from "./menu-preview";
import { Tuning } from "./tuning";
import { PickupEffects } from "./pickup-effects";
import { BonusModels } from "./bonus-models";
import { BonusVisuals } from "./bonus-visuals";

/** Sole GPU owner. Only visible numeric cells become instances; no object churn. */
export class View {
  readonly renderer: THREE.WebGLRenderer;
  readonly rig: CameraRig;
  readonly lighting = new LightingRig();
  private readonly pose = new RenderPose();
  private readonly pickupMotion = new PickupMotion();
  private readonly shadows = new CachedShadows();
  private readonly scene = new THREE.Scene();
  private readonly ground: Ground;
  private readonly dinosaur: AnimatedDinosaur;
  private readonly cosmetics: DinosaurCosmetics;
  private readonly preview: MenuPreview;
  private readonly scenery: Scenery;
  private readonly wings: InstancedObjectType;
  private readonly ownedGeometries: THREE.BufferGeometry[] = [];
  private readonly environmentMaterial = new THREE.MeshLambertMaterial({
    vertexColors: true,
  });
  private deathFirstPerson = false;
  private readonly dinosaurShadow = new DinosaurShadow();
  private readonly dust: FootDust;
  private readonly feedback: FloatingFeedback;
  private readonly pickupEffects: PickupEffects;
  private bonusModels?: BonusModels;
  private bonusVisuals?: BonusVisuals;
  private initialization?: Promise<void>;
  private disposed = false;
  private readonly reducedMotion = matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  private readonly feedbackAnchor = new THREE.Vector3();
  private readonly cameraForward = new THREE.Vector3();
  private readonly cactusMaterial = new THREE.MeshLambertMaterial({
    vertexColors: true,
  });
  // Palette is the HUD palette, with just a little self-emission for night
  // readability. One opaque vertex-colour material shared by all three types.
  private readonly pickupMaterial = new THREE.MeshLambertMaterial({
    vertexColors: true,
    flatShading: true,
    emissive: 0xffffff,
    emissiveIntensity: 0.025,
  });
  private readonly objectRenderers = new ObjectRendererRegistry();
  private readonly visibility = new ObjectVisibility();
  private readonly off: (() => void)[];
  private readonly resolution = new RenderQuality();
  private nearestRenderedForward = Infinity;
  private maximumRelativeX = 0;
  private visibleCacti = 0;
  private worldFov = 0;
  private worldCameraX = 0;
  private viewportWidth = 0;
  private viewportHeight = 0;
  private pixelRatio = 0;
  private bufferResizes = 0;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly models: ModelLibrary,
    private readonly biomeModels: BiomeModels,
    private readonly game: Simulation,
    redraw: () => void = () => {},
  ) {
    const reducedMotion = matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    this.rig = new CameraRig(reducedMotion);
    this.ground = new Ground(game.landscape);
    this.dinosaur = new AnimatedDinosaur(models, game);
    this.preview = new MenuPreview(models, redraw);
    this.cosmetics = new DinosaurCosmetics(models, this.dinosaur.mesh);
    this.dust = new FootDust(game, reducedMotion, this.dinosaur);
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: "default",
    });
    this.renderer.setClearColor(Palette.sky);
    this.cactusMaterial.onBeforeCompile = (shader) => {
      shader.vertexShader =
        "attribute float instanceDetail; varying float vDetail;\n" +
        shader.vertexShader.replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\nvDetail = instanceDetail;",
        );
      shader.fragmentShader =
        "varying float vDetail;\n" +
        shader.fragmentShader.replace(
          "#include <clipping_planes_fragment>",
          `#include <clipping_planes_fragment>
        ivec2 p = ivec2(gl_FragCoord.xy) & ivec2(3);
        int b = ((p.x & 1) * 2 + (p.y & 1)) * 4 + (p.x & 2) + ((p.y & 2) >> 1);
        float threshold = (float(b) + .5) / 16.;
        if (vDetail >= 0. ? threshold >= vDetail : threshold < -vDetail - 1.) discard;`,
        );
    };
    this.feedback = new FloatingFeedback(
      game.events,
      canvas.parentElement!,
      () => game.feedbackTime,
      reducedMotion,
    );
    this.pickupEffects = new PickupEffects(game, models, this.scene);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.BasicShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.scene.fog = new THREE.Fog(Palette.sky, FOG_START, FOG_END);
    this.scene.add(
      this.lighting.key,
      this.lighting.key.target,
      this.lighting.ambient,
    );
    const time = new URLSearchParams(location.search).get("time");
    if (time !== null && time.trim() !== "" && Number.isFinite(Number(time)))
      this.lighting.setTimeOfDay(Number(time));
    this.registerObjectType(
      ObjectKind.Cactus,
      models.cacti,
      this.cactusMaterial,
      models.cactusLods,
    );
    this.registerObjectType(
      ObjectKind.Coin,
      [models.coin],
      this.pickupMaterial,
    );
    this.registerObjectType(
      ObjectKind.Diamond,
      [models.diamond],
      this.pickupMaterial,
    );
    this.registerObjectType(
      ObjectKind.Heart,
      [models.heart],
      this.pickupMaterial,
    );
    for (const [kind, prefix, count] of [
      [ObjectKind.Tree, "tree", 3],
      [ObjectKind.DeadTree, "dead-tree", 3],
      [ObjectKind.Rock, "rock", 3],
      [ObjectKind.Log, "log", 1],
      [ObjectKind.Tumbleweed, "tumbleweed", 1],
      [ObjectKind.Bird, "bird-body", 1],
    ] as const) {
      const names = Array.from({ length: count }, (_, i) =>
        prefix === "bird-body" ? prefix : `${prefix}-${i}`,
      );
      const lod = kind === ObjectKind.Tree || kind === ObjectKind.DeadTree;
      this.registerObjectType(
        kind,
        names.map((n) => {
          const geometry = biomeModels.get(n);
          if (kind !== ObjectKind.Tumbleweed) return geometry;
          const centred = geometry.clone().translate(0, -0.45, 0);
          this.ownedGeometries.push(centred);
          return centred;
        }),
        lod ? this.cactusMaterial : this.environmentMaterial,
        lod
          ? Array.from({ length: count }, (_, i) =>
              biomeModels.get(`${prefix}-lod-${i}`),
            )
          : undefined,
      );
    }
    const wing = biomeModels.get("bird-wing"),
      left = wing.clone();
    left.scale(-1, 1, 1);
    const index = left.index!;
    for (let i = 0; i < index.count; i += 3) {
      const b = index.getX(i + 1);
      index.setX(i + 1, index.getX(i + 2));
      index.setX(i + 2, b);
    }
    left.computeVertexNormals();
    this.ownedGeometries.push(left);
    this.wings = new InstancedObjectType(
      ObjectKind.Bird,
      [wing, left],
      this.environmentMaterial,
      this.scene,
      undefined,
      128,
    );
    this.scenery = new Scenery(game.landscape, biomeModels, this.scene);
    this.scene.add(
      this.ground.mesh,
      ...this.ground.extraMeshes,
      this.dinosaurShadow.mesh,
      this.dinosaur.mesh,
      this.dust.mesh,
    );
    for (const type of [
      ObjectKind.Cactus,
      ObjectKind.Tree,
      ObjectKind.DeadTree,
      ObjectKind.Rock,
      ObjectKind.Log,
    ])
      for (const mesh of this.objectRenderers.get(type)!.meshes) {
        mesh.castShadow = true;
        // Only the terrain needs reception today. Avoid a depth lookup on every
        // cactus fragment; future low-poly props can opt into self-shadowing.
        mesh.receiveShadow = false;
      }
    this.off = [
      game.events.on(GameEvent.Hit, () =>
        this.rig.impulse(Tuning.camera.hitShake, 0.22),
      ),
      game.events.on(GameEvent.Land, () =>
        this.rig.impulse(Tuning.camera.landShake, 0.2),
      ),
      game.events.on(GameEvent.Death, () => {
        this.deathFirstPerson = this.rig.firstPerson;
        this.rig.firstPerson = false;
      }),
      game.events.on(GameEvent.Start, () => {
        if (this.deathFirstPerson) this.rig.firstPerson = true;
        this.deathFirstPerson = false;
        this.rig.reset();
      }),
    ];
    this.resize();
  }
  initialize(): Promise<void> {
    return this.initialization ??= this.initializeModels();
  }
  private async initializeModels() {
    const models = await BonusModels.load();
    if (this.disposed) { models.dispose(); return; }
    this.bonusModels = models;
    for (let kind = 0; kind < models.pickups.length; kind++)
      this.registerObjectType(ObjectKind.Jetpack + kind, [models.pickups[kind]], this.pickupMaterial);
    this.pickupEffects.addBonuses(models.pickups);
    this.bonusVisuals = new BonusVisuals(models, this.dinosaur.mesh, this.scene, this.game, this.reducedMotion);
    for (const mesh of this.pickupEffects.meshes) mesh.visible = true;
    this.bonusVisuals.backpack.visible = this.bonusVisuals.turbo.visible = this.bonusVisuals.smoke.visible = true;
    try {
      await this.renderer.compileAsync(this.scene, this.rig.camera);
    } finally {
      for (const mesh of this.pickupEffects.meshes) mesh.visible = false;
      this.bonusVisuals.reset();
    }
  }
  registerObjectType(
    kind: ObjectKind,
    geometries: readonly THREE.BufferGeometry[],
    material: THREE.Material,
    lodGeometries?: readonly THREE.BufferGeometry[],
  ) {
    this.objectRenderers.register(
      new InstancedObjectType(
        kind,
        geometries,
        material,
        this.scene,
        lodGeometries,
      ),
    );
  }
  resize() {
    const canvas = this.renderer.domElement,
      width = Math.max(1, canvas.clientWidth),
      height = Math.max(1, canvas.clientHeight);
    const ratio = this.resolution.ratio(width, height, devicePixelRatio || 1);
    if (
      width === this.viewportWidth &&
      height === this.viewportHeight &&
      ratio === this.pixelRatio
    )
      return;
    this.viewportWidth = width;
    this.viewportHeight = height;
    this.pixelRatio = ratio;
    this.bufferResizes++;
    // Change size + DPR together: setPixelRatio followed by setSize resets a
    // mobile canvas twice. CSS already owns the displayed dimensions.
    this.renderer.setDrawingBufferSize(width, height, ratio);
    this.rig.resize(width / height);
    this.game.world.setVisibleHalfWidth(
      (this.rig.camera.far *
        Math.tan((this.rig.camera.fov * Math.PI) / 360) *
        width) /
        height +
        Math.abs(this.rig.camera.position.x) +
        1,
    );
    this.worldFov = this.rig.camera.fov;
    this.worldCameraX = this.rig.camera.position.x;
    this.game.world.update(this.game.x, this.game.z);
  }
  adapt(dt: number) {
    if (this.resolution.sample(dt)) this.resize();
  }
  applyCosmetics(inventory: CosmeticInventory) {
    this.cosmetics.apply(inventory);
    this.dinosaur.groundLift = this.cosmetics.groundLift;
    this.preview.apply(inventory);
  }
  draw(alpha = 1, dt = 0) {
    if (this.disposed) return;
    const game = this.game;
    const home =
      (game.phase === "ready" || game.phase === "over") && this.preview.visible;
    this.pose.update(game, alpha);
    this.lighting.update(
      game.previousTime + (game.time - game.previousTime) * alpha,
    );
    (this.scene.fog as THREE.Fog).color.copy(this.lighting.fogColour);
    (this.scene.fog as THREE.Fog).near = Tuning.camera.fogStart;
    (this.scene.fog as THREE.Fog).far = Tuning.camera.fogEnd;
    this.ground.update(game, this.pose);
    this.dinosaur.update(
      game,
      alpha,
      this.rig.avatarVisible || this.rig.transitioning,
      this.bonusVisuals?.avatarOpacity(game) ?? 1,
    );
    this.dinosaurShadow.update(
      this.dinosaur,
      this.lighting,
      game.world.walkHeightAt(this.pose.x, this.pose.z, this.ground.surface.heightAt(this.pose.x, this.pose.z)),
    );
    const moving =
      game.phase === "running" &&
      !game.hitStopRemaining &&
      !game.y &&
      !game.velocityY;
    const activeDt =
      game.phase === "running" ||
      game.phase === "dying" ||
      this.rig.transitioning
        ? dt
        : 0;
    this.rig.update(
      this.pose.distance,
      0,
      activeDt,
      moving,
      this.pose.heading,
      this.dinosaur.mesh.position.y,
      game.previousCrouch + (game.crouch - game.previousCrouch) * alpha,
      game.previousGroundY + (game.groundY - game.previousGroundY) * alpha,
      game.landscape,
      this.pose.x,
      this.pose.z,
    );
    this.dinosaur.mesh.visible = this.rig.avatarVisible;
    this.bonusVisuals?.update(game, this.pose, this.rig.camera, alpha);
    this.renderer.setClearColor((this.scene.fog as THREE.Fog).color);
    if (!this.rig.avatarVisible) this.dinosaurShadow.mesh.visible = false;
    this.lighting.followView(this.rig.heading);
    const groundY =
      game.previousGroundY + (game.groundY - game.previousGroundY) * alpha;
    this.lighting.key.position.y += groundY;
    this.lighting.key.target.position.y += groundY;
    this.rig.camera.getWorldDirection(this.cameraForward);
    game.viewHeading = Math.atan2(-this.cameraForward.x, -this.cameraForward.z);
    game.viewX = this.pose.x + this.rig.camera.position.x;
    game.viewZ = this.pose.z - this.rig.camera.position.z;
    this.feedbackAnchor
      .set(0, this.dinosaur.mesh.position.y + 1.95 - game.crouch * 0.55, 0)
      .project(this.rig.camera);
    this.feedback.update(
      game.previousFeedbackTime +
        (game.feedbackTime - game.previousFeedbackTime) * alpha,
      this.rig.firstPersonBlend > 0.5
        ? this.viewportWidth * 0.5
        : (this.feedbackAnchor.x * 0.5 + 0.5) * this.viewportWidth,
      this.rig.firstPersonBlend > 0.5
        ? this.viewportHeight * 0.45
        : (-this.feedbackAnchor.y * 0.5 + 0.5) * this.viewportHeight,
    );
    this.visibility.update(this.rig.camera);
    this.scenery.update(this.pose, this.visibility);
    this.dust.update(
      game,
      game.hitStopRemaining ? 0 : activeDt,
      this.visibility,
      this.pose.x,
      this.pose.z,
    );
    if (
      Math.abs(this.worldFov - this.rig.camera.fov) > 0.05 ||
      Math.abs(this.worldCameraX - this.rig.camera.position.x) > 0.1
    ) {
      const camera = this.rig.camera;
      game.world.setVisibleHalfWidth(
        camera.far * Math.tan((camera.fov * Math.PI) / 360) * camera.aspect +
          Math.abs(camera.position.x) +
          1,
      );
      game.world.update(game.x, game.z);
      this.worldFov = camera.fov;
      this.worldCameraX = camera.position.x;
    }
    this.objectRenderers.begin();
    this.wings.begin();
    this.visibleCacti = 0;
    this.nearestRenderedForward = Infinity;
    this.maximumRelativeX = 0;
    const world = game.world;
    this.pickupMotion.update(
      game.previousTime + (game.time - game.previousTime) * alpha,
    );
    for (let i = 0; i < world.active.length; i++) {
      if (!world.active[i]) continue;
      if (world.kinds[i] === ObjectKind.Bird && world.motion[i] !== 3 && world.motion[i] !== 4) continue;
      const renderer = this.objectRenderers.get(world.kinds[i]);
      if (!renderer) continue;
      const movingObject = world.motion[i] === 3 || world.motion[i] === 4 || world.magnetized[i] !== 0;
      const x = (movingObject ? world.previousX[i] + (world.x[i] - world.previousX[i]) * alpha : world.x[i]) - this.pose.x,
        forward = (movingObject ? world.previousZ[i] + (world.z[i] - world.previousZ[i]) * alpha : world.z[i]) - this.pose.z;
      const animated =
        world.registry.get(world.kinds[i])?.animation === "spin-bob";
      const y = (movingObject ? world.previousBaseY[i] + (world.baseY[i] - world.previousBaseY[i]) * alpha : world.baseY[i]) + (animated ? this.pickupMotion.bob : 0);
      const visible = this.visibility.intersects(
        world.collisionX(i) - this.pose.x,
        world.collisionZ(i) - this.pose.z,
        world.halfX[i],
        world.halfZ[i],
        world.height[i],
        y,
      );
      let caster = false;
      if (
        world.registry.get(world.kinds[i])?.blocking &&
        x * x + forward * forward < 60 * 60
      ) {
        // A map may live for .25s: retain a guard band exceeding max forward
        // movement (6m) during that interval. Tight per-frame caster culling
        // makes cached edge shadows pop. Do not submit the whole 60m disk.
        const sx = this.lighting.shadowSlope.x,
          sz = this.lighting.shadowSlope.y;
        const mid = world.baseY[i] + world.height[i] / 2;
        caster = this.visibility.intersects(
          x - mid * sx,
          forward + mid * sz,
          world.halfX[i] + (Math.abs(sx) * world.height[i]) / 2 + 8,
          world.halfZ[i] + (Math.abs(sz) * world.height[i]) / 2 + 8,
          0.02,
          0,
        );
      }
      if (!visible && !caster) continue;
      renderer.place(
        world.variants[i],
        x,
        -forward,
        animated ? this.pickupMotion.angle : world.angles[i],
        y + (world.kinds[i] === ObjectKind.Tumbleweed ? 0.45 : 0),
        world.kinds[i] === ObjectKind.Tumbleweed
          ? game.time * 9
          : world.lean[i],
      );
      if (world.kinds[i] === ObjectKind.Bird) {
        const flap = Math.sin(game.time * 14) * 0.7;
        const sx = 0.14 * Math.cos(world.angles[i]),
          sz = -0.14 * Math.sin(world.angles[i]);
        this.wings.place(
          0,
          x + sx,
          -forward + sz,
          world.angles[i],
          y + 0.16,
          0,
          flap,
        );
        this.wings.place(
          1,
          x - sx,
          -forward - sz,
          world.angles[i],
          y + 0.16,
          0,
          -flap,
        );
      }
      if (visible) {
        if (world.registry.get(world.kinds[i])?.blocking) this.visibleCacti++;
        this.nearestRenderedForward = Math.min(
          this.nearestRenderedForward,
          forward,
        );
        this.maximumRelativeX = Math.max(this.maximumRelativeX, Math.abs(x));
      }
    }
    this.objectRenderers.finish();
    this.wings.finish();
    this.pickupEffects.update(
      game.previousFeedbackTime +
        (game.feedbackTime - game.previousFeedbackTime) * alpha,
      this.pose.x,
      this.pose.z,
      this.pickupMotion.angle,
    );
    this.renderer.shadowMap.needsUpdate = this.shadows.prepare(
      game,
      this.pose,
      this.lighting,
      this.resolution.quality,
    );
    // r186 updates visible objects before incrementing its frame ID, then
    // shadow casters afterwards. A cached shadow capture therefore leaves the
    // object's upload stamp equal to the NEXT frame's visibility-pass stamp:
    // instance matrices are skipped for one frame (stale positions/counts).
    // Start a fresh upload epoch before visibility traversal. This touches only
    // renderer bookkeeping, not shadow cadence/maps or simulation time.
    this.renderer.info.render.frame++;
    this.renderer.render(this.scene, this.rig.camera);
    this.shadows.complete(this.lighting);
    if (home) this.preview.draw(this.renderer, dt);
  }
  get previewAnimating() {
    return (
      this.preview.visible &&
      Tuning.effects.previewSpin !== 0 &&
      !this.reducedMotion
    );
  }
  applyTuning() {
    this.rig.shakeMultiplier = Tuning.camera.shake;
    this.rig.setPose(Tuning.camera, 0);
    this.rig.camera.far = Tuning.camera.far;
    this.rig.camera.updateProjectionMatrix();
    this.lighting.key.shadow.bias = Tuning.rendering.shadowBias;
    this.lighting.key.shadow.normalBias = Tuning.rendering.shadowNormalBias;
    this.shadows.invalidate();
    this.worldFov = 0;
    this.resize();
  }
  stats() {
    return {
      calls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      geometries: this.renderer.info.memory.geometries,
      textures: this.renderer.info.memory.textures,
      quality: this.resolution.quality,
      meanFrameMs: this.resolution.meanFrameSeconds * 1000,
      pixelRatio: this.pixelRatio,
      antialias: this.renderer.getContext().getContextAttributes()?.antialias,
      cameraHeading: this.rig.heading,
      firstPerson: this.rig.firstPerson,
      cameraBlend: this.rig.firstPersonBlend,
      cameraTransitioning: this.rig.transitioning,
      cosmetics: this.cosmetics.stats(),
      preview: this.preview.stats(),
      deathTime: this.game.deathTime,
      playerRoll: this.dinosaur.mesh.rotation.z,
      dustOriginX: this.dust.lastOriginX,
      dustOriginZ: this.dust.lastOriginZ,
      dustSide: this.dust.lastSide,
      playerVisible: this.dinosaur.mesh.visible,
      bonusBackpackVisible: !!this.bonusVisuals?.backpack.visible && this.dinosaur.mesh.visible,
      bonusSmokeCount: this.bonusVisuals?.smoke.count ?? 0,
      bonusFogStrength: this.bonusVisuals?.fogStrength ?? 0,
      bonusShakeStrength: this.bonusVisuals?.shakeStrength ?? 0,
      bonusTurboStrength: this.bonusVisuals?.turboStrength ?? 0,
      bonusModelGeometries: this.bonusModels?.geometries.size ?? 0,
      width: this.renderer.domElement.width,
      height: this.renderer.domElement.height,
      bufferResizes: this.bufferResizes,
      threeRevision: THREE.REVISION,
      cameraFov: this.rig.camera.fov,
      cameraFar: this.rig.camera.far,
      fogStart: Tuning.camera.fogStart,
      fogEnd: Tuning.camera.fogEnd,
      shakeMultiplier: this.rig.shakeMultiplier,
      playerOpacity: (this.dinosaur.mesh.material as THREE.MeshLambertMaterial)
        .opacity,
      cactusHeight: this.models.cacti[0].boundingBox!.max.y,
      cameraX: this.rig.camera.position.x,
      cameraY: this.rig.camera.position.y,
      cameraZ: this.rig.camera.position.z,
      terrainLayers: 0,
      terrainTileMetres: 4,
      groundY: this.game.groundY,
      biome: this.game.landscape.biomeAt(this.pose.x, this.pose.z),
      surface: this.game.landscape.surfaceAt(this.pose.x, this.pose.z),
      visibleDecorations: this.scenery.visible,
      visibleTrees: this.objectRenderers.get(ObjectKind.Tree)!.visible,
      visibleDeadTrees: this.objectRenderers.get(ObjectKind.DeadTree)!.visible,
      visibleRocks: this.objectRenderers.get(ObjectKind.Rock)!.visible,
      visibleBirds: this.objectRenderers.get(ObjectKind.Bird)!.visible,
      visibleTumbleweed: this.objectRenderers.get(ObjectKind.Tumbleweed)!
        .visible,
      groundMeshes: 1 + this.ground.extraMeshes.length,
      lodNear: Rules.lodNear,
      lodFar: Rules.lodFar,
      boundaryCount: 0,
      obstacleVariants: this.models.cacti.length,
      obstacleCapacity: Rules.poolSize,
      visibleCoins: this.objectRenderers.get(ObjectKind.Coin)!.visible,
      visibleDiamonds: this.objectRenderers.get(ObjectKind.Diamond)!.visible,
      visibleHearts: this.objectRenderers.get(ObjectKind.Heart)!.visible,
      pickupAngle: this.pickupMotion.angle,
      pickupBob: this.pickupMotion.bob,
      visibleObstacles: this.visibleCacti,
      cactusNearInstances: this.objectRenderers.get(ObjectKind.Cactus)!
        .nearCount,
      cactusFarInstances: this.objectRenderers.get(ObjectKind.Cactus)!.farCount,
      cactusLodTriangles: this.models.cactusLods.map((g) => g.index!.count / 3),
      visibleObjects: this.objectRenderers.visible,
      nearestRenderedForward: this.nearestRenderedForward,
      maximumRelativeX: this.maximumRelativeX,
      playerFrame: this.dinosaur.frame,
      playerState: this.dinosaur.state,
      dustCount: this.dust.mesh.count,
      animationClips: this.models.animations.length,
      dinosaurBones: this.models.dinosaur.skeleton.bones.length,
      hours: this.lighting.cycle.hours,
      fogColour: this.lighting.fogColour.getHex(),
      sunX: this.lighting.key.position.x,
      sunY: this.lighting.key.position.y,
      sunZ: this.lighting.key.position.z,
      lightSource: this.lighting.source,
      moonVisible: false,
      shadowUpdates: this.shadows.updates,
      shadowMapSize: this.lighting.key.shadow.mapSize.x,
      terrainTriangles: this.ground.surface.geometry.drawRange.count / 3,
      shadows:
        this.lighting.shadowStrength > 0
          ? this.objectRenderers.get(ObjectKind.Cactus)!.visible
          : 0,
      shadowStrength: this.lighting.shadowStrength,
      feedbackCount: this.feedback.active,
      pickupEffectCount: this.pickupEffects.count,
      pickupEffectAlpha: this.pickupEffects.firstAlpha,
      pickupEffectY: this.pickupEffects.firstY,
      dinosaurShadowX: this.dinosaurShadow.mesh.position.x,
      dinosaurShadowZ: this.dinosaurShadow.mesh.position.z,
      dinosaurShadowWidth: this.dinosaurShadow.mesh.scale.x,
      dinosaurShadowOpacity: this.dinosaurShadow.mesh.material.opacity,
      renderX: this.pose.x,
      renderDistance: this.pose.distance,
      renderZ: this.pose.z,
    };
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.off) off();
    this.objectRenderers.dispose();
    this.wings.dispose();
    for (const g of this.ownedGeometries) g.dispose();
    this.scenery.dispose();
    this.environmentMaterial.dispose();
    this.cactusMaterial.dispose();
    this.pickupMaterial.dispose();
    this.dinosaur.dispose();
    this.preview.dispose();
    this.dinosaurShadow.dispose();
    this.dust.dispose();
    this.feedback.dispose();
    this.pickupEffects.dispose();
    this.bonusVisuals?.dispose();
    this.bonusModels?.dispose();
    this.ground.dispose();
    this.models.dispose();
    this.biomeModels.dispose();
    this.lighting.dispose();
    this.renderer.dispose();
  }
  restoreContext() {
    this.shadows.invalidate();
    this.lighting.key.shadow.map?.dispose();
    this.lighting.key.shadow.map = null;
  }
}

import { BufferGeometry, Mesh, type Material } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import modelUrl from "./assets/bonus-models.glb?url";

/** Order is the BonusKind / ObjectKind.Jetpack…Shake contract. */
export const BONUS_MODEL_NAMES = [
  "bonus-jetpack", "bonus-invisibility", "bonus-magnet", "bonus-blindness",
  "bonus-turbo", "bonus-reverse", "bonus-shake",
] as const;

/** Owns one offline bundle. Rendering code supplies shared Lambert materials. */
export class BonusModels {
  private disposed = false;
  readonly pickups: readonly BufferGeometry[];
  private constructor(readonly geometries: ReadonlyMap<string, BufferGeometry>) {
    this.pickups = BONUS_MODEL_NAMES.map(name => this.get(name));
  }

  static async load(): Promise<BonusModels> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    const geometries = new Set<BufferGeometry>(), materials = new Set<Material>();
    try {
      const response = await fetch(modelUrl, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const gltf = await new GLTFLoader().parseAsync(await response.arrayBuffer(), "");
      for (const scene of gltf.scenes) scene.traverse(object => {
        if (!(object instanceof Mesh)) return;
        geometries.add(object.geometry);
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
      });
      gltf.scene.updateMatrixWorld(true);
      const named = new Map<string, BufferGeometry>();
      gltf.scene.traverse(object => {
        if (!(object instanceof Mesh)) return;
        const geometry = object.geometry;
        if (!object.name || named.has(object.name) || !geometry.index ||
            !geometry.getAttribute("position") || !geometry.getAttribute("normal") || !geometry.getAttribute("color")) {
          throw new Error(`Invalid bonus mesh: ${object.name}`);
        }
        geometry.applyMatrix4(object.matrixWorld);
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        named.set(object.name, geometry);
      });
      for (const name of [...BONUS_MODEL_NAMES, "effect-smoke"])
        if (!named.has(name)) throw new Error(`Missing bonus model: ${name}`);
      const retained = new Set(named.values());
      for (const geometry of geometries) if (!retained.has(geometry)) geometry.dispose();
      return new BonusModels(named);
    } catch (cause) {
      for (const geometry of geometries) geometry.dispose();
      const error = new Error("Failed to load bonus models");
      (error as Error & { cause?: unknown }).cause = cause;
      throw error;
    } finally {
      clearTimeout(timeout);
      for (const material of materials) material.dispose();
    }
  }

  get(name: string): BufferGeometry {
    if (this.disposed) throw new Error("BonusModels is disposed");
    const geometry = this.geometries.get(name);
    if (!geometry) throw new Error(`Missing bonus model: ${name}`);
    return geometry;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const geometry of new Set(this.geometries.values())) geometry.dispose();
  }
}

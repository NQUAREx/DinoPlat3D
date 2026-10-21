import { Rules } from "./config";
import { Tuning, TUNING_DEFAULTS } from "./tuning";
import { GestureRecognizer } from "./gesture";
import { PickupMotion } from "./pickup-motion";
import type { Simulation } from "./simulation";
import type { View } from "./view";
import { ObjectKind } from "./world";
import { panelScroll } from "./panel-scroll";

export const AUTHOR_CODE_HASH =
  "e1a8ff1716d3bfbad96e1ac07b7db002c4b5711a181a242baae8e2b8104f18a6";
export class DeveloperDevice {
  static readonly cookie = "dinorun-developer";
  enabled = false;
  constructor(
    private readonly path: string,
    private readonly doc: Pick<Document, "cookie"> = document,
  ) {
    this.enabled = doc.cookie
      .split(";")
      .some((v) => v.trim() === `${DeveloperDevice.cookie}=1`);
  }
  async unlock(code: string) {
    const bytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(code.trim()),
    );
    const hash = Array.from(new Uint8Array(bytes), (v) =>
      v.toString(16).padStart(2, "0"),
    ).join("");
    if (hash !== AUTHOR_CODE_HASH) return false;
    this.enabled = true;
    this.doc.cookie = `${DeveloperDevice.cookie}=1; Path=${this.path}; Max-Age=31536000; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
    return true;
  }
}
type Field = {
  id: string;
  group: string;
  get: () => number;
  set: (value: number) => void;
  min: number;
  max: number;
  step: number;
  readOnly?: boolean;
};
const STRUCTURAL = new Set([
  "step",
  "turnScoreHoldLimit",
  "turnScoreReleaseDelay",
  "cactusScale",
  "chunkSize",
  "candidatesPerChunk",
  "pickupsPerChunk",
  "slotsPerChunk",
  "rowSlots",
  "maxColumns",
  "poolSize",
  "runFramesPerMetre",
]);
const LIMITS: Record<string, [number, number, number]> = {
  "rules.startSpeed": [2, 24, 0.1],
  "rules.maxSpeed": [2, 48, 0.1],
  "rules.turnSpeed": [0.2, 5, 0.05],
  "rules.pickupSpawnChance": [0, 1, 0.01],
  "rules.cactusHitScale": [0.1, 1.5, 0.01],
  "rules.blockingRadius": [0.05, 1, 0.01],
  "rules.playerRadius": [0.1, 1, 0.01],
  "rules.gravity": [5, 80, 0.1],
  "rules.jumpSpeed": [3, 30, 0.1],
  "rules.firstRow": [8, 80, 1],
  "rules.immunitySeconds": [0.1, 10, 0.1],
  "rules.hitStopSeconds": [0.05, 3, 0.05],
  "rules.deathSeconds": [0.5, 4, 0.05],
  "generation.acceptance": [0, 1, 0.01],
  "generation.speedPenalty": [0, 0.05, 0.001],
  "generation.speedGrowth": [0, 0.04, 0.001],
  "generation.accelerationTime": [0.1, 5, 0.1],
  "generation.highSpeedRelief": [0, 0.6, 0.05],
  "generation.corridorSpacing": [16, 64, 1],
  "generation.corridorPadding": [0.2, 5, 0.1],
  "generation.spacing": [1, 8, 0.1],
  "generation.pickupClearing": [0, 80, 1],
  "camera.offsetX": [-2, 2, 0.05],
  "camera.height": [1, 20, 0.1],
  "camera.distance": [1, 30, 0.1],
  "camera.targetY": [-2, 8, 0.1],
  "camera.targetZ": [-20, 5, 0.1],
  "camera.fov": [25, 90, 1],
  "camera.frontFov": [35, 90, 1],
  "camera.far": [40, 96, 1],
  "camera.fogStart": [5, 80, 1],
  "camera.fogEnd": [10, 96, 1],
  "camera.followDelay": [0.03, 2, 0.01],
  "camera.transitionSeconds": [0.05, 2, 0.01],
  "camera.frontEye": [0.3, 3, 0.01],
  "camera.frontDuck": [0, 1, 0.01],
  "camera.frontNear": [0.01, 0.2, 0.01],
  "camera.rearNear": [0.05, 0.5, 0.01],
  "camera.shake": [0, 3, 0.01],
  "camera.walkBob": [0, 0.1, 0.001],
  "camera.hitShake": [0, 0.12, 0.001],
  "camera.landShake": [0, 0.12, 0.001],
  "effects.stepDust": [0, 128, 1],
  "effects.landDust": [0, 256, 2],
  "effects.dustLife": [0.1, 2, 0.05],
  "effects.pickupFade": [0.1, 2, 0.05],
  "effects.pickupLift": [0.1, 3, 0.05],
  "effects.previewSpin": [0, 0.8, 0.01],
  "effects.previewDistance": [5, 16, 0.1],
  "effects.previewFov": [20, 60, 1],
  "rendering.pixelBudget": [300000, 2000000, 10000],
  "rendering.maxDpr": [1, 2, 0.1],
  "rendering.shadowHz": [1, 30, 1],
  "rendering.shadowLowHz": [1, 15, 1],
  "rendering.shadowBias": [-0.005, 0.005, 0.0001],
  "rendering.shadowNormalBias": [0, 0.1, 0.001],
  "audio.master": [0, 1, 0.01],
  "audio.music": [0, 1, 0.01],
  "audio.effects": [0, 1.5, 0.01],
  "landscape.heightScale": [0.2, 2, 0.1],
  "landscape.biomeSize": [32, 200, 1],
  "landscape.fallChance": [0, .6, .01],
  "landscape.birdChance": [0, .15, .01],
  "camera.slopeAhead": [4, 30, 1],
  "camera.slopeBehind": [2, 16, 1],
  "camera.slopeDelay": [0.1, 1.5, 0.05],
  "camera.slopeUp": [0, 1.2, 0.05],
  "camera.slopeDown": [0, 0.9, 0.05],
  "camera.slopeFov": [0, 24, 1],
  "camera.terrainClearance": [0.3, 4, 0.1],
};

/** Validated live bindings: no frame-loop reflection and no saved tuning values. */
export class DeveloperPanel {
  readonly device: DeveloperDevice;
  readonly root = document.getElementById("developer-panel")!;
  private readonly abort = new AbortController();
  private readonly fields: Field[] = [];
  private readonly inputs = new Map<
    string,
    { input: HTMLInputElement; output: HTMLOutputElement }
  >();
  private readonly defaults = new Map<string, number>();
  private readonly rules = Rules as unknown as Record<string, number>;
  constructor(
    private readonly game: Simulation,
    private readonly view: View,
    private readonly changed: () => void,
    path: string,
  ) {
    this.device = new DeveloperDevice(path);
    for (const [key, value] of Object.entries(this.rules))
      if (typeof value === "number")
        this.add(
          `rules.${key}`,
          "Физика и лимиты",
          () => this.rules[key],
          (v) => {
            this.rules[key] = v;
          },
          value,
          STRUCTURAL.has(key),
        );
    for (const [group, values] of Object.entries(Tuning))
      for (const key of Object.keys(values)) {
        const record = values as Record<string, number>;
        this.add(
          `${group}.${key}`,
          {
            generation: "Генерация",
            camera: "Камера",
            effects: "Эффекты",
            rendering: "Рендеринг",
            audio: "Аудио",
            landscape: "Ландшафт",
          }[group]!,
          () => record[key],
          (v) => {
            record[key] = v;
          },
          record[key],
        );
      }
    this.add(
      "input.holdDelay",
      "Управление",
      () => GestureRecognizer.holdDelay,
      (v) => {
        GestureRecognizer.holdDelay = v;
      },
      36,
      false,
      [0, 200, 1],
    );
    this.add(
      "pickups.amplitude",
      "Предметы",
      () => PickupMotion.amplitude,
      (v) => {
        PickupMotion.amplitude = v;
      },
      0.1,
      false,
      [0, 0.3, 0.01],
    );
    this.add(
      "pickups.period",
      "Предметы",
      () => PickupMotion.period,
      (v) => {
        PickupMotion.period = v;
      },
      2.4,
      false,
      [0.5, 8, 0.1],
    );
    this.add(
      "day.seconds",
      "Свет",
      () => view.lighting.cycle.cycleSeconds,
      (v) => {
        view.lighting.cycle.cycleSeconds = v;
      },
      360,
      false,
      [30, 1800, 10],
    );
    this.add(
      "day.hours",
      "Свет",
      () => view.lighting.cycle.hours,
      (v) => view.lighting.setTimeOfDay(v),
      9,
      false,
      [0, 24, 0.1],
    );
    for (const [axis, index] of [
      ["x", 0],
      ["y", 1],
      ["z", 2],
    ] as const)
      this.add(
        `light.${axis}`,
        "Свет",
        () => view.lighting.key.position.getComponent(index),
        (v) => {
          const p = view.lighting.key.position;
          view.lighting.setSunPosition(
            index === 0 ? v : p.x,
            index === 1 ? v : p.y,
            index === 2 ? v : p.z,
          );
        },
        view.lighting.key.position.getComponent(index),
        false,
        [-80, 80, 1],
      );
    this.build();
    this.syncAccess();
    panelScroll(
      document.getElementById("developer-fields")!,
      this.abort.signal,
    );
  }
  private add(
    id: string,
    group: string,
    get: () => number,
    set: (v: number) => void,
    value: number,
    readOnly = false,
    limits?: [number, number, number],
  ) {
    const [min, max, step] = limits ??
      LIMITS[id] ?? [0, Math.max(10, value * 3), value >= 10 ? 1 : 0.01];
    this.fields.push({ id, group, get, set, min, max, step, readOnly });
    this.defaults.set(id, value);
  }
  private build() {
    const root = document.getElementById("developer-fields")!,
      groups = new Map<string, HTMLElement>();
    for (const field of this.fields) {
      let group = groups.get(field.group);
      if (!group) {
        group = document.createElement("details");
        const heading = document.createElement("summary");
        heading.textContent = field.group;
        // Page-level touch guards suppress the native summary click. Handle
        // touch explicitly; keyboard activation remains accessible via click.
        heading.addEventListener("pointerup", (event) => {
          if (event.pointerType !== "touch" || !event.isPrimary) return;
          event.preventDefault();
          (group as HTMLDetailsElement).open = !(group as HTMLDetailsElement).open;
        }, { signal: this.abort.signal });
        heading.addEventListener("click", (event) => {
          event.preventDefault();
          if (event.detail === 0)
            (group as HTMLDetailsElement).open = !(group as HTMLDetailsElement).open;
        }, { signal: this.abort.signal });
        group.append(heading);
        groups.set(field.group, group);
        root.append(group);
      }
      const label = document.createElement("label"),
        name = document.createElement("span"),
        output = document.createElement("output"),
        input = document.createElement("input");
      name.textContent = field.id;
      input.type = "range";
      input.min = String(field.min);
      input.max = String(field.max);
      input.step = String(field.step);
      input.value = String(field.get());
      input.disabled = !!field.readOnly;
      input.dataset.parameter = field.id;
      output.value = String(field.get());
      if (field.readOnly)
        name.title =
          "Фиксированная структура пулов/ассетов. Не меняется во время кадра.";
      input.addEventListener(
        "input",
        () => {
          if (!this.device.enabled) return;
          this.set(field.id, Number(input.value));
          output.value = String(field.get());
          input.value = String(field.get());
        },
        { signal: this.abort.signal },
      );
      label.append(name, output, input);
      group.append(label);
      this.inputs.set(field.id, { input, output });
    }
  }
  set(id: string, value: number) {
    if (!this.device.enabled) return false;
    const field = this.fields.find((f) => f.id === id);
    if (!field || field.readOnly || !Number.isFinite(value)) return false;
    field.set(Math.min(field.max, Math.max(field.min, value)));
    Rules.maxSpeed = Math.max(Rules.startSpeed, Rules.maxSpeed);
    Rules.lodFar = Math.max(Rules.lodNear + 0.5, Rules.lodFar);
    Tuning.camera.fogEnd = Math.max(
      Tuning.camera.fogStart + 1,
      Tuning.camera.fogEnd,
    );
    this.apply(id);
    return true;
  }
  private apply(id: string) {
    if (
      id.startsWith("generation.") ||
      id.startsWith("landscape.") ||
      id.startsWith("rules.pickup") ||
      id === "rules.firstRow"
    ) {
      this.game.world.registry.setWeight(
        ObjectKind.Coin,
        Tuning.generation.coinWeight,
      );
      this.game.world.registry.setWeight(
        ObjectKind.Diamond,
        Tuning.generation.diamondWeight,
      );
      this.game.world.registry.setWeight(
        ObjectKind.Heart,
        Tuning.generation.heartWeight,
      );
      this.game.world.reset(this.game.seed);
      this.game.world.update(this.game.x, this.game.z);
    }
    this.view.applyTuning();
    this.changed();
  }
  reset() {
    if (!this.device.enabled) return;
    for (const field of this.fields)
      if (!field.readOnly) field.set(this.defaults.get(field.id)!);
    for (const [group, values] of Object.entries(TUNING_DEFAULTS))
      Object.assign(Tuning[group as keyof typeof Tuning], values);
    this.apply("generation.reset");
    this.view.lighting.setTimeOfDay(9, true);
    this.refresh();
  }
  refresh() {
    for (const field of this.fields) {
      const nodes = this.inputs.get(field.id)!;
      nodes.input.value = String(field.get());
      nodes.output.value = String(Math.round(field.get() * 10000) / 10000);
    }
  }
  open() {
    if (!this.device.enabled) return;
    this.root.hidden = false;
    this.root.classList.toggle("developer-live", this.game.phase === "running");
    this.refresh();
    this.changed();
  }
  close() {
    this.root.hidden = true;
    this.changed();
  }
  async unlock() {
    const input = document.getElementById("author-code") as HTMLInputElement,
      message = document.getElementById("author-message")!;
    try {
      const ok = await this.device.unlock(input.value);
      message.textContent = ok
        ? "Устройство разработчика. Параметры сбрасываются при перезагрузке."
        : "Неверный код.";
      input.value = "";
      input.blur();
      this.syncAccess();
    } catch {
      message.textContent = "Проверка кода недоступна в этом браузере.";
    }
  }
  private syncAccess() {
    for (const id of ["developer-toggle", "developer-live-toggle", "admin-toggle"]) {
      const button = document.getElementById(id)!;
      button.hidden = !this.device.enabled;
    }
  }
  dispose() {
    this.abort.abort();
  }
}

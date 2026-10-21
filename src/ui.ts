import type { Phase, Simulation } from "./simulation";
import { ShopUI } from "./shop-ui";
import type { CosmeticCategory, CosmeticInventory } from "./cosmetics";

/** DOM ownership and dirty counters live outside simulation/rendering. */
export class GameUI {
  private readonly app = this.element("app");
  private readonly overlay = this.element("overlay");
  readonly action = this.element<HTMLButtonElement>("action");
  readonly pauseButton = this.element<HTMLButtonElement>("pause");
  readonly cameraButton = this.element<HTMLButtonElement>("camera-mode");
  private readonly title = this.element("title");
  private readonly description = this.element("description");
  private readonly chapter = this.element("chapter");
  private readonly counters = [
    this.element("coins"),
    this.element("diamonds"),
    this.element("lives"),
    this.element("distance"),
    this.element("best"),
  ];
  private readonly shown = new Float64Array(5).fill(-1);
  private readonly hearts = this.element("lives").querySelectorAll("img");
  best = 0;
  phase: Phase | "loading" | "error" = "loading";
  private shop?: ShopUI;
  private runFinished = false;
  private recordTimer?: ReturnType<typeof setTimeout>;
  private readonly record = this.element("personal-record");
  private readonly motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  private readonly landscape = window.matchMedia("(orientation: landscape)");
  private readonly lifecycle = new AbortController();
  private readonly stopRecord = () => {
    clearTimeout(this.recordTimer);
    this.recordTimer = undefined;
    this.record.classList.remove("record-animate");
    this.record.hidden = true;
  };
  constructor() {
    try {
      const stored = Number(localStorage.getItem("dinoplat-3d-best"));
      this.best = Number.isFinite(stored) ? Math.max(0, Math.floor(stored)) : 0;
    } catch {
      /* Storage optional. */
    }
    const options = { signal: this.lifecycle.signal };
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.stopRecord();
    }, options);
    window.addEventListener("pagehide", this.stopRecord, options);
    window.addEventListener("blur", this.stopRecord, options);
    document.addEventListener("fullscreenchange", this.stopRecord, options);
    document.addEventListener("webkitfullscreenchange", this.stopRecord, options);
    this.motion.addEventListener("change", this.stopRecord, options);
    this.landscape.addEventListener("change", this.stopRecord, options);
  }
  private celebrateRecord() {
    if (document.hidden || this.landscape.matches) return;
    this.record.hidden = false;
    if (this.motion.matches) return;
    this.record.classList.add("record-animate");
    // One bounded timeout; no animation frames or particles allocated per run.
    this.recordTimer = setTimeout(() => {
      this.record.classList.remove("record-animate");
      this.recordTimer = undefined;
    }, 1600);
  }
  private element<T extends HTMLElement = HTMLElement>(id: string) {
    return document.getElementById(id) as T;
  }
  private format(value: number) {
    if (value >= 1e6) return `${Math.floor(value / 1000)}k`;
    return String(Math.floor(value));
  }
  loading() {
    this.action.disabled = true;
    this.action.textContent = "ЗАГРУЗКА…";
  }
  initializeShop(
    inventory: CosmeticInventory,
    choose: (id: string) => void,
    remove: (category: CosmeticCategory) => void,
  ) {
    this.shop = new ShopUI(
      this.element("shop-panel"),
      inventory,
      choose,
      remove,
    );
  }
  selectSection(section: "home" | "shop" | "settings" | "help") {
    if (section !== "home") this.stopRecord();
    if (this.phase === "paused") {
      this.showPause(
        section === "settings"
          ? "settings"
          : section === "help"
            ? "help"
            : "pause",
      );
      return;
    }
    if (this.phase === "running" || this.phase === "dying") return;
    this.element("pause-panel").hidden = true;
    if (
      this.element("settings-panel").parentElement !==
      this.element("menu-content")
    )
      this.element("menu-content").append(this.element("settings-panel"));
    this.element("menu-shell").hidden = false;
    this.element("menu-content").append(this.element("help-panel"));
    this.element("menu-panel").hidden = section !== "home";
    this.element("shop-panel").hidden = section !== "shop";
    this.element("settings-panel").hidden = section !== "settings";
    this.element("help-panel").hidden = section !== "help";
    this.app.dataset.menu = section;
    for (const name of ["home", "shop", "settings", "help"])
      this.element(`${name}-toggle`).setAttribute(
        "aria-pressed",
        String(name === section),
      );
  }
  private showPause(section: "pause" | "settings" | "help" = "pause") {
    this.element("menu-shell").hidden = true;
    this.element("pause-panel").hidden = section !== "pause";
    this.element("overlay").append(this.element("settings-panel"));
    this.element("overlay").append(this.element("help-panel"));
    this.element("settings-panel").hidden = section !== "settings";
    this.element("help-panel").hidden = section !== "help";
    this.app.dataset.menu = section === "pause" ? "pause" : `pause-${section}`;
  }
  shopMessage(message: string) {
    this.element("shop-message").textContent = message;
  }
  update(game: Simulation) {
    const values0 = game.wallet.coins,
      values1 = game.wallet.diamonds,
      values2 = game.health.lives,
      values3 = Math.floor(game.distance),
      values4 = this.best;
    for (let i = 0; i < 5; i++) {
      const value =
        i === 0
          ? values0
          : i === 1
            ? values1
            : i === 2
              ? values2
              : i === 3
                ? values3
                : values4;
      if (this.shown[i] !== value) {
        this.shown[i] = value;
        if (i === 2) {
          this.counters[i].setAttribute("aria-label", `${value} из 3 жизней`);
          for (let h = 0; h < this.hearts.length; h++)
            this.hearts[h].classList.toggle("empty-heart", h >= value);
        } else {
          this.counters[i].textContent = this.format(value);
          if (i === 0) {
            this.element("menu-coins").textContent = this.format(value);
            this.element("shop-coins").textContent = this.format(value);
          }
          if (i === 1) {
            this.element("menu-diamonds").textContent = this.format(value);
            this.element("shop-diamonds").textContent = this.format(value);
          }
        }
      }
    }
    this.shop?.update();
    this.cameraButton.disabled =
      (game.phase !== "running" && game.phase !== "dying") ||
      !game.health.lives;
  }
  show(game: Simulation) {
    const phase = game.phase;
    if (phase !== "over") this.stopRecord();
    if (phase === "running" || phase === "ready") this.runFinished = false;
    this.phase = phase;
    this.app.dataset.phase = phase;
    this.overlay.hidden = phase === "running" || phase === "dying";
    this.showSettings(false);
    this.pauseButton.disabled = phase !== "running" && phase !== "dying";
    this.pauseButton.setAttribute("aria-label", "Пауза");
    this.element("result").hidden = phase !== "over";
    this.action.disabled = false;
    this.element("pause-title").textContent = "ПАУЗА";
    (this.element("resume") as HTMLButtonElement).disabled = false;
    if (phase === "over") {
      const distance = Number.isFinite(game.distance) ? Math.max(0, Math.floor(game.distance)) : 0;
      const newRecord = !this.runFinished && distance > this.best;
      if (!this.runFinished) {
        this.runFinished = true;
        if (newRecord) {
          this.best = distance;
          try {
            localStorage.setItem("dinoplat-3d-best", String(this.best));
          } catch {
            /* Optional. */
          }
          this.celebrateRecord();
        }
      }
      this.title.textContent = "ГЛАВНОЕ МЕНЮ";
      this.description.textContent = "";
      this.chapter.textContent = "";
      this.element("final-distance").textContent = this.format(game.distance);
      this.action.textContent = "НАЧАТЬ ЗАБЕГ →";
      this.element("live").textContent =
        `Конец игры. ${distance} метров.${newRecord ? " Новый рекорд." : ""}`;
    } else if (phase === "paused") {
      this.showPause();
    } else if (phase === "ready") {
      this.action.textContent = "ИГРАТЬ →";
      this.title.textContent = "ГЛАВНОЕ МЕНЮ";
      this.chapter.textContent = "";
      this.description.textContent = "";
    }
    this.element("menu-best").textContent = this.format(this.best);
    this.update(game);
  }
  showSettings(visible: boolean) {
    this.selectSection(visible ? "settings" : "home");
  }
  error(error: unknown) {
    this.stopRecord();
    this.selectSection("home");
    this.phase = "error";
    this.app.dataset.phase = "error";
    this.overlay.hidden = false;
    this.title.textContent = "ОШИБКА ЗАГРУЗКИ";
    this.description.textContent =
      error instanceof Error ? error.message : "Не удалось запустить игру.";
    this.action.disabled = false;
    this.action.textContent = "ЕЩЁ РАЗ";
  }
  graphicsLost() {
    this.stopRecord();
    this.showPause();
    this.overlay.hidden = false;
    this.action.disabled = true;
    this.element("pause-title").textContent = "ВОССТАНОВЛЕНИЕ ГРАФИКИ";
    (this.element("resume") as HTMLButtonElement).disabled = true;
  }
  dispose() {
    this.stopRecord();
    this.lifecycle.abort();
    this.shop?.dispose();
  }
}

import "./style.css";
import WebGL from "three/addons/capabilities/WebGL.js";
import { Simulation, STEP } from "./simulation";
import { Input } from "./input";
import { ModelLibrary } from "./models";
import { BiomeModels } from "./biome-models";
import { View } from "./view";
import { GameUI } from "./ui";
import { Haptics } from "./haptics";
import { GameSettings } from "./settings";
import { GameSound } from "./sound";
import { MobileBrowser } from "./mobile-browser";
import { CurrencyCookies } from "./currency-cookies";
import { GameEvent } from "./events";
import { CosmeticInventory } from "./cosmetics";
import { HelpUI } from "./help";
import { panelScroll } from "./panel-scroll";
import { DeveloperPanel } from "./developer";
import { Tuning } from "./tuning";
import { Currency } from "./progression";
import { Surface } from "./landscape";
import { ObjectKind } from "./world";
import { OnlineService } from "./online";
import { OnlineUI } from "./online-ui";

class GameApplication {
  readonly game = new Simulation(1979);
  private readonly ui = new GameUI();
  private readonly canvas = document.getElementById(
    "game",
  ) as HTMLCanvasElement;
  private readonly abort = new AbortController();
  private readonly landscape = matchMedia("(orientation: landscape)");
  private readonly haptics = new Haptics(this.game.events);
  private readonly sound = new GameSound(this.game.events, () => {
    const g = this.game, field = g.landscape;
    if (field.surfaceAt(g.x, g.z) === Surface.Bridge) return 9;
    return field.biomeAt(g.x, g.z) * 3 + Math.min(2, Math.floor(field.noise(g.x, g.z, 14, 37) * 3.4));
  });
  private readonly settings = new GameSettings();
  private view?: View;
  private input?: Input;
  private mobile?: MobileBrowser;
  private currency?: CurrencyCookies;
  private cosmetics?: CosmeticInventory;
  private developer?: DeveloperPanel;
  private online?: OnlineService;
  private onlineUI?: OnlineUI;
  private earnedCoins = 0;
  private menuTimer: ReturnType<typeof setTimeout> | undefined;
  private alive = true;
  private contextLost = false;
  private previous = 0;
  private accumulator = 0;
  private resumePhase: "running" | "dying" = "running";
  private raf = 0;
  private readonly debug = new URLSearchParams(location.search).has("debug");

  async initialize() {
    if (!MobileBrowser.supported()) {
      document.body.dataset.device = "unsupported";
      return;
    }
    this.mobile = new MobileBrowser(
      () => this.resizeViewport(),
      () => {
        this.pause();
        this.stopFrames();
      },
    );
    this.ui.loading();
    this.online = new OnlineService();
    this.onlineUI = new OnlineUI(this.online);
    this.sound.preload();
    this.currency = new CurrencyCookies(
      this.game.wallet,
      this.game.events,
      new URL(import.meta.env.BASE_URL, location.href).pathname,
    );
    this.cosmetics = new CosmeticInventory(this.game.wallet);
    new HelpUI(document.getElementById("help-content")!);
    for (const id of ["help-panel", "settings-panel", "leaderboard-panel", "admin-panel"])
      panelScroll(document.getElementById(id)!, this.abort.signal);
    panelScroll(document.querySelector<HTMLElement>("#nickname-gate .panel")!, this.abort.signal);
    this.ui.initializeShop(
      this.cosmetics,
      (id) => {
        const result = this.cosmetics!.choose(id);
        this.ui.shopMessage(
          result === "funds"
            ? "Не хватает монет или алмазов"
            : result === "purchased"
              ? "Куплено и надето!"
              : "Надето!",
        );
        this.sound.unlock();
        this.sound.menu(
          result === "funds" ? "error" : result === "purchased" ? "buy" : "ui",
        );
        this.currency?.flush();
        this.view?.applyCosmetics(this.cosmetics!);
        this.ui.update(this.game);
        this.view?.draw();
      },
      (category) => {
        this.cosmetics!.remove(category);
        this.sound.unlock();
        this.sound.menu("ui");
        this.view?.applyCosmetics(this.cosmetics!);
        this.ui.update(this.game);
        this.view?.draw();
      },
    );
    try {
      if (!WebGL.isWebGL2Available())
        throw new Error("Для игры нужен мобильный браузер с WebGL 2.");
      const [model, ground] = await Promise.allSettled([
        ModelLibrary.load(),
        BiomeModels.load(),
      ]);
      if (
        model.status === "rejected" ||
        ground.status === "rejected" ||
        !this.alive
      ) {
        if (model.status === "fulfilled") model.value.dispose();
        if (ground.status === "fulfilled") ground.value.dispose();
        if (!this.alive) return;
        throw model.status === "rejected"
          ? model.reason
          : (ground as PromiseRejectedResult).reason;
      }
      try {
        this.view = new View(
          this.canvas,
          model.value,
          ground.value,
          this.game,
          () => this.schedule(),
        );
      } catch (error) {
        model.value.dispose();
        ground.value.dispose();
        throw error;
      }
      await this.view.initialize();
      this.view.applyCosmetics(this.cosmetics);
      if (!this.alive) return;
      this.input = new Input(
        this.canvas,
        (direction) => {
          if (!this.landscape.matches || direction === 0)
            this.game.move(direction);
        },
        () => {
          if (!this.landscape.matches) this.game.jump();
        },
        () => {
          if (!this.landscape.matches) this.game.down();
        },
      );
      this.developer = new DeveloperPanel(
        this.game,
        this.view,
        () => {
          this.applySettings();
          this.input?.clear();
          this.view?.draw();
          this.schedule();
        },
        new URL(import.meta.env.BASE_URL, location.href).pathname,
      );
      this.bind();
      this.game.events.on(GameEvent.Collected, (kind, amount) => {
        if (kind === ObjectKind.Coin) this.earnedCoins += amount;
      });
      this.game.events.on(GameEvent.Hit, () => this.input?.clear());
      this.applySettings();
      this.ui.show(this.game);
      void this.onlineUI.init();
      if (HelpUI.firstVisit()) {
        this.ui.selectSection("help");
        HelpUI.seen();
      }
      this.schedule();
      if (this.debug)
        Object.assign(window, {
          __runner: {
            game: this.game,
            start: () => this.start(),
            pause: () => {
              this.pause();
              this.stopFrames();
            },
            stats: () => this.view!.stats(),
            render: () => this.view!.draw(),
            camera: this.view.rig,
            lighting: this.view.lighting,
            settings: this.settings,
            audio: () => this.sound.stats(),
            cosmetics: this.cosmetics,
            developer: this.developer,
            tuning: Tuning,
            mobile: () => this.mobile!.stats(),
            snapshot: () => ({
              phase: this.game.phase,
              x: this.game.x,
              y: this.game.y,
              diving: this.game.diving,
              crouch: this.game.crouch,
              bodyHeight: this.game.bodyHeight,
              steering: this.game.steering,
              distance: this.game.distance,
              speed: this.game.speed,
              lives: this.game.health.lives,
              coins: this.game.wallet.coins,
              diamonds: this.game.wallet.diamonds,
              orientationBlocked: this.landscape.matches,
              ...this.view!.stats(),
            }),
          },
        });
    } catch (error) {
      if (!this.alive) return;
      this.view?.dispose();
      this.view = undefined;
      this.ui.error(error);
      this.ui.action.addEventListener(
        "pointerup",
        (event) => {
          if (event.pointerType === "touch") location.reload();
        },
        { signal: this.abort.signal },
      );
      console.error(error);
    }
  }
  private bind() {
    const options = { signal: this.abort.signal };
    const touchButton = (button: HTMLButtonElement, handler: () => void) => {
      button.addEventListener(
        "pointerup",
        (event) => {
          if (
            event.pointerType !== "touch" ||
            !event.isPrimary ||
            button.disabled
          )
            return;
          event.preventDefault();
          this.sound.unlock();
          if (button.id !== "sound") this.sound.menu("ui");
          handler();
          this.ui.update(this.game);
          // Present the correct scene alongside menu DOM changes on WebKit;
          // otherwise its compositor can show the old world through Home.
          if (this.game.phase !== "running" && this.game.phase !== "dying")
            this.view?.draw();
          if (
            this.game.phase === "running" ||
            this.game.phase === "dying" ||
            this.view?.rig.transitioning
          )
            this.schedule();
          else if (this.view?.previewAnimating) this.schedule(true);
        },
        options,
      );
    };
    touchButton(this.ui.action, () => this.start());
    for (const section of ["leaderboard", "admin"] as const)
      touchButton(document.getElementById(`${section}-toggle`) as HTMLButtonElement, () => {
        if (section === "admin" && !this.developer?.device.enabled) return;
        this.ui.selectSection(section);
        void this.onlineUI?.refreshSection(section);
      });
    touchButton(this.ui.cameraButton, () => {
      if (!this.view) return;
      this.input?.clear();
      const rig = this.view.rig;
      rig.firstPerson = !rig.firstPerson;
      this.ui.cameraButton.setAttribute(
        "aria-pressed",
        String(rig.firstPerson),
      );
      this.ui.cameraButton.setAttribute(
        "aria-label",
        rig.firstPerson ? "Вид сзади" : "Вид от первого лица",
      );
      this.view.draw(1, 0);
      if (this.game.phase !== "running") this.previous = performance.now();
      this.schedule();
    });
    touchButton(
      document.getElementById("home-toggle") as HTMLButtonElement,
      () => this.ui.selectSection("home"),
    );
    touchButton(
      document.getElementById("shop-toggle") as HTMLButtonElement,
      () => this.ui.selectSection("shop"),
    );
    for (const id of ["help-toggle", "pause-help"])
      touchButton(document.getElementById(id) as HTMLButtonElement, () => {
        this.ui.selectSection("help");
        HelpUI.seen();
      });
    touchButton(
      document.getElementById("help-back") as HTMLButtonElement,
      () => {
        HelpUI.seen();
        this.ui.selectSection("home");
      },
    );
    for (const id of ["developer-toggle", "developer-live-toggle"])
      touchButton(document.getElementById(id) as HTMLButtonElement, () =>
        this.developer?.open(),
      );
    touchButton(
      document.getElementById("developer-close") as HTMLButtonElement,
      () => this.developer?.close(),
    );
    touchButton(
      document.getElementById("developer-reset") as HTMLButtonElement,
      () => this.developer?.reset(),
    );
    touchButton(
      document.getElementById("developer-pause") as HTMLButtonElement,
      () =>
        this.game.phase === "running"
          ? this.pause()
          : this.game.phase === "paused"
            ? this.start()
            : undefined,
    );
    for (const [name, currency] of [
      ["coins", Currency.Coin],
      ["diamonds", Currency.Diamond],
    ] as const)
      touchButton(
        document.getElementById(`developer-${name}`) as HTMLButtonElement,
        () => {
          if (!this.developer?.device.enabled) return;
          this.game.wallet.add(currency, 1000);
          this.currency?.flush();
        },
      );
    touchButton(
      document.getElementById("developer-day") as HTMLButtonElement,
      () =>
        this.view?.lighting.setTimeOfDay(this.view.lighting.cycle.hours, true),
    );
    touchButton(
      document.getElementById("author-unlock") as HTMLButtonElement,
      () => {
        void this.developer?.unlock();
      },
    );
    touchButton(document.getElementById("resume") as HTMLButtonElement, () =>
      this.start(),
    );
    touchButton(
      document.getElementById("pause-settings") as HTMLButtonElement,
      () => this.ui.showSettings(true),
    );
    touchButton(
      document.getElementById("fullscreen") as HTMLButtonElement,
      () => {
        void this.mobile?.enterFullscreen();
      },
    );
    touchButton(this.ui.pauseButton, () =>
      this.game.phase === "paused" ? this.start() : this.pause(),
    );
    const vibration = document.getElementById("vibration") as HTMLButtonElement;
    touchButton(vibration, () => {
      this.settings.vibration = !this.settings.vibration;
      this.applySettings();
    });
    touchButton(document.getElementById("sound") as HTMLButtonElement, () => {
      this.settings.sound = !this.settings.sound;
      this.applySettings();
      if (this.settings.sound) this.sound.unlock();
    });
    touchButton(document.getElementById("music") as HTMLButtonElement, () => {
      this.settings.music = !this.settings.music;
      this.applySettings();
      this.sound.unlock();
    });
    touchButton(
      document.getElementById("settings-toggle") as HTMLButtonElement,
      () => this.ui.showSettings(true),
    );
    touchButton(
      document.getElementById("settings-back") as HTMLButtonElement,
      () => this.ui.showSettings(false),
    );
    this.landscape.addEventListener(
      "change",
      () => this.mobile?.requestResize(),
      options,
    );
    window.addEventListener(
      "blur",
      () => {
        this.pause();
        this.stopFrames();
      },
      options,
    );
    window.addEventListener("focus", () => this.schedule(), options);
    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.hidden) {
          this.pause();
          this.stopFrames();
        } else this.schedule();
      },
      options,
    );
    this.canvas.addEventListener(
      "webglcontextlost",
      (event) => {
        event.preventDefault();
        this.contextLost = true;
        this.pause();
        this.stopFrames();
        this.ui.graphicsLost();
      },
      options,
    );
    this.canvas.addEventListener(
      "webglcontextrestored",
      () => {
        this.contextLost = false;
        this.view?.restoreContext();
        this.ui.show(this.game);
        this.view?.resize();
        this.schedule();
      },
      options,
    );
    window.addEventListener(
      "pagehide",
      (event) => {
        if (!event.persisted) this.dispose();
      },
      options,
    );
  }
  private resizeViewport() {
    if (this.landscape.matches) {
      this.pause();
      this.stopFrames();
    }
    this.view?.resize();
    this.input?.resize();
    this.schedule();
  }
  private applySettings() {
    this.haptics.enabled = this.settings.vibration;
    this.sound.configure(this.settings.sound, this.settings.music);
    if (!this.haptics.enabled) this.haptics.stop();
    if (this.view) this.view.rig.shakeMultiplier = Tuning.camera.shake;
    for (const key of ["vibration", "sound", "music"] as const) {
      const button = document.getElementById(key)!;
      button.setAttribute("aria-pressed", String(this.settings[key]));
      button.textContent = `${key === "vibration" ? "ВИБРАЦИЯ" : key === "music" ? "МУЗЫКА" : "ЗВУК"}: ${this.settings[key] ? "ДА" : "НЕТ"}`;
    }
    this.settings.save();
  }
  start() {
    if (!this.onlineUI?.canPlay) {
      this.onlineUI?.requireNickname();
      return;
    }
    if (
      !this.alive ||
      this.contextLost ||
      this.landscape.matches ||
      this.game.phase === "running" ||
      this.game.phase === "dying"
    )
      return;
    void this.mobile?.enterFullscreen();
    if (this.game.phase !== "paused") {
      this.earnedCoins = 0;
      this.online?.startRun();
      this.game.reset((Math.random() * 0xffffffff) >>> 0);
    }
    this.game.phase =
      this.game.phase === "paused" ? this.resumePhase : "running";
    this.haptics.stop();
    this.sound.unlock();
    this.sound.setRunning(this.game.phase === "running");
    this.online?.setRunning(this.game.phase === "running");
    this.input?.clear();
    this.previous = this.accumulator = 0;
    this.ui.show(this.game);
    this.schedule();
  }
  pause() {
    this.online?.setRunning(false);
    void this.online?.heartbeat(true);
    this.currency?.flush();
    this.input?.clear();
    this.haptics.stop();
    this.sound.suspend();
    this.sound.setRunning(false);
    if (this.game.phase !== "running" && this.game.phase !== "dying") return;
    this.resumePhase = this.game.phase;
    this.game.phase = "paused";
    this.previous = this.accumulator = 0;
    this.ui.show(this.game);
  }
  private stopFrames() {
    clearTimeout(this.menuTimer);
    this.menuTimer = undefined;
    cancelAnimationFrame(this.raf);
    this.raf = this.previous = this.accumulator = 0;
  }
  private schedule(menu = false) {
    if (menu) {
      if (!this.menuTimer)
        this.menuTimer = setTimeout(() => {
          this.menuTimer = undefined;
          this.schedule();
        }, 33);
      return;
    }
    clearTimeout(this.menuTimer);
    this.menuTimer = undefined;
    if (
      !this.raf &&
      this.alive &&
      !document.hidden &&
      !this.contextLost &&
      !this.landscape.matches
    )
      this.raf = requestAnimationFrame(this.frame);
  }
  private readonly frame = (now: number) => {
    this.raf = 0;
    if (
      !this.alive ||
      !this.view ||
      document.hidden ||
      this.contextLost ||
      this.landscape.matches
    )
      return;
    const dt = this.previous ? (now - this.previous) / 1000 : 0;
    this.previous = now;
    if (
      dt > 0.5 &&
      (this.game.phase === "running" || this.game.phase === "dying")
    )
      this.pause();
    this.input?.update(now);
    if (this.game.phase === "running" || this.game.phase === "dying") {
      this.accumulator += Math.min(dt, 0.25);
      while (
        this.accumulator >= STEP &&
        (this.game.phase === "running" || this.game.phase === "dying")
      ) {
        this.game.step(STEP);
        this.accumulator -= STEP;
      }
      this.view.adapt(dt);
    }
    if (this.ui.phase !== this.game.phase) {
      if (this.game.phase === "dying") this.online?.setRunning(false);
      if (this.game.phase === "over") {
        // One lifecycle submission, no telemetry/network work per simulation step.
        void this.online?.finishRun({ score: this.game.scoreDistance, coins: this.earnedCoins, durationMs: this.game.time * 1000 });
      }
      if (this.game.phase !== "running") this.sound.setRunning(false);
      this.input?.clear();
      this.ui.show(this.game);
    }
    this.ui.update(this.game);
    this.view.draw(
      this.game.phase === "running" || this.game.phase === "dying"
        ? this.accumulator / STEP
        : 1,
      Math.min(dt, 0.25),
    );
    if (
      this.game.phase === "running" ||
      this.game.phase === "dying" ||
      this.view.rig.transitioning
    )
      this.schedule();
    else if (this.view.previewAnimating) this.schedule(true);
  };
  dispose() {
    if (!this.alive) return;
    this.alive = false;
    this.stopFrames();
    this.abort.abort();
    this.mobile?.dispose();
    this.currency?.dispose();
    this.input?.dispose();
    this.haptics.dispose();
    this.sound.dispose();
    this.developer?.dispose();
    this.onlineUI?.dispose();
    this.online?.dispose();
    this.ui.dispose();
    this.view?.dispose();
    this.view = undefined;
    this.game.events.dispose();
    if (this.debug)
      delete (window as unknown as Record<string, unknown>).__runner;
  }
}

const application = new GameApplication();
void application.initialize();
if (import.meta.hot) import.meta.hot.dispose(() => application.dispose());

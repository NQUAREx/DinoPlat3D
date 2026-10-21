import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { createServer } from "vite";

// Standalone browser regression (excluded from npm test's tests/*.test.ts glob).
// Run: node tests/personal-record-browser.mjs
// Requires an existing Chromium: CHROMIUM_PATH overrides /usr/bin/chromium.
// Starts its own temporary Vite server; no game renderer or mobile route suite.
test("personal record: strict previous-best comparison, finite effect and lifecycle cleanup", { timeout: 30000 }, async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      headless: true,
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const html = (await readFile(new URL("../index.html", import.meta.url), "utf8"))
      .replace('<script type="module" src="/src/main.ts"></script>', '<link rel="stylesheet" href="/src/style.css">');
    // Exercise the actual DOM and stylesheet without allocating a game renderer.
    await page.route("**/__record-test", route => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(`${server.resolvedUrls.local[0]}__record-test`);
    const result = await page.evaluate(async () => {
      const modulePath = "/src/ui.ts";
      const { GameUI } = await import(/* @vite-ignore */ modulePath);
      const ui = new GameUI();
      const game = { phase: "ready", distance: 0, wallet: { coins: 0, diamonds: 0 }, health: { lives: 3 } };
      const badge = document.getElementById("personal-record");
      const show = (phase, distance = game.distance) => {
        game.phase = phase;
        game.distance = distance;
        ui.show(game);
      };
      const check = (condition, message) => { if (!condition) throw Error(message); };
      localStorage.removeItem("dinoplat-3d-best");
      ui.best = 0;
      show("ready");
      show("running", 0);
      show("over", 0.99);
      check(badge.hidden && ui.best === 0, "zero whole metres is not a record");
      show("running");
      show("over", 12.9);
      check(!badge.hidden && ui.best === 12, "first positive record celebrates");
      check(localStorage.getItem("dinoplat-3d-best") === "12", "record stored after comparison");
      check(document.getElementById("live").textContent.includes("Новый рекорд"), "record announced once");
      check(badge.getAnimations({ subtree: true }).length === 7, "badge and six finite confetti animations");
      check(badge.getAnimations({ subtree: true }).every(a => a.effect.getTiming().iterations === 1 && Number(a.effect.getTiming().duration) <= 2000), "all animation budgets bounded");
      const animation = badge.querySelector("img").getAnimations()[0];
      show("over");
      check(badge.querySelector("img").getAnimations()[0] === animation, "duplicate over does not restart effect");
      ui.selectSection("shop");
      check(badge.hidden && badge.getAnimations({ subtree: true }).length === 0, "menu cancels effect");
      ui.selectSection("home");
      show("over", 99);
      check(badge.hidden && ui.best === 12, "same run never records twice");
      show("running");
      show("paused");
      show("running");
      show("over", 12.99);
      check(badge.hidden && ui.best === 12, "tie does not celebrate, including after pause");
      show("running");
      show("over", 8);
      check(badge.hidden && ui.best === 12, "lower run does not celebrate");
      show("running");
      show("over", 20);
      await new Promise(resolve => setTimeout(resolve, 1750));
      check(!badge.classList.contains("record-animate") && badge.getAnimations({ subtree: true }).length === 0, "effect settles with no running animation");
      check(!badge.hidden, "static badge remains on Home");
      show("running");
      check(badge.hidden, "restart hides badge");
      for (const event of ["blur", "pagehide"]) {
        show("running"); show("over", ui.best + 1);
        window.dispatchEvent(new Event(event));
        check(badge.hidden && badge.getAnimations({ subtree: true }).length === 0, `${event} cancels`);
        show("over"); check(badge.hidden, `${event} does not replay`);
      }
      show("running"); show("over", 28);
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
      check(badge.hidden && badge.getAnimations({ subtree: true }).length === 0, "background cancels");
      delete document.hidden;
      show("over"); check(badge.hidden, "foreground does not replay");
      show("running"); show("over", 30);
      ui.graphicsLost(); check(badge.hidden, "graphics loss cancels");
      const originalSet = Storage.prototype.setItem;
      Storage.prototype.setItem = () => { throw Error("blocked"); };
      show("running"); show("over", 40);
      check(ui.best === 40 && !badge.hidden, "blocked storage preserves session record");
      Storage.prototype.setItem = originalSet;
      ui.dispose();
      check(badge.hidden && badge.getAnimations({ subtree: true }).length === 0, "dispose cancels");
      return { best: ui.best, final: document.getElementById("final-distance").textContent };
    });
    assert.deepEqual(result, { best: 40, final: "40" });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(async () => {
      const modulePath = "/src/ui.ts";
      const { GameUI } = await import(/* @vite-ignore */ modulePath);
      const ui = new GameUI();
      const game = { phase: "running", distance: 50, wallet: { coins: 0, diamonds: 0 }, health: { lives: 3 } };
      ui.show(game); game.phase = "over"; ui.show(game);
      const badge = document.getElementById("personal-record");
      if (badge.hidden || badge.getAnimations({ subtree: true }).length) throw Error("reduced motion must show static badge");
      const rect = document.getElementById("action").getBoundingClientRect();
      if (rect.bottom > innerHeight || rect.height < 48) throw Error("Play control must remain visible and usable");
      ui.dispose();
    });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.evaluate(async () => {
      const modulePath = "/src/ui.ts";
      const { GameUI } = await import(/* @vite-ignore */ modulePath);
      localStorage.setItem("dinoplat-3d-best", "Infinity");
      const ui = new GameUI();
      if (ui.best !== 0) throw Error("non-finite stored best must be rejected");
      const game = { phase: "running", distance: 60, wallet: { coins: 0, diamonds: 0 }, health: { lives: 3 } };
      ui.show(game); game.phase = "over"; ui.show(game);
      window.recordUI = ui;
    });
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForFunction(() => document.getElementById("personal-record").hidden);
    await page.evaluate(() => window.recordUI.dispose());
  } finally {
    await browser?.close();
    await server.close();
  }
});

import assert from "node:assert/strict";
import { installOnlineFixture } from "./online-fixture.mjs";

export async function checkPolish(context, url, engine) {
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.addInitScript(() => {
      window.__previewDraws = 0;
      for (const name of ["drawElements", "drawElementsInstanced"]) {
        const original = WebGL2RenderingContext.prototype[name];
        WebGL2RenderingContext.prototype[name] = function (...args) {
          window.__previewDraws++;
          return original.apply(this, args);
        };
      }
      const original = AudioContext.prototype.createDynamicsCompressor;
      AudioContext.prototype.createDynamicsCompressor = function (...args) {
        const node = original.apply(this, args),
          analyser = this.createAnalyser(),
          mute = this.createGain();
        analyser.fftSize = 2048;
        mute.gain.value = 0;
        node.connect(analyser);
        analyser.connect(mute);
        mute.connect(this.destination);
        window.__audioProbe = analyser;
        return node;
      };
    });
    await installOnlineFixture(page);
    await page.goto(`${url}/?debug&time=9`);
    await page.waitForFunction(() => window.__runner?.stats().textures >= 4);
    await page.evaluate(() => {
      localStorage.removeItem("dinorun-cosmetics-v1");
    });
    await page.reload();
    await page.waitForFunction(() => window.__runner?.stats().preview.visible);
    await page.bringToFront();
    await page.evaluate(() => {
      // This fixture measures menu/audio/death animation, not unattended
      // survival while browser automation waits between UI actions.
      const g = window.__runner.game;
      g.landscape.enabled = false;
      g.world.registry.setWeight(0, 0);
      g.world.active.fill(0);
    });
    const tabs = await page
      .locator(".menu-tab")
      .evaluateAll((nodes) => nodes.map((n) => n.getBoundingClientRect().top));
    assert.ok(tabs[1] - tabs[0] < 90 && tabs[2] - tabs[1] < 90);
    const preview = await page.locator("#menu-avatar").boundingBox();
    assert.ok(preview.height >= 145);
    const before = await page.evaluate(
      () => window.__runner.stats().preview.yaw,
    );
    await page.evaluate(() => {
      const avatar = document.querySelector("#menu-avatar");
      Object.defineProperty(avatar, "setPointerCapture", {
        configurable: true,
        value: () => {},
      });
      for (const [type, x] of [
        ["pointerdown", 120],
        ["pointermove", 200],
        ["pointerup", 200],
      ])
        avatar.dispatchEvent(
          new PointerEvent(type, {
            pointerId: 98,
            pointerType: "touch",
            isPrimary: true,
            clientX: x,
            bubbles: true,
          }),
        );
      delete avatar.setPointerCapture;
    });
    await page.waitForFunction(
      (yaw) => window.__runner.stats().preview.yaw > yaw,
      before,
    );
    await page.waitForTimeout(100);
    const draws = await page.evaluate(() => window.__previewDraws);
    await page.waitForTimeout(200);
    assert.ok(
      (await page.evaluate(() => window.__previewDraws)) > draws,
      "Home auto-rotation must draw",
    );
    assert.equal(await page.locator("canvas").count(), 1);
    await page.tap("#shop-toggle");
    await page.waitForTimeout(100);
    const shopDraws = await page.evaluate(() => window.__previewDraws);
    await page.waitForTimeout(200);
    assert.equal(
      await page.evaluate(() => window.__previewDraws),
      shopDraws,
      "shop must remain idle",
    );
    assert.equal(await page.locator(".card-price .currency-icon").count(), 109);
    await page.evaluate(() => {
      const r = window.__runner;
      r.game.wallet.add(1, 2000);
    });
    const gold = page.locator('[data-item="dino-gold"]');
    await gold.scrollIntoViewIfNeeded();
    await gold.tap();
    assert.equal(
      await page.evaluate(() => window.__runner.cosmetics.equipped.dino),
      "dino-gold",
    );
    await page.tap("#home-toggle");
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await page.screenshot({ path: `test-results/${engine}-gold-preview.png` });
    await page.tap("#settings-toggle");
    if (!(await page.evaluate(() => window.__runner.settings.music)))
      await page.tap("#music");
    if (await page.evaluate(() => window.__runner.settings.sound))
      await page.tap("#sound");
    await page.tap("#settings-back");
    await page.tap("#action");
    await page.waitForFunction(
      () =>
        window.__runner.audio().loaded &&
        window.__runner.audio().state === "running",
    );
    await page.waitForFunction(() => window.__runner.audio().musicPlaying);
    assert.equal(
      await page.evaluate(() => window.__runner.audio().enabled),
      false,
    );
    await page.tap("#pause");
    assert.equal(await page.locator("#menu-shell").isVisible(), false);
    assert.equal(await page.locator("#pause-panel button").count(), 3);
    await page.tap("#pause-settings");
    await page.tap("#music");
    await page.tap("#sound");
    await page.tap("#settings-back");
    await page.tap("#resume");
    assert.equal(
      await page.evaluate(() => window.__runner.audio().musicPlaying),
      false,
    );
    const impact = await page.evaluate(async () => {
      const r = window.__runner,
        g = r.game,
        w = g.world;
      if (g.phase !== "running") throw Error(`Impact fixture requires running phase, got ${g.phase}`);
      g.health.lives = 1;
      g.health.immunity = 0;
      g.y = g.previousY = g.velocityY = 0;
      w.active.fill(0);
      w.active[0] = 1;
      w.kinds[0] = 0;
      w.motion[0] = 0;
      w.lean[0] = 0;
      w.x[0] = g.x;
      w.z[0] = g.z;
      w.halfX[0] = w.halfZ[0] = 0.4;
      w.height[0] = 3;
      w.baseY[0] = 0;
      g.step(1 / 120);
      const distance = g.distance,
        buf = new Float32Array(2048);
      let peak = 0;
      let sawFall = false;
      for (let i = 0; i < 400; i++) {
        await new Promise((resolve) => setTimeout(resolve, 15));
        window.__audioProbe.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const value of buf) sum += value * value;
        peak = Math.max(peak, Math.sqrt(sum / buf.length));
        sawFall ||= g.phase === "dying" && Math.abs(r.stats().playerRoll) > 0.2;
        if (g.phase === "over") break;
      }
      return {
        peak,
        distance,
        after: g.distance,
        health: g.health.lives,
        lastCue: r.audio().lastCue,
        sawFall,
      };
    });
    assert.equal(impact.health, 0);
    assert.equal(impact.distance, impact.after);
    assert.ok(impact.peak > 0.01, `actual collision/death RMS ${impact.peak}`);
    assert.equal(impact.sawFall, true);
    await page.waitForFunction(() => window.__runner.game.phase === "over");
    assert.equal(await page.locator("#menu-panel").isVisible(), true);
    assert.equal(await page.locator("#pause-panel").isVisible(), false);
    await page.reload();
    await page.waitForFunction(() => window.__runner?.stats().preview.visible);
    assert.equal(
      await page.evaluate(() => window.__runner.settings.music),
      false,
    );
    assert.equal(
      await page.evaluate(() => window.__runner.cosmetics.equipped.dino),
      "dino-gold",
    );
    assert.deepEqual(errors, []);
    return { impact, preview, tabs, errors };
  } finally {
    await page.close();
  }
}

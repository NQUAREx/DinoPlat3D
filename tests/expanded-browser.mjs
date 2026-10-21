import assert from "node:assert/strict";
import { installOnlineFixture } from "./online-fixture.mjs";

export async function checkExpansion(browser, url, engine) {
  const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    }),
    page = await context.newPage(),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /WebGLProgram|INVALID_OPERATION/.test(message.text())
    )
      errors.push(message.text());
  });
  try {
    await installOnlineFixture(page);
    await page.goto(`${url}/?debug&time=9`);
    await page.waitForFunction(
      () =>
        window.__runner &&
        document.querySelector("#app").dataset.phase === "ready",
    );
    assert.equal(await page.locator("#help-panel").isVisible(), true);
    assert.ok((await page.locator("[data-help]").count()) >= 11);
    assert.equal(await page.locator('[data-help="bonuses"]').count(), 0);
    await page.tap("#help-back");
    const d0 = await page.evaluate(
        () => window.__runner.stats().preview.distance,
      ),
      yaw0 = await page.evaluate(() => window.__runner.stats().preview.yaw);
    await page.waitForFunction(
      (yaw) => window.__runner.stats().preview.yaw > yaw + 0.01,
      yaw0,
    );
    await page.evaluate(() => {
      const avatar = document.querySelector("#menu-avatar");
      Object.defineProperty(avatar, "setPointerCapture", {
        configurable: true,
        value: () => {},
      });
      for (const [type, x] of [
        ["pointerdown", 100],
        ["pointermove", 240],
        ["pointerup", 240],
      ])
        avatar.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            pointerType: "touch",
            isPrimary: true,
            pointerId: 99,
            clientX: x,
          }),
        );
      delete avatar.setPointerCapture;
      window.__runner.render();
    });
    assert.equal(
      await page.evaluate(() => window.__runner.stats().preview.distance),
      d0,
    );
    await page.tap("#settings-toggle");
    await page.tap("#author-code");
    assert.equal(
      await page.evaluate(() => document.activeElement?.id),
      "author-code",
    );
    await page.setViewportSize({ width: 390, height: 280 });
    await page.waitForFunction(() => document.body.dataset.editing === "true");
    assert.equal(await page.locator("#author-code").isVisible(), true);
    assert.equal(await page.locator("#rotate").isVisible(), false);
    assert.equal(
      await page.evaluate(() => document.activeElement?.id),
      "author-code",
    );
    await page.keyboard.type("typing-check");
    assert.equal(
      await page.locator("#author-code").inputValue(),
      "typing-check",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.fill("#author-code", "wrong-code");
    await page.tap("#author-unlock");
    await page.waitForFunction(() =>
      document
        .querySelector("#author-message")
        .textContent.includes("Неверный"),
    );
    assert.equal(await page.locator("#developer-toggle").isVisible(), false);
    await context.addCookies([{ name: "dinorun-developer", value: "1", url }]);
    await page.reload();
    await page.waitForFunction(() => window.__runner?.developer.device.enabled);
    assert.equal(await page.locator("#help-panel").isVisible(), false);
    await page.tap("#developer-toggle");
    const sections = page.locator("#developer-fields summary");
    for (let i = 0; i < (await sections.count()); i++) {
      const heading = sections.nth(i);
      await heading.scrollIntoViewIfNeeded();
      await heading.tap();
      assert.equal(await heading.evaluate((e) => e.parentElement.open), true);
      await heading.tap();
      assert.equal(await heading.evaluate((e) => e.parentElement.open), false);
    }
    await page.tap("#developer-coins");
    await page.tap("#developer-diamonds");
    assert.deepEqual(
      await page.evaluate(() => [
        window.__runner.game.wallet.coins,
        window.__runner.game.wallet.diamonds,
      ]),
      [1000, 1000],
    );
    assert.ok((await page.locator("[data-parameter]").count()) >= 85);
    const tuned = await page.evaluate(() => {
      const r = window.__runner;
      r.developer.set("camera.height", 11);
      r.developer.set("generation.coinWeight", 333);
      r.developer.set("rules.startSpeed", 16);
      return {
        height: r.stats().cameraY,
        weight: r.game.world.registry.get(1).weight,
        speed: r.tuning.camera.height,
      };
    });
    assert.equal(tuned.height, 11);
    assert.equal(tuned.weight, 333);
    await page.reload();
    await page.waitForFunction(() => window.__runner?.developer.device.enabled);
    assert.deepEqual(
      await page.evaluate(() => [
        window.__runner.game.wallet.coins,
        window.__runner.game.wallet.diamonds,
      ]),
      [1000, 1000],
    );
    assert.equal(
      await page.evaluate(() => window.__runner.tuning.camera.height),
      8.5,
    );
    assert.equal(
      await page.evaluate(
        () => window.__runner.game.world.registry.get(1).weight,
      ),
      250,
    );
    await page.tap("#shop-toggle");
    assert.equal(await page.locator(".shop-card").count(), 110);
    for (const [category, count] of [
      ["dino", 24],
      ["hat", 23],
      ["boots", 23],
      ["watch", 20],
      ["gloves", 20],
    ])
      assert.equal(
        await page.locator(`[data-rail="${category}"] .shop-card`).count(),
        count,
      );
    await page.evaluate(() => {
      const w = window.__runner.game.wallet;
      w.add(0, 100000);
      w.add(1, 100000);
    });
    for (const id of [
      "watch-extra-01",
      "gloves-extra-04",
      "hat-extra-03",
      "boots-extra-06",
      "dino-extra-05",
    ]) {
      const card = page.locator(`[data-item="${id}"]`);
      await card.scrollIntoViewIfNeeded();
      await card.tap();
    }
    await page.tap("#home-toggle");
    const equipped = await page.evaluate(
      () => window.__runner.stats().cosmetics,
    );
    assert.equal(equipped.skinTriangles, 1182);
    assert.ok(
      equipped.watchVisible &&
        equipped.glovesVisible &&
        equipped.bootsVisible &&
        equipped.hatVisible,
    );
    assert.equal(equipped.watchParent, "dino-arm-l");
    await page.screenshot({
      path: `test-results/${engine}-expanded-equipped.png`,
    });
    await page.tap("#action");
    await page.tap("#developer-live-toggle");
    assert.equal(
      await page.evaluate(() => window.__runner.game.phase),
      "running",
    );
    assert.equal(
      await page.evaluate(() => "bonuses" in window.__runner.game),
      false,
    );
    await page.tap("#developer-close");
    await page.evaluate(() => window.__runner.pause());
    await page.tap("#pause-help");
    assert.equal(await page.locator("#help-panel").isVisible(), true);
    await page.tap("#help-back");
    assert.equal(await page.locator("#pause-panel").isVisible(), true);
    const effect = await page.evaluate(() => {
      const r = window.__runner,
        g = r.game,
        w = g.world;
      g.reset(987);
      g.phase = "running";
      w.active.fill(0);
      w.active[0] = 1;
      w.kinds[0] = 1;
      w.x[0] = g.x;
      w.z[0] = g.z + 0.15;
      w.halfX[0] = w.halfZ[0] = 0.46;
      w.height[0] = 0.75;
      w.baseY[0] = 0.5;
      g.step(1 / 120);
      r.render();
      const start = r.stats();
      g.feedbackTime += 0.2;
      g.previousFeedbackTime = g.feedbackTime;
      r.render();
      const middle = r.stats();
      g.feedbackTime += 0.4;
      g.previousFeedbackTime = g.feedbackTime;
      r.render();
      const end = r.stats();
      return {
        start: {
          count: start.pickupEffectCount,
          alpha: start.pickupEffectAlpha,
          y: start.pickupEffectY,
        },
        middle: {
          count: middle.pickupEffectCount,
          alpha: middle.pickupEffectAlpha,
          y: middle.pickupEffectY,
        },
        end: end.pickupEffectCount,
      };
    });
    assert.equal(effect.start.count, 1);
    assert.equal(effect.middle.count, 1);
    assert.ok(effect.middle.y > effect.start.y);
    assert.ok(
      effect.middle.alpha < effect.start.alpha && effect.middle.alpha > 0,
    );
    assert.equal(effect.end, 0);
    assert.deepEqual(errors, []);
    return { tuned, equipped, effect, errors };
  } finally {
    await context.close();
  }
}

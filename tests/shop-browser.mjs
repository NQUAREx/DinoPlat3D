import assert from "node:assert/strict";
import { installOnlineFixture } from "./online-fixture.mjs";

export async function checkShop(context, url, engine) {
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await installOnlineFixture(page);
    await page.goto(`${url}/?debug&time=9`);
    await page.waitForFunction(() => window.__runner?.stats().textures >= 4);
    await page.evaluate(() => {
      localStorage.removeItem("dinorun-cosmetics-v1");
      localStorage.setItem(
        "dinoplat-settings",
        JSON.stringify({ sound: true, vibration: true }),
      );
    });
    await page.reload();
    await page.waitForFunction(() => window.__runner?.stats().textures >= 4);
    assert.equal(
      await page.evaluate(() => window.__runner.audio().state),
      "uninitialized",
    );
    assert.equal(await page.locator("#menu-panel").isVisible(), true);
    assert.equal(
      await page.locator("#home-toggle").getAttribute("aria-pressed"),
      "true",
    );
    await page.screenshot({ path: `test-results/${engine}-main-menu.png` });
    await page.tap("#shop-toggle");
    assert.equal(await page.locator(".shop-card").count(), 110);
    for (const category of ["dino", "hat", "boots"])
      assert.equal(
        await page.locator(`[data-rail="${category}"] .shop-card`).count(),
        category === "dino" ? 24 : 23,
      );
    await page.waitForFunction(() => window.__runner.audio().loaded);
    const choose = async (id) => {
      await page.locator(`[data-item="${id}"]`).scrollIntoViewIfNeeded();
      await page.tap(`[data-item="${id}"]`);
    };
    await page.evaluate(() => {
      const w = window.__runner.game.wallet;
      w.coins = w.diamonds = 0;
      w.revision++;
    });
    await choose("dino-white");
    assert.match(await page.locator("#shop-message").innerText(), /Не хватает/);
    await page.evaluate(() => {
      const w = window.__runner.game.wallet;
      w.add(0, 2500);
      w.add(1, 2000);
    });
    await choose("dino-white");
    await choose("dino-white");
    assert.equal(
      await page.evaluate(() => window.__runner.game.wallet.coins),
      1750,
    );
    await choose("hat-safari");
    await choose("boots-red");
    await choose("dino-pink");
    const purchased = await page.evaluate(() => ({
      equipped: { ...window.__runner.cosmetics.equipped },
      coins: window.__runner.game.wallet.coins,
      diamonds: window.__runner.game.wallet.diamonds,
      render: window.__runner.stats().cosmetics,
      audio: window.__runner.audio(),
    }));
    assert.deepEqual(purchased.equipped, {
      dino: "dino-pink",
      hat: "hat-safari",
      boots: "boots-red",
      watch: "",
      gloves: "",
    });
    assert.equal(purchased.coins, 1120);
    assert.equal(purchased.diamonds, 1940);
    assert.equal(
      await page.locator("#shop-coins").innerText(),
      String(purchased.coins),
    );
    assert.equal(
      await page.locator("#shop-diamonds").innerText(),
      String(purchased.diamonds),
    );
    assert.equal(purchased.render.hatVisible, true);
    assert.equal(purchased.render.bootsVisible, true);
    assert.equal(purchased.render.hatParent, "dino-head");
    assert.equal(purchased.render.leftParent, "dino-shin-l");
    assert.equal(
      await page.evaluate(() => window.__runner.stats().preview.hatVisible),
      true,
    );
    assert.equal(
      await page.evaluate(() => window.__runner.stats().preview.bootsVisible),
      true,
    );
    assert.equal(purchased.audio.voices, 8);
    assert.ok(purchased.audio.played > 0);
    assert.ok(purchased.audio.decodedBytes < 4 * 1024 * 1024);
    const burst = await page.evaluate(() => {
      for (let i = 0; i < 80; i++) window.__runner.game.events.emit(6, i % 2);
      return window.__runner.audio();
    });
    assert.equal(burst.voices, 8);
    assert.ok(burst.activeVoices <= 8);
    let nativeDrag;
    if (context.browser().browserType().name() === "chromium") {
      await page.evaluate(() => {
        document.querySelector("#shop-panel").scrollTop = 0;
        document.querySelector('[data-rail="dino"]').scrollLeft = 0;
      });
      const rail = await page.locator('[data-rail="dino"]').boundingBox(),
        cdp = await context.newCDPSession(page);
      const before = await page.evaluate(() =>
        JSON.stringify(window.__runner.cosmetics.equipped),
      );
      const x = rail.x + rail.width - 20,
        y = rail.y + 50;
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y }],
      });
      for (let i = 1; i <= 4; i++)
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: x - i * 30, y }],
        });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await cdp.detach();
      nativeDrag = await page.evaluate(() => ({
        offset: document.querySelector('[data-rail="dino"]').scrollLeft,
        equipped: JSON.stringify(window.__runner.cosmetics.equipped),
      }));
      assert.ok(nativeDrag.offset > 0);
      assert.equal(nativeDrag.equipped, before);
    }
    // Deterministic pointer fixture exercises both horizontal/vertical local rails
    // under the global no-native-scroll guard. Drag must never buy/equip a card.
    const drag = await page.evaluate(() => {
      const root = document.querySelector("#shop-panel"),
        rail = document.querySelector('[data-rail="dino"]');
      root.scrollTop = 0;
      rail.scrollLeft = 0;
      const card = rail.querySelector("button"),
        before = JSON.stringify(window.__runner.cosmetics.equipped);
      // A synthetic pointer has no native active-pointer ID for capture. Real
      // taps above exercise capture; this fixture isolates rail classification.
      Object.defineProperty(root, "setPointerCapture", {
        configurable: true,
        value: () => {},
      });
      try {
        for (const [type, x] of [
          ["pointerdown", 260],
          ["pointermove", 100],
          ["pointerup", 100],
        ])
          card.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              pointerId: 91,
              pointerType: "touch",
              isPrimary: true,
              clientX: x,
              clientY: 200,
            }),
          );
      } finally {
        delete root.setPointerCapture;
      }
      return {
        offset: rail.scrollLeft,
        maximum: rail.scrollWidth - rail.clientWidth,
        before,
        after: JSON.stringify(window.__runner.cosmetics.equipped),
        pageX: scrollX,
        pageY: scrollY,
      };
    });
    assert.ok(drag.offset > 0);
    assert.ok(Math.abs(drag.offset - Math.min(160, drag.maximum)) < 1);
    assert.equal(drag.before, drag.after);
    assert.equal(drag.pageX, 0);
    assert.equal(drag.pageY, 0);
    const originalViewport = page.viewportSize();
    await page.setViewportSize({ width: 320, height: 568 });
    await page.waitForFunction(() => window.__runner.mobile().height === 568);
    const vertical = await page.evaluate(() => {
      const root = document.querySelector("#shop-panel");
      root.scrollTop = 0;
      const before = JSON.stringify(window.__runner.cosmetics.equipped);
      Object.defineProperty(root, "setPointerCapture", {
        configurable: true,
        value: () => {},
      });
      try {
        for (const [type, y] of [
          ["pointerdown", 450],
          ["pointermove", 250],
          ["pointerup", 250],
        ])
          root.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              pointerId: 92,
              pointerType: "touch",
              isPrimary: true,
              clientX: 150,
              clientY: y,
            }),
          );
      } finally {
        delete root.setPointerCapture;
      }
      return {
        offset: root.scrollTop,
        maximum: root.scrollHeight - root.clientHeight,
        before,
        after: JSON.stringify(window.__runner.cosmetics.equipped),
        pageY: scrollY,
      };
    });
    assert.ok(vertical.offset > 0);
    assert.ok(Math.abs(vertical.offset - Math.min(200, vertical.maximum)) < 1);
    assert.equal(vertical.before, vertical.after);
    assert.equal(vertical.pageY, 0);
    await page.setViewportSize(originalViewport);
    await page.waitForFunction(
      (height) => window.__runner.mobile().height === height,
      originalViewport.height,
    );
    await page.screenshot({ path: `test-results/${engine}-shop.png` });
    await page.reload();
    await page.waitForFunction(() => window.__runner?.stats().textures >= 4);
    assert.deepEqual(
      await page.evaluate(() => ({ ...window.__runner.cosmetics.equipped })),
      purchased.equipped,
    );
    assert.equal(
      await page.evaluate(() => window.__runner.game.wallet.coins),
      1120,
    );
    await page.bringToFront();
    await page.evaluate(() => {
      const g = window.__runner.game;
      g.world.registry.setWeight(0, 0);
      g.world.active.fill(0);
      g.landscape.enabled = false;
    });
    await page.tap("#action");
    await page.waitForFunction(() => window.__runner.audio().musicPlaying).catch(async error => {
      error.message += `\nAudio/start state: ${JSON.stringify(await page.evaluate(() => ({audio:window.__runner.audio(), phase:window.__runner.game.phase, hidden:document.hidden})))}`;
      throw error;
    });
    await page.evaluate(() => {
      const r = window.__runner;
      r.pause();
      r.game.phase = "over";
      r.game.distance = 321;
      window.dispatchEvent(new Event("resize"));
    });
    await page.waitForFunction(() => !document.querySelector("#result").hidden);
    assert.equal(await page.locator("#menu-panel").isVisible(), true);
    assert.equal(await page.locator("#menu-best").innerText(), "321");
    await page.tap("#action");
    await page.evaluate(() => window.__runner.pause());
    // Pause is deliberately separate from Home and Shop.
    assert.equal(await page.locator("#pause-panel").isVisible(), true);
    assert.equal(await page.locator("#menu-shell").isVisible(), false);
    assert.equal(await page.locator("#pause-panel button").count(), 3);
    assert.equal(await page.locator("#shop-panel").isVisible(), false);
    await page.tap("#pause-settings");
    await page.tap("#sound");
    assert.equal(
      await page.evaluate(() => window.__runner.audio().musicPlaying),
      false,
    );
    assert.equal(
      await page.evaluate(() => window.__runner.audio().activeVoices),
      0,
    );
    assert.equal(
      await page.evaluate(() => window.__runner.settings.music),
      true,
    );
    await page.tap("#music");
    assert.equal(
      await page.evaluate(() => window.__runner.settings.music),
      false,
    );
    await page.tap("#sound");
    assert.deepEqual(errors, []);
    return { purchased, drag, vertical, nativeDrag, burst, errors };
  } finally {
    await page.close();
  }
}

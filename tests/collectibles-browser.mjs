import assert from "node:assert/strict";
import { installOnlineFixture } from "./online-fixture.mjs";

/** Same render/collection checks in real Chromium and WebKit WebGL contexts. */
export async function checkCollectibles(context, url, engine) {
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && /WebGLProgram|VALIDATE_STATUS/.test(m.text()))
      errors.push(m.text());
  });
  try {
    await installOnlineFixture(page);
    await page.goto(`${url}/?debug&time=9`);
    await page.waitForFunction(() => window.__runner?.stats().textures >= 4);
    await page.tap("#action");
    await page.evaluate(() => window.__runner.pause());
    await page.addStyleTag({
      content: "#overlay { display: none !important; }",
    });
    const initial = await page.evaluate(() => {
      const r = window.__runner,
        g = r.game,
        w = g.world;
      g.x = g.previousX = 0;
      g.z = g.previousZ = g.distance = g.previousDistance = 200;
      w.update(0, 200);
      w.active.fill(0);
      g.time = g.previousTime = 0;
      for (let i = 0; i < 3; i++) {
        w.active[i] = 1;
        w.kinds[i] = [1, 2, 5][i];
        w.variants[i] = 0;
        w.x[i] = (i - 1) * 2.3;
        w.z[i] = 202.8;
        w.baseY[i] = 0.5;
        w.halfX[i] = w.halfZ[i] = 0.65;
        w.height[i] = 0.75;
      }
      r.render();
      const gl = document.querySelector("#game").getContext("webgl2");
      const data = new Uint8Array(
        gl.drawingBufferWidth * gl.drawingBufferHeight * 4,
      );
      gl.readPixels(
        0,
        0,
        gl.drawingBufferWidth,
        gl.drawingBufferHeight,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        data,
      );
      let gold = 0,
        cyan = 0,
        red = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > 180 && data[i + 1] > 100 && data[i + 2] < 70) gold++;
        if (data[i] < 85 && data[i + 1] > 110 && data[i + 2] > 110) cyan++;
        if (data[i] > 160 && data[i + 1] < 100 && data[i + 2] < 100) red++;
      }
      return { ...r.stats(), gold, cyan, red, glError: gl.getError() };
    });
    assert.equal(initial.visibleCoins, 1);
    assert.equal(initial.visibleDiamonds, 1);
    assert.equal(initial.visibleHearts, 1);
    await page.screenshot({
      path: `test-results/${engine}-voxel-pickups-front.png`,
    });
    assert.ok(
      initial.gold > 20 && initial.cyan > 20 && initial.red > 20,
      JSON.stringify(initial),
    );
    assert.equal(initial.glError, 0);
    assert.equal(initial.textures, 5);
    const animated = await page.evaluate(() => {
      const r = window.__runner;
      r.game.time = r.game.previousTime = 0.3;
      r.render();
      return r.stats();
    });
    assert.ok(animated.pickupAngle > 0.7 && animated.pickupBob > 0.07);
    await page.screenshot({
      path: `test-results/${engine}-voxel-pickups-turn.png`,
    });
    await page.waitForTimeout(150);
    assert.equal(
      await page.evaluate(() => window.__runner.stats().pickupAngle),
      animated.pickupAngle,
    );
    const collected = await page.evaluate(() => {
      const r = window.__runner,
        g = r.game,
        w = g.world;
      w.active.fill(0);
      g.wallet.reset();
      g.health.lives = 1;
      g.health.immunity = 2;
      g.x = g.previousX = 0;
      g.y = g.previousY = 0;
      g.velocityY = 0;
      g.phase = "running";
      for (let i = 0; i < 3; i++) {
        w.active[i] = 1;
        w.kinds[i] = [1, 2, 5][i];
        w.x[i] = 0;
        w.z[i] = g.z + 0.15;
        w.baseY[i] = 0.5;
        w.height[i] = 0.75;
        w.halfX[i] = w.halfZ[i] = 0.46;
      }
      g.step(1 / 120);
      g.phase = "paused";
      r.render();
      return {
        coins: g.wallet.coins,
        diamonds: g.wallet.diamonds,
        lives: g.health.lives,
        consumed: !w.active[0] && !w.active[1] && !w.active[2],
      };
    });
    assert.deepEqual(collected, {
      coins: 1,
      diamonds: 1,
      lives: 2,
      consumed: true,
    });
    // Run one normal application frame to refresh dirty HUD values.
    await page.evaluate(() => {
      window.__runner.game.phase = "running";
      window.dispatchEvent(new Event("resize"));
    });
    await page.waitForFunction(
      () =>
        document.querySelector("#coins").textContent === "1" &&
        document.querySelector("#diamonds").textContent === "1" &&
        document.querySelectorAll("#lives .empty-heart").length === 1,
    );
    await page.evaluate(() => window.__runner.pause());
    assert.deepEqual(errors, []);
    await page.evaluate(() => {
      const r = window.__runner;
      r.game.phase = "over";
      r.start();
      r.pause();
    });
    assert.equal(
      await page.evaluate(() => window.__runner.game.wallet.coins),
      1,
    );
    const saved = (await context.cookies()).find(
      (c) => c.name === "dinoplat3d-wallet-v1",
    );
    assert.equal(saved?.value, "1.1.1");
    assert.equal(saved?.sameSite, "Lax");
    await page.reload();
    await page.waitForFunction(() => window.__runner?.stats().textures >= 4);
    assert.equal(
      await page.evaluate(() => window.__runner.game.wallet.coins),
      1,
    );
    assert.equal(
      await page.evaluate(() => window.__runner.game.wallet.diamonds),
      1,
    );
    return { initial, animated, collected, persistent: true, errors };
  } finally {
    await page.close();
    await context.clearCookies({ name: "dinoplat3d-wallet-v1" });
  }
}

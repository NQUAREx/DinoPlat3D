import assert from "node:assert/strict";
import { installOnlineFixture } from "./online-fixture.mjs";

export async function checkTurning(context, url, engine) {
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && /WebGLProgram/.test(m.text()))
      errors.push(m.text());
  });
  try {
    await installOnlineFixture(page);
    await page.goto(`${url}/?debug&time=9`);
    await page.waitForFunction(() => window.__runner?.stats().textures >= 4);
    const result = await page.evaluate(() => {
      const r = window.__runner,
        g = r.game;
      r.pause();
      g.reset(1979);
      g.phase = "paused";
      g.z = g.previousZ = 200;
      g.distance = g.previousDistance = 12345;
      g.world.update(g.x, g.z);
      g.world.active.fill(0);
      r.lighting.shadowsEnabled = false;
      for (let i = 0; i < 3; i++) {
        const w = g.world;
        w.active[i] = 1;
        w.kinds[i] = 0;
        w.variants[i] = 2;
        w.x[i] = 0;
        w.z[i] = 200 + [10, 31, 42][i];
        w.angles[i] = 0;
        w.halfX[i] = 0.7;
        w.halfZ[i] = 0.4;
        w.height[i] = 2.1;
        w.baseY[i] = 0;
      }
      r.render();
      const lod = r.stats();
      g.world.active.fill(0);
      g.phase = "running";
      g.health.immunity = 1e9;
      g.move(1);
      for (let i = 0; i < 600; i++) {
        g.step(1 / 120);
        if (i % 4 === 0) {
          r.camera.update(g.distance, 0, 1 / 30, true, g.heading);
          r.render();
        }
      }
      const lag = Math.abs(g.heading - r.camera.heading),
        direction = g.heading;
      g.move(0);
      const before = g.distance;
      for (let i = 0; i < 30; i++) g.step(1 / 120);
      g.phase = "paused";
      r.render();
      const gl = document.querySelector("#game").getContext("webgl2");
      return {
        lod,
        lag,
        direction,
        afterDirection: g.heading,
        moved: g.distance - before,
        path: g.distance,
        position: [g.x, g.z],
        final: r.stats(),
        glError: gl.getError(),
        canvasFilter: getComputedStyle(document.querySelector("#game"))
          .imageRendering,
      };
    });
    assert.equal(result.lod.cactusNearInstances, 2);
    assert.equal(result.lod.cactusFarInstances, 2);
    assert.deepEqual(
      result.lod.cactusLodTriangles,
      [192, 192, 48, 192, 168, 192, 192],
    );
    assert.ok(result.lag > 0.5 && result.lag < 0.9);
    assert.ok(result.direction < -Math.PI * 2);
    assert.equal(result.direction, result.afterDirection);
    assert.ok(result.moved > 2);
    assert.equal(result.final.obstacleCapacity, 2250);
    assert.ok(result.final.pixelRatio >= 1);
    assert.equal(result.canvasFilter, "auto");
    assert.equal(result.glError, 0);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `test-results/${engine}-turning-lod.png` });
    return result;
  } finally {
    await page.close();
  }
}

export async function checkRetina(browser, url, engine) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
  });
  try {
    const page = await context.newPage();
    await installOnlineFixture(page);
    await page.goto(`${url}/?debug&time=9`);
    await page.waitForFunction(() => window.__runner?.stats().textures >= 4);
    const stats = await page.evaluate(() => window.__runner.stats());
    await page.evaluate(() => {
      document.querySelector("#overlay").hidden = true;
      document.querySelector("#app").dataset.phase = "running";
      window.__runner.render();
    });
    assert.ok(stats.pixelRatio > 1.9);
    assert.ok(stats.width * stats.height <= 1300000);
    assert.equal(
      await page
        .locator("#game")
        .evaluate((n) => getComputedStyle(n).imageRendering),
      "auto",
    );
    await page.screenshot({ path: `test-results/${engine}-retina-render.png` });
    return {
      pixelRatio: stats.pixelRatio,
      width: stats.width,
      height: stats.height,
      antialias: stats.antialias,
    };
  } finally {
    await context.close();
  }
}

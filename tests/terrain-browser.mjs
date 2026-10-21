import assert from "node:assert/strict";
import { installOnlineFixture } from "./online-fixture.mjs";

/** Fixed world-space view while the floating origin crosses cell/hash seams. */
export async function checkTerrainMotion(context, url, engine) {
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await installOnlineFixture(page);
    await page.goto(`${url}/?debug&time=9`);
    await page.waitForFunction(() => window.__runner?.stats().textures >= 4);
    const result = await page.evaluate(() => {
      const r = window.__runner,
        g = r.game;
      g.phase = "paused";
      r.lighting.shadowsEnabled = false;
      const gl = document.querySelector("#game").getContext("webgl2");
      const width = gl.drawingBufferWidth,
        height = Math.floor(gl.drawingBufferHeight * 0.2);
      const a = new Uint8Array(width * height * 4),
        b = new Uint8Array(a.length),
        results = [];
      for (const [baseX, baseD] of [
        [0, 16],
        [-8, 32],
        [163840, 163856],
        [-163840, 163856],
      ]) {
        g.terrain.reset(1979);
        g.terrain.advance(baseD);
        for (const sign of [-1, 1]) {
          const delta = sign * 0.002;
          g.x = g.previousX = baseX + delta;
          g.z = g.previousZ = g.distance = g.previousDistance = baseD + delta;
          g.world.update(g.x, g.distance);
          g.world.active.fill(0);
          r.camera.setPose(
            {
              offsetX: -delta,
              distance: 12 + delta,
              targetZ: -5 + delta,
              height: 8.5,
            },
            0.01,
          );
          r.camera.update(0, 0, 1, false);
          r.render();
          gl.readPixels(
            0,
            0,
            width,
            height,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            sign < 0 ? a : b,
          );
        }
        let error = 0,
          changed = 0;
        for (let i = 0; i < a.length; i += 4)
          for (let c = 0; c < 3; c++) {
            const d = Math.abs(a[i + c] - b[i + c]);
            error += d;
            if (d > 4) changed++;
          }
        results.push({
          baseX,
          baseD,
          mean: error / (width * height * 3),
          changed: changed / (width * height * 3),
        });
      }
      return { samples: results, error: gl.getError(), stats: r.stats() };
    });
    for (const s of result.samples)
      assert.ok(
        s.mean < 0.5 && s.changed < 0.01,
        `${engine}: terrain changed across rebase ${JSON.stringify(s)}`,
      );
    assert.equal(result.error, 0);
    assert.equal(result.stats.terrainTriangles, 1568);
    assert.deepEqual(errors, []);
    return result;
  } finally {
    await page.close();
  }
}

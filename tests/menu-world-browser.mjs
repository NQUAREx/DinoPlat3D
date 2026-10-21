import assert from "node:assert/strict";
import { installOnlineFixture } from "./online-fixture.mjs";

export async function checkMenuWorld(context, url, engine) {
  const page = await context.newPage();
  try {
    await installOnlineFixture(page);
    await page.goto(`${url}/?debug&time=9`);
    await page.waitForFunction(() => window.__runner?.stats().textures >= 4);
    const sample = () =>
      page.evaluate(() => {
        window.__runner.render();
        const gl = document.querySelector("#game").getContext("webgl2"),
          pixels = [];
        for (const x of [2, gl.drawingBufferWidth - 3])
          for (const y of [0.05, 0.25, 0.45]) {
            const pixel = new Uint8Array(4);
            gl.readPixels(
              x,
              Math.floor(y * gl.drawingBufferHeight),
              1,
              1,
              gl.RGBA,
              gl.UNSIGNED_BYTE,
              pixel,
            );
            pixels.push(...pixel);
          }
        return {
          pixels,
          overlay: getComputedStyle(document.querySelector("#overlay"))
            .backgroundColor,
          error: gl.getError(),
          textures: window.__runner.stats().textures,
        };
      });
    const home = await sample();
    assert.equal(home.error, 0);
    assert.equal(home.overlay, "rgba(0, 0, 0, 0)");
    assert.ok(
      home.pixels.some(
        (value, index) =>
          index % 4 < 3 && Math.abs(value - [0x73, 0xd8, 0xff][index % 4]) > 12,
      ),
      "Home must preserve world pixels, not clear the canvas blue",
    );
    await page.tap("#shop-toggle");
    assert.equal(await page.locator(".shop-wallet").isVisible(), true);
    const shop = await sample();
    assert.deepEqual(shop.pixels, home.pixels);
    assert.equal(shop.overlay, home.overlay);
    await page.tap("#settings-toggle");
    const settings = await sample();
    assert.deepEqual(settings.pixels, home.pixels);
    assert.equal(settings.overlay, home.overlay);
    assert.equal(settings.textures, home.textures);
    await page.screenshot({
      path: `test-results/${engine}-world-menu-settings.png`,
    });
    return { home, shop, settings };
  } finally {
    await page.close();
  }
}

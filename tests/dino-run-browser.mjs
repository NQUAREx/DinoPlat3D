import assert from "node:assert/strict";
import { installOnlineFixture } from "./online-fixture.mjs";

export async function checkDinoRun(context, url, engine) {
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.addInitScript(() =>
      localStorage.setItem(
        "dinoplat-settings",
        JSON.stringify({ sound: true, vibration: true, shake: 0.1 }),
      ),
    );
    await installOnlineFixture(page);
    await page.goto(`${url}/?debug&time=9`);
    await page.waitForFunction(() => window.__runner?.stats().textures >= 4);
    assert.match(await page.title(), /^Dino Run/);
    assert.match(await page.locator(".brand").innerText(), /DINO[\s\S]*RUN/);
    assert.equal(await page.locator("#shake").count(), 0);
    assert.equal(
      await page.evaluate(() => window.__runner.settings.shake),
      2.9,
    );
    await page.tap("#action");
    await page.evaluate(() => {
      window.__runner.game.health.immunity = 1e9;
    });
    const button = await page.locator("#camera-mode").boundingBox();
    const viewport = page.viewportSize();
    assert.ok(
      button.x > viewport.width - 90 && button.y > viewport.height - 100,
    );
    const before = await page.evaluate(() => ({
      x: window.__runner.game.x,
      z: window.__runner.game.z,
      time: window.__runner.game.time,
    }));
    await page.tap("#camera-mode");
    await page.waitForFunction(
      () => !window.__runner.stats().cameraTransitioning,
    );
    const first = await page.evaluate(() => window.__runner.stats());
    await page.evaluate(() => window.__runner.pause());
    assert.equal(first.firstPerson, true);
    assert.equal(first.playerVisible, false);
    assert.equal(first.cameraFov, 65);
    assert.equal(
      await page.locator("#camera-mode").getAttribute("aria-pressed"),
      "true",
    );
    const heights = await page.evaluate(() => {
      const r = window.__runner,
        g = r.game;
      g.y = g.previousY = 0;
      g.crouch = g.previousCrouch = 0;
      r.render();
      const standing = r.stats().cameraY;
      g.y = g.previousY = 2;
      r.render();
      const jumping = r.stats().cameraY;
      g.y = g.previousY = 0;
      g.crouch = g.previousCrouch = 1;
      r.render();
      const ducking = r.stats().cameraY;
      g.crouch = g.previousCrouch = 0;
      r.render();
      return { standing, jumping, ducking };
    });
    assert.ok(Math.abs(heights.jumping - heights.standing - 2) < 1e-8);
    assert.ok(Math.abs(heights.ducking - heights.standing + 0.65) < 1e-8);
    await page.evaluate(() => {
      document.querySelector("#overlay").hidden = true;
      document.querySelector("#app").dataset.phase = "running";
      window.__runner.render();
    });
    await page.screenshot({ path: `test-results/${engine}-first-person.png` });
    await page.evaluate(() => {
      window.__runner.start();
    });
    await page.tap("#camera-mode");
    await page.waitForFunction(
      () => !window.__runner.stats().cameraTransitioning,
    );
    const rear = await page.evaluate(() => window.__runner.stats());
    assert.equal(rear.firstPerson, false);
    assert.equal(rear.playerVisible, true);
    assert.equal(rear.cameraFov, 50);
    assert.ok(
      await page.evaluate(
        (time) => window.__runner.game.time >= time,
        before.time,
      ),
    );
    assert.deepEqual(errors, []);
    return {
      firstPerson: first.firstPerson,
      hiddenAvatar: !first.playerVisible,
      heights,
      button,
      shake: first.shakeMultiplier,
      errors,
    };
  } finally {
    await page.close();
  }
}

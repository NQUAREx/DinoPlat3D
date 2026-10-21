import assert from "node:assert/strict";
import { installOnlineFixture } from "./online-fixture.mjs";

export async function checkFeedback(context, url) {
  const page = await context.newPage();
  try {
    await installOnlineFixture(page);
    await page.goto(`${url}/?debug&time=9`);
    await page.waitForFunction(() => window.__runner?.stats().textures >= 4);
    const result = await page.evaluate(() => {
      const r = window.__runner,
        g = r.game;
      r.pause();
      g.reset(123);
      g.phase = "running";
      const place = (kind) => {
        const w = g.world;
        w.active.fill(0);
        w.active[0] = 1;
        w.kinds[0] = kind;
        w.x[0] = g.x;
        w.z[0] = g.z + 0.15;
        w.halfX[0] = w.halfZ[0] = 0.4;
        w.height[0] = kind === 0 ? 3 : 0.75;
        w.baseY[0] = kind === 0 ? 0 : 0.5;
        g.step(1 / 120);
        r.render();
      };
      g.health.lives = 2;
      for (const kind of [1, 2, 5, 5]) place(kind);
      const gains = [
        ...document.querySelectorAll(".item-popup:not([hidden])"),
      ].map((n) => ({
        text: n.textContent,
        kind: n.dataset.kind,
        icon: !!n.querySelector("img").src,
      }));
      place(0);
      const frozen = [g.x, g.y, g.distance, g.time, g.health.immunity];
      const loss = [
        ...document.querySelectorAll(".item-popup:not([hidden])"),
      ].some((n) => n.textContent === "-1" && n.dataset.kind === "5");
      let held = true;
      for (let i = 0; i < 120; i++) {
        g.move(1);
        g.jump();
        g.down();
        g.step(1 / 120);
        held &&= frozen.every(
          (v, n) => v === [g.x, g.y, g.distance, g.time, g.health.immunity][n],
        );
      }
      r.render();
      const expired = document.querySelectorAll(
        ".item-popup:not([hidden])",
      ).length;
      g.phase = "paused";
      const clock = g.feedbackTime;
      g.step(1);
      const paused = clock === g.feedbackTime;
      for (let i = 0; i < 100; i++) g.reset(i + 1);
      r.render();
      return {
        gains,
        loss,
        held,
        expired,
        paused,
        slots: document.querySelectorAll(".item-popup").length,
        active: r.stats().feedbackCount,
        rig: r.stats().dinosaurBones,
      };
    });
    assert.deepEqual(
      result.gains.map((g) => g.text),
      ["+1", "+1", "+1", "MAX"],
    );
    assert.ok(result.gains.every((g) => g.icon));
    assert.ok(result.loss && result.held && result.paused);
    assert.equal(result.expired, 0);
    assert.equal(result.slots, 12);
    assert.equal(result.active, 0);
    assert.equal(result.rig, 11);
    return result;
  } finally {
    await page.close();
  }
}

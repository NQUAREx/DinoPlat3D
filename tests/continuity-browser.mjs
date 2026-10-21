import assert from "node:assert/strict";
import { installOnlineFixture } from "./online-fixture.mjs";

export async function checkContinuity(context, url, engine) {
  const page = await context.newPage();
  try {
    await installOnlineFixture(page);
    await page.goto(`${url}/?debug&time=9`);
    await page.waitForFunction(() => window.__runner?.stats().textures >= 4);
    const result = await page.evaluate(() => {
      const r = window.__runner,
        g = r.game;
      g.phase = "paused";
      g.x = g.previousX = 0;
      g.z = g.previousZ = g.distance = g.previousDistance = 200;
      g.y = g.previousY = g.crouch = g.previousCrouch = g.velocityY = 0;
      g.health.immunity = 0;
      g.world.active.fill(0);
      g.terrain.reset(1979);
      g.terrain.advance(200);
      const definitions = g.world.registry.get(0).colliders;
      for (let i = 0; i < 7; i++) {
        const b = definitions[i];
        g.world.active[i] = 1;
        g.world.kinds[i] = 0;
        g.world.variants[i] = i;
        g.world.x[i] = i < 4 ? (i - 1.5) * 2.2 : (i - 5) * 3;
        g.world.z[i] = 200 + (i < 4 ? 6 : 15);
        g.world.angles[i] = ((i % 3) - 1) * 0.3;
        // Conservative yaw envelope for a deliberately staged gallery.
        g.world.halfX[i] = g.world.halfZ[i] = Math.hypot(b.halfX, b.halfZ);
        g.world.height[i] = b.height;
        g.world.baseY[i] = 0;
      }
      for (const selector of ["#overlay", ".topbar", ".bottom"])
        document.querySelector(selector).hidden = true;
      const gl = document.querySelector("#game").getContext("webgl2");
      const a = new Uint8Array(
        gl.drawingBufferWidth * gl.drawingBufferHeight * 4,
      );
      const b = new Uint8Array(a.length),
        transitions = [];
      for (const hour of [0, 4.5, 6, 6.5, 8, 16, 18, 19.5]) {
        for (const sign of [-1, 1]) {
          r.lighting.setTimeOfDay(hour + sign * 0.0001);
          r.render();
          gl.readPixels(
            0,
            0,
            gl.drawingBufferWidth,
            gl.drawingBufferHeight,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            sign < 0 ? a : b,
          );
        }
        let sum = 0,
          changed = 0;
        for (let i = 0; i < a.length; i += 4) {
          const d =
            Math.abs(a[i] - b[i]) +
            Math.abs(a[i + 1] - b[i + 1]) +
            Math.abs(a[i + 2] - b[i + 2]);
          sum += d;
          if (d > 12) changed++;
        }
        transitions.push({
          hour,
          mean: sum / ((a.length / 4) * 3),
          changed: changed / (a.length / 4),
        });
      }
      r.lighting.setTimeOfDay(9);
      r.render();
      const gallery = r.stats();
      // Lock the world-space camera while crossing the X=0/terrain-cell seam.
      // Existing cactus vertices must not move or blink as the origin changes.
      const projections = [];
      r.lighting.shadowsEnabled = false;
      for (const sign of [-1, 1]) {
        const delta = sign * 0.002;
        g.x = g.previousX = delta;
        g.z = g.previousZ = g.distance = g.previousDistance = 200 + delta;
        r.camera.setPose(
          { offsetX: -delta, distance: 12 + delta, targetZ: -5 + delta },
          0.01,
        );
        r.camera.update(0, 0, 1, false);
        r.render();
        projections.push(
          r.camera.camera.position
            .clone()
            .set(g.world.x[0] - g.x, 1, g.distance - g.world.z[0])
            .project(r.camera.camera)
            .toArray(),
        );
        gl.readPixels(
          0,
          0,
          gl.drawingBufferWidth,
          gl.drawingBufferHeight,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          sign < 0 ? a : b,
        );
      }
      let green = 0,
        changedGreen = 0,
        greenError = 0,
        silhouette = 0;
      // Exclude the avatar: it intentionally stays relative to the player.
      for (
        let i =
          Math.floor(gl.drawingBufferHeight * 0.45) * gl.drawingBufferWidth * 4;
        i < a.length;
        i += 4
      ) {
        const ga = a[i + 1] > a[i] * 1.1 && a[i + 1] > a[i + 2] * 1.2;
        const gb = b[i + 1] > b[i] * 1.1 && b[i + 1] > b[i + 2] * 1.2;
        if (!ga && !gb) continue;
        if (ga !== gb) silhouette++;
        green++;
        const difference =
          Math.abs(a[i] - b[i]) +
          Math.abs(a[i + 1] - b[i + 1]) +
          Math.abs(a[i + 2] - b[i + 2]);
        greenError += difference;
        if (difference > 12) changedGreen++;
      }
      const cactusRebase = {
        green,
        changedGreen,
        fraction: changedGreen / green,
        mean: greenError / (green * 3),
        silhouetteFraction: silhouette / green,
        projections,
      };
      g.x = g.previousX = 0;
      g.z = g.previousZ = g.distance = g.previousDistance = 200;
      r.camera.setPose({ offsetX: 0, distance: 12, targetZ: -5 }, 0.01);
      r.camera.update(0, 0, 1, false);
      g.world.active.fill(0);
      // Raw paused fixture edits bypass WorldSpawner.update(): clear its cached
      // gallery shadows so they cannot mask a missing dinosaur contact shadow.
      r.lighting.setTimeOfDay(9);
      const poses = [];
      for (const [height, duck] of [
        [0, 0],
        [2, 0],
        [0, 1],
      ]) {
        g.y = g.previousY = height;
        g.crouch = g.previousCrouch = duck;
        r.lighting.shadowsEnabled = true;
        r.render();
        const stats = r.stats();
        gl.readPixels(
          0,
          0,
          gl.drawingBufferWidth,
          gl.drawingBufferHeight,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          a,
        );
        r.lighting.shadowsEnabled = false;
        r.render();
        gl.readPixels(
          0,
          0,
          gl.drawingBufferWidth,
          gl.drawingBufferHeight,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          b,
        );
        let darker = 0;
        for (let i = 0; i < a.length; i += 4)
          if (b[i] - a[i] + b[i + 1] - a[i + 1] + b[i + 2] - a[i + 2] > 12)
            darker++;
        poses.push({ height, duck, darker, stats });
      }
      // Restore gallery for a useful unobstructed visual inspection.
      for (let i = 0; i < 7; i++) g.world.active[i] = 1;
      g.y = g.previousY = g.crouch = g.previousCrouch = 0;
      r.lighting.shadowsEnabled = true;
      r.render();
      return {
        transitions,
        poses,
        gallery,
        cactusRebase,
        error: gl.getError(),
      };
    });
    for (const frame of result.transitions)
      assert.ok(
        frame.mean < 0.1 && frame.changed < 0.005,
        `${engine}: visible lighting jump: ${JSON.stringify(frame)}`,
      );
    assert.equal(result.gallery.obstacleVariants, 7);
    assert.equal(result.gallery.visibleObstacles, 7);
    assert.equal(result.gallery.moonVisible, false);
    // CPU projection alone previously hid stale GPU matrices after a shadow
    // capture. Require near-identical pixels too; GPU readback has its own test.
    for (let axis = 0; axis < 3; axis++)
      assert.ok(
        Math.abs(
          result.cactusRebase.projections[0][axis] -
            result.cactusRebase.projections[1][axis],
        ) < 1e-12,
      );
    assert.ok(
      result.cactusRebase.green > 1000 &&
        result.cactusRebase.mean < 0.02 &&
        result.cactusRebase.silhouetteFraction < 0.0005,
      `${engine}: cactus rebase changed pixels: ${JSON.stringify(result.cactusRebase)}`,
    );
    for (const pose of result.poses)
      assert.ok(
        pose.darker > 20,
        `${engine}: missing dinosaur contact shadow ${pose.height}/${pose.duck}`,
      );
    assert.ok(
      result.poses[1].stats.dinosaurShadowOpacity <
        result.poses[0].stats.dinosaurShadowOpacity,
    );
    assert.ok(
      result.poses[2].stats.dinosaurShadowWidth >
        result.poses[0].stats.dinosaurShadowWidth,
    );
    assert.equal(result.error, 0);
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => {
            window.__runner.render();
            requestAnimationFrame(resolve);
          }),
        ),
    );
    await page.screenshot({
      path: `test-results/${engine}-low-poly-gallery.png`,
    });
    return result;
  } finally {
    await page.close();
  }
}

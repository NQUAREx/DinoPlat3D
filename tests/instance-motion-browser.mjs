import assert from "node:assert/strict";
import { installOnlineFixture } from "./online-fixture.mjs";

/** Read the actual GPU matrices immediately before each colour draw. CPU-only
 * world/camera checks cannot detect an upload skipped after a shadow capture. */
export async function checkInstanceMotion(context, url, engine) {
  const page = await context.newPage();
  try {
    await installOnlineFixture(page);
    await page.goto(`${url}/?debug&time=9`);
    await page.waitForFunction(() => window.__runner?.stats().textures >= 4);
    const result = await page.evaluate(() => {
      const r = window.__runner,
        g = r.game;
      r.pause();
      g.landscape.enabled=false;
      g.groundY=g.previousGroundY=0;
      g.phase = "paused";
      g.world.reset(1979);
      g.y = g.previousY = g.velocityY = 0;
      const gl = document.querySelector("#game").getContext("webgl2");
      const original = gl.drawElementsInstanced;
      const data = new Float32Array(g.world.active.length * 16);
      const failures = [];
      let matrices = 0,
        draws = 0,
        largestError = 0;
      gl.drawElementsInstanced = function (
        mode,
        count,
        type,
        offset,
        instances,
      ) {
        const program = this.getParameter(this.CURRENT_PROGRAM);
        const location = this.getAttribLocation(program, "instanceMatrix");
        if (
          location >= 0 && this.getAttribLocation(program,"instanceDetail")>=0 &&
          this.getParameter(this.FRAMEBUFFER_BINDING) === null
        ) {
          const previous = this.getParameter(this.ARRAY_BUFFER_BINDING);
          const buffer = this.getVertexAttrib(
            location,
            this.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING,
          );
          this.bindBuffer(this.ARRAY_BUFFER, buffer);
          this.getBufferSubData(this.ARRAY_BUFFER, 0, data, 0, instances * 16);
          this.bindBuffer(this.ARRAY_BUFFER, previous);
          for (let n = 0; n < instances; n++) {
            const p = n * 16;
            let nearest = Infinity,
              slot = -1;
            for (let i = 0; i < g.world.active.length; i++) {
              if (!g.world.active[i]) continue;
              const error = Math.max(
                Math.abs(g.world.x[i] - g.x - data[p + 12]),
                Math.abs(g.z - g.world.z[i] - data[p + 14]),
              );
              if (error < nearest) {
                nearest = error;
                slot = i;
              }
            }
            largestError = Math.max(largestError, nearest);
            if (nearest > 0.0001 && failures.length < 5)
              failures.push({ frame: g.distance, n, nearest });
            if (slot >= 0 && g.world.kinds[slot] === 0 && nearest < 0.0001) {
              const angle = g.world.angles[slot];
              if (
                (Math.abs(data[p] - Math.cos(angle)) > 0.00001 ||
                  Math.abs(data[p + 2] + Math.sin(angle)) > 0.00001 ||
                  data[p + 13] !== 0) &&
                failures.length < 5
              )
                failures.push({
                  frame: g.distance,
                  n,
                  reason: "yaw or ground base",
                });
            }
            matrices++;
          }
          draws++;
        }
        return original.call(this, mode, count, type, offset, instances);
      };
      const before = r.stats().shadowUpdates;
      try {
        for (let f = 0; f < 80; f++) {
          // Both axes cross chunk boundaries; time advances through real cached
          // shadow and noncapture frames, but physics/input remain paused.
          g.x = g.previousX = -0.2 + f * 0.055;
          g.z = g.previousZ = g.distance = g.previousDistance = 907.5 + f * 0.2;
          g.time = g.previousTime = f / 60;
          g.heading = g.previousHeading = (f * Math.PI) / 40;
          r.camera.update(g.distance, 0, 1 / 60, false, g.heading);
          g.world.update(g.x, g.distance);
          r.render();
        }
      } finally {
        gl.drawElementsInstanced = original;
      }
      return {
        matrices,
        draws,
        largestError,
        failures,
        captures: r.stats().shadowUpdates - before,
        error: gl.getError(),
      };
    });
    assert.ok(result.matrices > 1000 && result.draws > 100);
    assert.ok(result.captures > 3 && result.captures < 80);
    assert.deepEqual(result.failures, [], `${engine}: stale GPU instances`);
    assert.equal(result.error, 0);
    return result;
  } finally {
    await page.close();
  }
}

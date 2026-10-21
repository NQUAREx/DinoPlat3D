import assert from "node:assert/strict";
import { installOnlineFixture } from "./online-fixture.mjs";
import { chromium, webkit } from "playwright";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { checkExpansion } from "./expanded-browser.mjs";
import { checkShop } from "./shop-browser.mjs";
import { checkPolish } from "./polish-browser.mjs";
import { checkInstanceMotion } from "./instance-motion-browser.mjs";
import { checkFeedback } from "./feedback-browser.mjs";

const url = "http://127.0.0.1:4178",
  report = {};
const server = spawn(
  process.execPath,
  [
    "node_modules/vite/bin/vite.js",
    "preview",
    "--host",
    "127.0.0.1",
    "--port",
    "4178",
    "--strictPort",
  ],
  { stdio: "pipe" },
);
await mkdir("test-results", { recursive: true });
try {
  for (const engine of process.argv.includes("--webkit-only") ? ["webkit"] : process.argv.includes("--mobile")
    ? ["chromium", "webkit"]
    : ["chromium"]) {
    const browser = await (engine === "chromium"
      ? chromium.launch({
          executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
          args: ["--no-sandbox", "--enable-unsafe-swiftshader"],
        })
      : webkit.launch());
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    await context.addInitScript(() => {
      try {
        localStorage.setItem("dinorun-help-seen-v1", "1");
      } catch {}
    });
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (
        m.type() === "error" &&
        /WebGLProgram|INVALID_OPERATION/.test(m.text())
      )
        errors.push(m.text());
    });
    try {
    await installOnlineFixture(page);
    await page.goto(`${url}/?debug&time=9`);
      await page.waitForFunction(
        () =>
          window.__runner &&
          document.querySelector("#app").dataset.phase === "ready",
      );
      assert.equal(
        await page.evaluate(() => window.__runner.stats().terrainLayers),
        0,
      );
      assert.equal(
        await page.evaluate(() => window.__runner.stats().playerOpacity),
        1,
      );
      // Isolate native gesture/camera controls from the separate live-hazard
      // checks below. Slow software-GPU round trips must not turn UI waits into
      // an unattended survival test against continuously homing birds.
      await page.evaluate(() => {
        const g = window.__runner.game;
        g.world.registry.setWeight(0, 0);
        g.world.active.fill(0);
        g.landscape.enabled = false;
      });
      await page.screenshot({ path: `test-results/${engine}-new-home.png` });
      await page.tap("#action");
      await page.waitForFunction(() => window.__runner.game.distance > 1).catch(async error => {
        const state = await page.evaluate(() => ({
          phase:window.__runner.game.phase, distance:window.__runner.game.distance,
          menu:document.querySelector("#app").dataset.menu, hidden:document.hidden,
          mobile:window.__runner.mobile(), audio:window.__runner.audio(),
          action:document.querySelector("#action").getBoundingClientRect().toJSON(),
          recordHidden:document.querySelector("#personal-record").hidden,
        }));
        throw new Error(`${error.message}\nStart state: ${JSON.stringify(state)}\nPage errors: ${JSON.stringify(errors)}`);
      });
      const before = await page.evaluate(() => window.__runner.game.heading);
      await page.evaluate(() => {
        const canvas = document.querySelector("#game");
        canvas.setPointerCapture = () => {};
        canvas.hasPointerCapture = () => false;
        for (const [type, y] of [
          ["pointerdown", 520],
          ["pointermove", 440],
          ["pointerup", 440],
        ])
          canvas.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              pointerType: "touch",
              isPrimary: true,
              pointerId: 77,
              clientX: 190,
              clientY: y,
            }),
          );
      });
      await page.waitForFunction(() => window.__runner.game.y > 0.1);
      assert.equal(
        await page.evaluate(() => window.__runner.game.heading),
        before,
      );
      await page.waitForFunction(() => window.__runner.game.y === 0);
      await page.tap("#camera-mode");
      await page.waitForFunction(
        () => window.__runner.stats().cameraBlend > 0.95,
      );
      await page.tap("#camera-mode");
      await page.waitForFunction(
        () => window.__runner.stats().cameraBlend < 0.01,
      );
      await page.tap("#pause");
      assert.equal(
        await page.evaluate(() => window.__runner.game.phase),
        "paused",
      );
      const world = await page.evaluate(() => {
        const r = window.__runner,
          g = r.game,
          field = g.landscape,
          places = [];
        r.pause();
        g.world.registry.setWeight(0, 1);
        g.landscape.enabled = true;
        for (let biome = 0; biome < 3; biome++) {
          let found;
          for (let z = -300; z <= 300 && !found; z += 12)
            for (let x = -300; x <= 300 && !found; x += 12)
              if (field.biomeAt(x, z) === biome && field.supportAt(x, z))
                found = { x, z, biome };
          places.push(found);
        }
        return places;
      });
      for (const place of world) {
        assert.ok(place);
        const sample = await page.evaluate(({ x, z }) => {
          const r = window.__runner,
            g = r.game;
          r.pause();
          g.phase = "paused";
          g.x = g.previousX = x;
          g.z = g.previousZ = z;
          g.y = g.previousY = 0;
          g.heading = g.previousHeading = 0;
          g.groundY = g.previousGroundY = g.landscape.heightAt(x, z);
          g.world.reset(g.seed);
          g.world.update(x, z);
          g.time = g.previousTime = 10;
          g.health.reset();
          g.hitStopRemaining = 0;
          r.camera.reset();
          document.querySelector("#overlay").hidden = true;
          r.render();
          const scene = r.lighting.key.parent,
            ground = scene.children.filter((o) =>
              o.name.startsWith("landscape"),
            );
          return {
            biome: g.landscape.biomeAt(x, z),
            height: g.groundY,
            triangles: ground.reduce(
              (s, m) => s + m.geometry.drawRange.count / 3,
              0,
            ),
            textured: ground.some((m) => m.material.map),
            draws: r.stats().calls,
            geometry: r.stats().geometries,
          };
        }, place);
        assert.equal(sample.biome, place.biome);
        assert.equal(sample.textured, false);
        assert.ok(sample.triangles > 4000 && sample.triangles < 20000);
        report[`${engine}-biome-${place.biome}`] = sample;
        await page.screenshot({
          path: `test-results/${engine}-biome-${place.biome}.png`,
        });
      }
      const uphill = await page.evaluate(() => {
        const r = window.__runner, g = r.game, f = g.landscape;
        r.pause();
        let place;
        for (let z = -1024; z <= 1024 && !place; z += 16)
          for (let x = -1024; x <= 1024 && !place; x += 16) {
            const grade = (f.heightAt(x, z + 12) - f.heightAt(x, z - 6)) / 18;
            if (grade > 0.3 && f.supportAt(x, z)) place = { x, z, grade };
          }
        if (!place) throw Error("No natural uphill camera fixture found");
        g.x = g.previousX = place.x; g.z = g.previousZ = place.z;
        g.groundY = g.previousGroundY = f.heightAt(g.x, g.z);
        g.y = g.previousY = 0; g.heading = g.previousHeading = 0;
        g.world.active.fill(0); g.phase = "paused";
        r.camera.firstPerson = false; r.camera.reset();
        r.camera.update(g.distance, 0, 3, false, 0, g.groundY, 0, g.groundY);
        const flatQ = r.camera.camera.quaternion;
        const flatForwardY = 2 * (flatQ.w * flatQ.x - flatQ.y * flatQ.z);
        for (let i = 0; i < 180; i++) r.camera.update(g.distance, 0, 1 / 60, false, 0, g.groundY, 0, g.groundY, f, g.x, g.z);
        r.render();
        // Pure pitch/forward-Y from quaternion, no THREE object allocation.
        const q = r.camera.camera.quaternion;
        return { ...place, pitch: r.camera.terrainPitch, forwardY: 2 * (q.w * q.x - q.y * q.z), flatForwardY, fov:r.camera.camera.fov, viewHeading: g.viewHeading, cameraX: g.viewX, cameraZ: g.viewZ };
      });
      assert.ok(uphill.pitch > 0.25);
      assert.ok(uphill.forwardY > uphill.flatForwardY + 0.1, "camera raises its view along the lower mountain");
      assert.ok(uphill.fov > 50.5);
      assert.ok(Number.isFinite(uphill.viewHeading) && Number.isFinite(uphill.cameraX) && Number.isFinite(uphill.cameraZ));
      report[`${engine}-uphill-camera`] = uphill;
      await page.screenshot({path: `test-results/${engine}-uphill-camera.png`});
      const hazards = await page.evaluate(() => {
        const r = window.__runner,
          g = r.game;
        r.pause();
        const field = g.landscape;
        let pit, bridge;
        for (let z = 40; z < 400 && (!pit || !bridge); z += 4)
          for (let x = -120; x < 120 && (!pit || !bridge); x += 4) {
            const s = field.surfaceAt(x + 2, z + 2);
            if (s === 2 && !pit) pit = [x + 2, z + 2];
            if (s === 4 && !bridge) bridge = [x + 2, z + 2];
          }
        g.phase = "running";
        g.x = g.previousX = pit[0];
        g.z = g.previousZ = pit[1];
        g.y = g.previousY = 0;
        g.groundY = g.previousGroundY = field.heightAt(g.x, g.z);
        g.health.immunity = 20;
        g.falling = false;
        g.world.active.fill(0);
        for (let i = 0; i < 80 && g.phase === "running"; i++) {
          g.step(1 / 120);
          g.world.active.fill(0);
        }
        const fallen = {
          lives: g.health.lives,
          falling: g.falling,
          phase: g.phase,
        };
        return { pit, bridge, fallen };
      });
      assert.ok(hazards.bridge);
      assert.equal(hazards.fallen.lives, 0);
      assert.equal(hazards.fallen.falling, true);
      report[`${engine}-hazards`] = hazards;
      const memory = await page.evaluate(() => {
        const r = window.__runner,
          g = r.game;
        r.pause();
        document.querySelector("#overlay").hidden = true;
        // Warm all near/far obstacle and pickup geometries with fixed numeric slots.
        function warm() {
          g.world.active.fill(0);
          let n = 0;
          for (const [kind, count] of [
            [0, 7],
            [1, 1],
            [2, 1],
            [5, 1],
            [6, 3],
            [7, 3],
            [8, 3],
            [9, 1],
            [10, 1],
            [11, 1],
          ])
            for (let variant = 0; variant < count; variant++)
              for (const z of [12, 31, 42]) {
                const i = n++;
                g.world.active[i] = 1;
                g.world.kinds[i] = kind;
                g.world.variants[i] = variant;
                g.world.x[i] = g.x;
                g.world.z[i] = g.z + z;
                g.world.baseY[i] = g.groundY + (kind === 10 ? 1.05 : 0);
                g.world.previousX[i] = g.world.x[i];
                g.world.previousZ[i] = g.world.z[i];
                g.world.previousBaseY[i] = g.world.baseY[i];
                g.world.height[i] = 3;
                g.world.halfX[i] = g.world.halfZ[i] = 0.7;
                g.world.motion[i] = kind === 10 ? 3 : 0;
              }
          r.render();
        }
        g.reset(1979);
        g.phase = "paused";
        warm();
        const before = r.stats();
        for (let i = 0; i < 30; i++) {
          g.reset(1979);
          g.phase = "paused";
          warm();
        }
        const after = r.stats();
        return {
          before: { geometries: before.geometries, textures: before.textures },
          after: { geometries: after.geometries, textures: after.textures },
          triangles: after.triangles,
          calls: after.calls,
        };
      });
      assert.deepEqual(memory.before, memory.after);
      assert.ok(memory.after.textures <= 4);
      report[`${engine}-memory`] = memory;
      assert.deepEqual(errors, []);
      const dayPage = await context.newPage();
      try {
        // No ?time=9: production defaults must advance without a debug freeze.
        await dayPage.goto(`${url}/?debug`);
        await dayPage.waitForFunction(() => window.__runner && document.querySelector("#app").dataset.phase === "ready");
        await dayPage.evaluate(() => {
          const g = window.__runner.game;
          g.landscape.enabled = false; g.world.registry.setWeight(0, 0); g.world.active.fill(0);
        });
        await dayPage.tap("#action");
        await dayPage.waitForFunction(() => window.__runner.game.time > 0.4 && window.__runner.lighting.cycle.hours > 9.01);
        const day = await dayPage.evaluate(() => {
          const r = window.__runner, l = r.lighting;
          r.pause();
          const activeHours = l.cycle.hours, time = r.game.time, before = l.fogColour.getHex();
          l.update(180); const night = l.fogColour.getHex(), source = l.source;
          l.update(360); const wrapped = l.fogColour.getHex();
          return {activeHours, time, automatic:l.cycle.automatic, seconds:l.cycle.cycleSeconds, before, night, source, wrapped};
        });
        assert.equal(day.automatic, true); assert.equal(day.seconds, 360);
        assert.ok(day.activeHours > 9); assert.notEqual(day.before, day.night);
        assert.equal(day.source, "moon");
        report[`${engine}-automatic-day`] = day;
      } finally { await dayPage.close(); }
      report[`${engine}-expansion`] = await checkExpansion(
        browser,
        url,
        engine,
      );
      report[`${engine}-instanceGPU`] = await checkInstanceMotion(
        context,
        url,
        engine,
      );
      report[`${engine}-feedback`] = await checkFeedback(context, url);
      report[`${engine}-shop`] = await checkShop(context, url, engine);
      report[`${engine}-polish`] = await checkPolish(context, url, engine);
      console.log(
        `${engine} PASS: terrain/biomes, native gestures, slopes, fatal hazards, bridges, 30 resets, DEV/shop/pause; no JS/GL errors`,
      );
    } finally {
      await context.close();
      await browser.close();
    }
  }
  await writeFile(
    "test-results/landscape-report.json",
    JSON.stringify(report, null, 2),
  );
} finally {
  server.kill();
}

// Isolated real-browser decoder/output check; never boots the game or changes main.
import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium, webkit } from "playwright";

const server = await createServer({ configFile: false, server: { host: "127.0.0.1", port: 0 } });
await server.listen();
const address = server.httpServer.address();
try {
  for (const [name, engine] of (process.argv.includes("--webkit-only")
    ? [["webkit", webkit]] : [["chromium", chromium], ["webkit", webkit]])) {
    const browser = await engine.launch({ headless: true,
      ...(name === "chromium" ? { executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium" } : {}) });
    try {
      const page = await browser.newPage();
      await page.route("**/sound-fixture", (route) => route.fulfill({
        contentType: "text/html", body: '<button id="unlock">Audio</button>',
      }));
      await page.goto(`http://127.0.0.1:${address.port}/sound-fixture`);
      await page.evaluate(async () => {
        const NativeContext = window.AudioContext;
        window.AudioContext = class extends NativeContext {
          constructor() { super({ sampleRate: 48000 }); }
        };
        const { GameSound } = await import("/src/sound.ts");
        const { GameEvents, GameEvent } = await import("/src/events.ts");
        const events = new GameEvents(), sound = new GameSound(events);
        window.fixture = { events, sound, GameEvent };
        document.querySelector("#unlock").onclick = () => sound.unlock();
      });
      await page.click("#unlock");
      await page.waitForFunction(() => window.fixture.sound.stats().loaded);
      const result = await page.evaluate(async () => {
        const { sound, events, GameEvent } = window.fixture;
        const { default: sprite } = await import("/src/assets/audio-sprite.json");
        const stats = sound.stats(), buffer = sound.buffer;
        const profiles = [];
        for (let surface = 0; surface < 10; surface++) {
          sound.stop();
          sound.unlock();
          sound.setSurface(surface);
          events.emit(GameEvent.Step, surface % 2);
          const voice = sound.voices.find((voice) => voice.source);
          const clip = sprite[sound.stats().lastCue];
          // Render the actual selected cue, rate, gain and filter offline.
          const offline = new OfflineAudioContext(1, 24000, 48000);
          const source = offline.createBufferSource(), filter = offline.createBiquadFilter();
          const gain = offline.createGain();
          source.buffer = buffer;
          source.playbackRate.value = voice.source.playbackRate.value;
          filter.type = "lowpass";
          filter.frequency.value = voice.filter.frequency.value;
          filter.Q.value = voice.filter.Q.value;
          gain.gain.value = voice.gain.gain.value;
          source.connect(filter).connect(gain).connect(offline.destination);
          source.start(0, clip.offset + stats.codecOffset, clip.duration);
          const data = (await offline.startRendering()).getChannelData(0);
          let energy = 0, peak = 0;
          for (const sample of data) { energy += sample * sample; peak = Math.max(peak, Math.abs(sample)); }
          profiles.push({ surface, cue: sound.stats().lastCue,
            rms: Math.sqrt(energy / data.length), peak });
        }
        sound.stop();
        sound.unlock();
        events.emit(GameEvent.Hit);
        const hit = sound.voices[6].source;
        events.emit(GameEvent.Death);
        const death = sound.voices[7].source;
        for (let i = 0; i < 100; i++) events.emit(GameEvent.Step, i % 2);
        const bounded = sound.stats().activeVoices === 8;
        const reserved = sound.voices[6].source === hit && sound.voices[7].source === death;
        sound.suspend();
        const stopped = sound.stats().activeVoices === 0;
        sound.dispose();
        return { stats, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels,
          profiles, bounded, reserved, stopped };
      });
      assert.equal(result.sampleRate, 48000);
      assert.equal(result.channels, 1);
      assert.ok(result.stats.decodedBytes < 4 * 1024 * 1024);
      assert.ok(Math.abs(result.stats.codecOffset) < 0.08);
      assert.ok(result.bounded && result.reserved && result.stopped);
      for (const profile of result.profiles) {
        assert.ok(profile.rms > 0.001, `${name} surface ${profile.surface} silent`);
        assert.ok(profile.peak < 1, `${name} surface ${profile.surface} clips`);
      }
      console.log(name, JSON.stringify(result));
    } finally { await browser.close(); }
  }
} finally { await server.close(); }

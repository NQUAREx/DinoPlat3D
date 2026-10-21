import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { GameEvents, GameEvent } from "../src/events";
import { GameSound } from "../src/sound";
import sprite from "../src/assets/audio-sprite.json";

class Param {
  value = 0;
  setValueAtTime(value: number) { this.value = value; }
  cancelScheduledValues() {}
}
class Node {
  gain = new Param();
  frequency = new Param();
  Q = new Param();
  playbackRate = new Param();
  threshold = new Param();
  ratio = new Param();
  attack = new Param();
  release = new Param();
  type = "";
  buffer: unknown;
  onended: (() => void) | null = null;
  stopped = false;
  disconnected = false;
  target?: Node;
  args: number[] = [];
  connect(target: Node) { this.target = target; }
  disconnect() { this.disconnected = true; }
  stop() { this.stopped = true; }
  start(...args: number[]) { this.args = args; }
}
class Context {
  static latest: Context;
  currentTime = 0;
  state = "running";
  destination = new Node();
  sources: Node[] = [];
  filters: Node[] = [];
  decodes = 0;
  constructor() { Context.latest = this; }
  createGain() { return new Node(); }
  createDynamicsCompressor() { return new Node(); }
  createBiquadFilter() { const n = new Node(); this.filters.push(n); return n; }
  createBufferSource() { const n = new Node(); this.sources.push(n); return n; }
  resume() { this.state = "running"; return Promise.resolve(); }
  suspend() { this.state = "suspended"; return Promise.resolve(); }
  close() { this.state = "closed"; return Promise.resolve(); }
  async decodeAudioData() {
    this.decodes++;
    const channel = new Float32Array(48000);
    channel[1440] = 0.7; // Simulated decoder adds 10 ms of padding.
    return { length: 1024000, numberOfChannels: 1, sampleRate: 48000,
      duration: 21.333, getChannelData: () => channel };
  }
}
async function fixture(callback?: () => number) {
  const original = globalThis.AudioContext;
  globalThis.AudioContext = Context as unknown as typeof AudioContext;
  const events = new GameEvents(), sound = new GameSound(events, callback);
  // Avoid Vite BASE_URL in Node; keep production prepare/decode/unlock intact.
  Object.assign(sound, { bytes: Promise.resolve(new ArrayBuffer(1)) });
  sound.unlock();
  await new Promise<void>((resolve) => setImmediate(resolve));
  return { events, sound, context: Context.latest,
    cleanup() { sound.dispose(); globalThis.AudioContext = original; } };
}

test("ten surfaces select distinct profiles, three real takes, and preserve footside", async () => {
  let surface = 0;
  const f = await fixture(() => surface);
  try {
    const profiles = new Set<string>();
    let footside = -1;
    f.events.on(GameEvent.Step, (value) => { footside = value; });
    for (surface = 0; surface < 10; surface++) {
      const family = surface === 9 ? "wood" : surface < 2 ? "sand" : surface < 6 ? "stone" : "grass";
      const takes = new Set<string>();
      for (let i = 0; i < 9; i++) {
        f.events.emit(GameEvent.Step, i % 2);
        assert.equal(footside, i % 2);
        assert.ok(f.sound.stats().lastCue.startsWith(family));
        takes.add(f.sound.stats().lastCue);
      }
      assert.equal(takes.size, 3);
      profiles.add(`${family}:${f.context.sources.slice(-1)[0].target!.frequency.value}`);
    }
    assert.equal(profiles.size, 10);
    assert.equal(f.context.filters.length, 8);
    assert.equal(f.context.decodes, 1);
    f.sound.unlock();
    assert.equal(f.context.decodes, 1);
  } finally { f.cleanup(); }
});

test("bounded stealing preserves hit/death, decoder offset, mute and disposal", async () => {
  const f = await fixture();
  try {
    f.events.emit(GameEvent.Hit);
    const hit = f.context.sources.slice(-1)[0];
    f.events.emit(GameEvent.Death);
    const death = f.context.sources.slice(-1)[0];
    for (let i = 0; i < 100; i++) f.events.emit(GameEvent.Step, i % 2);
    assert.equal(hit.stopped, false);
    assert.equal(death.stopped, false);
    assert.equal(f.sound.stats().activeVoices, 8);
    assert.equal(f.context.sources.filter((n) => !n.stopped).length, 8);
    assert.ok(Math.abs(hit.args[1] - sprite.hit.offset - 0.01) < 1e-9);
    assert.equal(hit.target!.frequency.value, 20000);
    f.sound.setSurface(9);
    f.events.emit(GameEvent.Step);
    assert.ok(f.sound.stats().lastCue.startsWith("wood"));
    f.sound.setSurface(NaN);
    f.events.emit(GameEvent.Step);
    assert.ok(f.sound.stats().lastCue.startsWith("sand"));
    f.sound.configure(false, true);
    assert.equal(f.sound.stats().activeVoices, 0);
    assert.ok(f.context.sources.every((n) => n.disconnected));
    f.sound.configure(true, false);
    f.events.emit(GameEvent.Step);
    f.sound.suspend();
    assert.equal(f.sound.stats().activeVoices, 0);
    f.sound.dispose();
    assert.ok(f.context.filters.every((n) => n.disconnected));
  } finally { f.cleanup(); }
});

test("shipped MP3 is mono, bounded at 48 kHz, with twelve distinct audible takes", () => {
  const path = new URL("../public/audio/game.mp3", import.meta.url).pathname;
  assert.ok(readFileSync(path).length < 180000);
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries",
    "stream=channels", "-of", "json", path], { encoding: "utf8" }));
  assert.equal(probe.streams[0].channels, 1);
  const pcm = execFileSync("ffmpeg", ["-v", "error", "-i", path, "-ar", "48000",
    "-ac", "1", "-f", "f32le", "pipe:1"], { maxBuffer: 5 * 1024 * 1024 });
  assert.ok(pcm.length < 4 * 1024 * 1024, `${pcm.length} decoded bytes`);
  const waves = new Set<string>();
  for (const [name, clip] of Object.entries(sprite)) {
    assert.ok(clip.offset >= 0 && clip.duration > 0);
    assert.ok((clip.offset + clip.duration) * 48000 * 4 <= pcm.length);
    if (!/^(sand|stone|grass|wood)/.test(name)) continue;
    const start = Math.round(clip.offset * 48000), count = Math.round(clip.duration * 48000);
    let energy = 0, peak = 0;
    for (let i = start; i < start + count; i++) {
      const sample = pcm.readFloatLE(i * 4);
      energy += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }
    assert.ok(Math.sqrt(energy / count) > 0.015, `${name} must be audible`);
    assert.ok(peak < 1, `${name} must not clip`);
    waves.add(pcm.subarray(start * 4, (start + count) * 4).toString("base64"));
  }
  assert.equal(waves.size, 12);
  assert.equal(sprite.music.duration, 16);
  console.log(`48 kHz mono decoded sprite: ${pcm.length} bytes`);
});

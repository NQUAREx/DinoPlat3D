// Offline Kenney CC0 selection + original light marimba loop. Runtime: one MP3.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const exec = promisify(execFile),
  rate = 22050;
class AudioBuilder {
  async build() {
    const temporary = await mkdtemp(join(tmpdir(), "dinorun-audio-")),
      chunks = [],
      sprite = {};
    const entries = [
      ...["snow", "concrete", "grass", "wood"].flatMap((texture, bank) =>
        [0, 1, 2].map((variant) => [
          `${["sand", "stone", "grass", "wood"][bank]}${variant}`,
          `impact/footstep_${texture}_00${variant}`,
          texture === "snow" || texture === "grass" ? 0.20 : 0.14,
        ])),
      ["land", "impact/impactSoft_medium_000", 0.28],
      ["hit", "impact/impactSoft_heavy_000", 0.4],
      ["ui", "interface/select_001", 0.2],
      ["coin", "interface/pluck_001", 0.4],
      ["diamond", "interface/confirmation_001", 0.65],
      ["heal", "interface/confirmation_002", 0.8],
      ["error", "interface/error_001", 0.5],
      ["jump", "interface/maximize_001", 0.5],
      ["duck", "interface/minimize_001", 0.4],
      ["death", "interface/drop_001", 0.65],
    ];
    // An inaudible (never played) synchronization marker measures codec padding
    // once after decode. WebKit and Chromium trim MP3 encoder delay differently.
    const sync = Buffer.alloc(Math.round(rate * 0.12) * 2);
    for (let i = Math.round(rate * 0.02); i < Math.round(rate * 0.03); i++)
      sync.writeInt16LE(21000, i * 2);
    chunks.push(sync);
    sprite.sync = { offset: Math.round(rate * 0.02) / rate, duration: 0.01 };
    let samples = sync.length / 2;
    for (const [name, file, duration] of entries) {
      const out = join(temporary, `${name}.pcm`);
      await exec("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        `art/audio/${file}.ogg`,
        "-af",
        `atrim=duration=${duration},loudnorm=I=-18:TP=-2:LRA=7,afade=t=in:d=0.002,afade=t=out:st=${duration - 0.025}:d=0.025`,
        "-ar",
        String(rate),
        "-ac",
        "1",
        "-f",
        "s16le",
        out,
      ]);
      const data = await readFile(out);
      // Original offline emphasis: an audible low impact and descending death
      // stinger layered into the existing CC0 cue. No runtime synthesis cost.
      if (name === "hit" || name === "death") {
        let noise = 1979;
        for (let i = 0; i < data.length / 2; i++) {
          const t = i / rate;
          noise = (Math.imul(noise, 1664525) + 1013904223) >>> 0;
          const envelope =
            Math.min(1, t / 0.004) * Math.exp(-t * (name === "hit" ? 14 : 5));
          const phase =
            name === "hit"
              ? 2 * Math.PI * (110 * t - 65 * t * t)
              : 2 * Math.PI * (420 * t - 210 * t * t);
          const value =
            data.readInt16LE(i * 2) / 32768 +
            envelope *
              (Math.sin(phase) * 0.48 +
                (noise / 4294967296 - 0.5) * (name === "hit" ? 0.45 : 0.1));
          data.writeInt16LE(
            Math.round(Math.max(-0.96, Math.min(0.96, value)) * 32767),
            i * 2,
          );
        }
      }
      sprite[name] = {
        offset: samples / rate,
        duration: data.length / 2 / rate,
      };
      const gap = Math.round((/^(sand|stone|grass|wood)/.test(name) ? 0.03 : 0.06) * rate);
      chunks.push(data, Buffer.alloc(gap * 2));
      samples += data.length / 2 + gap;
    }
    const seconds = 16,
      music = Buffer.alloc(seconds * rate * 2),
      notes = [0, 4, 7, 12, 7, 4, 2, 7, 0, 7, 12, 16, 12, 7, 4, 2],
      roots = [0, 0, 5, 5, 9, 9, 7, 7];
    const synth = new Float32Array(seconds * rate);
    for (let n = 0; n < 64; n++) {
      const start = n * 0.25,
        midi = 60 + roots[Math.floor(n / 8)] + notes[n % notes.length],
        frequency = 440 * 2 ** ((midi - 69) / 12);
      for (
        let j = 0;
        j < rate * 0.48 && Math.round(start * rate) + j < synth.length;
        j++
      ) {
        const t = j / rate,
          envelope = Math.min(1, t / 0.008) * Math.exp(-t * 10);
        synth[Math.round(start * rate) + j] +=
          (Math.sin(t * frequency * 2 * Math.PI) +
            0.24 * Math.sin(t * frequency * 4 * Math.PI)) *
          envelope *
          0.1;
      }
    }
    // Gentle bass and shaker rhythm, deliberately quieter than game feedback.
    for (let i = 0; i < synth.length; i++) {
      const t = i / rate,
        beat = t % 0.5,
        root = roots[Math.floor(t / 2) % 8],
        bass = 65.406 * 2 ** (root / 12);
      const fade = Math.min(1, t / 0.02, (seconds - t) / 0.08);
      const value =
        (synth[i] +
          Math.sin(t * bass * 2 * Math.PI) * Math.exp(-beat * 13) * 0.055) *
        fade;
      music.writeInt16LE(
        Math.round(Math.max(-1, Math.min(1, value)) * 32767),
        i * 2,
      );
    }
    sprite.music = { offset: samples / rate, duration: seconds };
    chunks.push(music);
    // Include codec padding headroom; browsers may decode at 48 kHz.
    const duration48k = Math.ceil((samples / rate + seconds + 0.08) * 48000);
    if (duration48k * 4 >= 4 * 1024 * 1024)
      throw new Error("Audio sprite exceeds the mono 48 kHz decoded budget");
    const raw = join(temporary, "sprite.pcm");
    await writeFile(raw, Buffer.concat(chunks));
    await mkdir("public/audio", { recursive: true });
    await exec("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "s16le",
      "-ar",
      String(rate),
      "-ac",
      "1",
      "-i",
      raw,
      "-c:a",
      "libmp3lame",
      "-b:a",
      "64k",
      "public/audio/game.mp3",
    ]);
    await writeFile(
      "src/assets/audio-sprite.json",
      JSON.stringify(sprite, null, 2) + "\n",
    );
    console.log(
      "Audio sprite",
      (await readFile("public/audio/game.mp3")).length,
      "bytes; original music +",
      entries.length,
      "CC0 clips; temp",
      temporary,
    );
  }
}
await new AudioBuilder().build();

import { GameEvent, GameEvents } from "./events";
import sprite from "./assets/audio-sprite.json";
import { Tuning } from "./tuning";
import { bonusKindForObject } from "./bonuses";

type Cue = keyof typeof sprite;
type Voice = { gain: GainNode; filter: BiquadFilterNode; source?: AudioBufferSourceNode; until: number };
/** Land: biome * 3 + cover (Desert=0, Lava=1, Meadow=2); Bridge=9. */
export type SoundSurface = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
const STEP_BANKS = [
  ["sand0", "sand1", "sand2"],
  ["stone0", "stone1", "stone2"],
  ["grass0", "grass1", "grass2"],
  ["wood0", "wood1", "wood2"],
] as const;
// Bank, low-pass Hz, rate, gain: loose sand / packed sand / dry grit;
// porous rock / warm gravel / dense basalt; grass / damp turf / dry grass; planks.
const STEP_PROFILES = [
  [0, 6200, 0.98, 0.30], [0, 2800, 1.04, 0.28], [1, 4800, 1.06, 0.25],
  [1, 3400, 0.96, 0.30], [1, 6500, 1.04, 0.27], [1, 2000, 0.91, 0.32],
  [2, 5600, 1, 0.30], [2, 2400, 0.94, 0.32], [2, 7800, 1.06, 0.27],
  [3, 9000, 1, 0.33],
] as const;
/** One decoded local sprite, eight bounded SFX channels and one quiet music loop. */
export class GameSound {
  enabled = true;
  musicEnabled = true;
  private context?: AudioContext;
  private master?: GainNode;
  private limiter?: DynamicsCompressorNode;
  private musicGain?: GainNode;
  private music?: AudioBufferSourceNode;
  private buffer?: AudioBuffer;
  private bytes?: Promise<ArrayBuffer | undefined>;
  private loading?: AbortController;
  private preparing?: Promise<void>;
  private readonly voices: Voice[] = [];
  private readonly off: (() => void)[];
  private running = false;
  private jet?: OscillatorNode;
  private jetGain?: GainNode;
  private jetNoise?: AudioBufferSourceNode;
  private jetNoiseBuffer?: AudioBuffer;
  setJetpack(active: boolean) {
    active = active && this.running && this.enabled && this.context?.state === "running";
    if (!active) {
      this.jet?.stop(); this.jet?.disconnect(); this.jetGain?.disconnect();
      this.jetNoise?.stop(); this.jetNoise?.disconnect();
      this.jet = undefined; this.jetGain = undefined; this.jetNoise = undefined;
      return;
    }
    if (this.jet || !this.context || !this.master) return;
    this.jet = this.context.createOscillator();
    this.jetGain = this.context.createGain();
    this.jet.type = "sawtooth"; this.jet.frequency.value = 76;
    this.jetGain.gain.value = .035;
    this.jet.connect(this.jetGain); this.jetGain.connect(this.master); this.jet.start();
    if (!this.jetNoiseBuffer) {
      this.jetNoiseBuffer = this.context.createBuffer(1, Math.ceil(this.context.sampleRate * .5), this.context.sampleRate);
      const data = this.jetNoiseBuffer.getChannelData(0);
      let previous = 0;
      for (let i = 0; i < data.length; i++) {
        previous = (previous + (Math.random() * 2 - 1) * .15) / 1.15;
        data[i] = previous * 5;
      }
    }
    this.jetNoise = this.context.createBufferSource();
    this.jetNoise.buffer = this.jetNoiseBuffer; this.jetNoise.loop = true;
    this.jetNoise.connect(this.jetGain); this.jetNoise.start();
  }
  private alive = true;
  private sequence = 0;
  private stepSequence = 0;
  private surface: SoundSurface = 0;
  private played = 0;
  private lastCue = "";
  private codecOffset = 0;
  private pendingMenu?: Cue;
  private pendingCritical?: "hit" | "death";
  constructor(events: GameEvents, private readonly getSurface?: () => number) {
    this.off = [
      events.on(GameEvent.Jump, () => this.play("jump", 0.32, 1)),
      events.on(GameEvent.Land, () => this.play("land", 0.5, 0.95)),
      events.on(GameEvent.Step, () => {
        if (this.getSurface) this.setSurface(this.getSurface());
        const n = this.stepSequence++;
        const [bank, cutoff, rate, gain] = STEP_PROFILES[this.surface];
        this.play(STEP_BANKS[bank][(n + Math.floor(n / 3)) % 3],
          gain * (0.96 + (n % 3) * 0.04),
          rate * (0.98 + ((n * 3) % 5) * 0.01), 0, cutoff);
      }),
      events.on(GameEvent.Hit, () => this.play("hit", 1, 0.85)),
      events.on(GameEvent.Death, () => {
        this.setRunning(false);
        this.play("death", 1, 0.65);
      }),
      events.on(GameEvent.Pickup, (currency) => {
        this.play(
          currency === 1 ? "diamond" : "coin",
          currency === 1 ? 0.5 : 0.38,
          1 + (this.sequence++ % 4) * 0.035,
        );
        if (currency === 1) this.play("coin", 0.22, 1.5, 0.1);
      }),
      events.on(GameEvent.Heal, () => {
        this.play("heal", 0.5, 1);
        this.play("coin", 0.2, 1.25, 0.1);
        this.play("coin", 0.18, 1.5, 0.2);
      }),
      events.on(GameEvent.Collected, (kind) => {
        const bonus = bonusKindForObject(kind);
        if (bonus === undefined) return;
        this.play("diamond", 0.6, bonus >= 3 && bonus !== 4 ? 0.7 : 1.2);
        this.play("coin", 0.25, 1.5, 0.12);
      }),
      events.on(GameEvent.Duck, () => this.play("duck", 0.28, 1.05)),
      events.on(GameEvent.Dive, () => this.play("duck", 0.35, 0.8)),
    ];
  }
  /** Set before emitting Step. Invalid/unsupported surfaces fall back to sand. */
  setSurface(surface: number) {
    this.surface = Number.isInteger(surface) && surface >= 0 && surface <= 9
      ? surface as SoundSurface : 0;
  }
  preload() {
    if (this.bytes) return;
    this.bytes = (async () => {
      const controller = new AbortController();
      this.loading = controller;
      const timer = setTimeout(() => controller.abort(), 12000);
      try {
        const response = await fetch(
          `${import.meta.env.BASE_URL}audio/game.mp3`,
          { signal: controller.signal },
        );
        if (!response.ok) return;
        return await response.arrayBuffer();
      } catch {
        return undefined;
      } finally {
        clearTimeout(timer);
        this.loading = undefined;
      }
    })();
  }
  unlock() {
    if ((!this.enabled && !this.musicEnabled) || !this.alive) return;
    try {
      if (!this.context) {
        this.context = new AudioContext();
        this.master = this.context.createGain();
        this.master.gain.value = Tuning.audio.master;
        this.master.connect(this.context.destination);
        this.limiter = this.context.createDynamicsCompressor();
        this.limiter.threshold.value = -10;
        this.limiter.ratio.value = 8;
        this.limiter.attack.value = 0.003;
        this.limiter.release.value = 0.15;
        this.limiter.connect(this.master);
        this.musicGain = this.context.createGain();
        this.musicGain.gain.value = Tuning.audio.music;
        this.musicGain.connect(this.limiter);
        for (let i = 0; i < 8; i++) {
          const gain = this.context.createGain();
          const filter = this.context.createBiquadFilter();
          filter.type = "lowpass";
          filter.Q.value = 0.5;
          filter.connect(gain);
          gain.connect(this.limiter);
          this.voices.push({ gain, filter, until: 0 });
        }
      }
      this.master!.gain.setValueAtTime(
        Tuning.audio.master,
        this.context.currentTime,
      );
      void this.context
        .resume()
        .then(() => {
          this.startMusic();
          this.flushCritical();
        })
        .catch(() => {});
      this.preload();
      if (!this.preparing) this.preparing = this.prepare();
    } catch {
      /* Optional audio must never block gameplay. */
    }
  }
  private async prepare() {
    const bytes = await this.bytes;
    if (!bytes || !this.context || !this.alive) return;
    try {
      const buffer = await this.context.decodeAudioData(bytes);
      if (!this.alive) return;
      if (buffer.numberOfChannels !== 1 || buffer.length * 4 >= 4 * 1024 * 1024)
        return;
      this.buffer = buffer;
      // One short scan on decode, never in RAF. The marker itself is never
      // submitted to audio; it aligns short sprite cues across browser codecs.
      const channel = buffer.getChannelData(0),
        limit = Math.min(channel.length, Math.round(buffer.sampleRate * 0.12));
      for (let i = 0; i < limit; i++)
        if (Math.abs(channel[i]) > 0.3) {
          const offset = i / buffer.sampleRate - sprite.sync.offset;
          if (Math.abs(offset) < 0.08) this.codecOffset = offset;
          break;
        }
      this.startMusic();
      this.flushCritical();
      if (this.pendingMenu) {
        const cue = this.pendingMenu;
        this.pendingMenu = undefined;
        this.play(cue, 0.35, 1);
      }
    } catch {
      /* Safari codec/context denial: the runner stays playable. */
    }
  }
  menu(cue: "ui" | "buy" | "error") {
    const sound = cue === "buy" ? "heal" : cue;
    if (!this.buffer) this.pendingMenu = sound;
    this.play(sound, 0.35, 1);
  }
  private play(cue: Cue, volume: number, rate: number, delay = 0, cutoff = 20000) {
    const context = this.context;
    if (
      this.enabled &&
      this.alive &&
      (cue === "hit" || cue === "death") &&
      (!this.buffer || context?.state !== "running")
    ) {
      this.pendingCritical = cue;
      if (context && context.state !== "closed")
        void context
          .resume()
          .then(() => this.flushCritical())
          .catch(() => {});
    }
    if (
      !this.enabled ||
      !this.alive ||
      !context ||
      !this.buffer ||
      context.state !== "running"
    )
      return;
    const now = context.currentTime;
    // Ordinary steps/pickups cannot steal either reserved collision channel.
    const critical = cue === "hit" || cue === "death";
    const first = critical ? (cue === "hit" ? 6 : 7) : 0;
    const end = critical ? first + 1 : 6;
    let voice = this.voices[first];
    for (let i = first; i < end; i++) {
      const candidate = this.voices[i];
      if (candidate.until <= now) {
        voice = candidate;
        break;
      }
      if (candidate.until < voice.until) voice = candidate;
    }
    if (voice.source) {
      voice.source.onended = null;
      voice.source.stop();
      voice.source.disconnect();
    }
    const source = context.createBufferSource(),
      clip = sprite[cue];
    source.buffer = this.buffer;
    source.playbackRate.value = rate;
    voice.filter.frequency.setValueAtTime(cutoff, now);
    source.connect(voice.filter);
    voice.gain.gain.setValueAtTime(volume * Tuning.audio.effects, now);
    voice.source = source;
    voice.until = now + delay + clip.duration / rate;
    source.onended = () => {
      source.disconnect();
      if (voice.source === source) {
        voice.source = undefined;
        voice.until = 0;
      }
    };
    source.start(
      now + delay,
      Math.max(0, clip.offset + this.codecOffset),
      clip.duration,
    );
    this.played++;
    this.lastCue = cue;
  }
  setRunning(running: boolean) {
    this.running = running;
    if (!running) this.setJetpack(false);
    if (running) this.startMusic();
    else this.stopMusic();
  }
  private startMusic() {
    if (
      !this.running ||
      !this.musicEnabled ||
      !this.alive ||
      this.music ||
      !this.buffer ||
      !this.context ||
      !this.musicGain ||
      this.context.state !== "running"
    )
      return;
    const source = this.context.createBufferSource(),
      clip = sprite.music;
    source.buffer = this.buffer;
    source.loop = true;
    source.loopStart = clip.offset + this.codecOffset;
    source.loopEnd = Math.min(
      this.buffer.duration,
      clip.offset + clip.duration + this.codecOffset,
    );
    source.connect(this.musicGain);
    source.start(0, source.loopStart);
    this.music = source;
  }
  private stopMusic() {
    if (this.music) {
      this.music.stop();
      this.music.disconnect();
      this.music = undefined;
    }
  }
  configure(effects: boolean, music: boolean) {
    if (this.context) {
      this.master?.gain.setValueAtTime(
        Tuning.audio.master,
        this.context.currentTime,
      );
      this.musicGain?.gain.setValueAtTime(
        Tuning.audio.music,
        this.context.currentTime,
      );
    }
    this.enabled = effects;
    this.musicEnabled = music;
    if (!music) this.stopMusic();
    if (!effects) this.pendingCritical = undefined;
    if (!effects)
      for (const voice of this.voices) {
        if (voice.source) {
          voice.source.onended = null;
          voice.source.stop();
          voice.source.disconnect();
          voice.source = undefined;
        }
        voice.until = 0;
      }
    if (!effects && !music) this.suspend();
    else this.startMusic();
  }
  private flushCritical() {
    if (
      !this.pendingCritical ||
      !this.buffer ||
      this.context?.state !== "running"
    )
      return;
    const cue = this.pendingCritical;
    this.pendingCritical = undefined;
    this.play(cue, 1, cue === "death" ? 0.65 : 0.85);
  }
  stop() {
    this.setJetpack(false);
    this.pendingMenu = undefined;
    this.pendingCritical = undefined;
    this.stopMusic();
    for (const voice of this.voices) {
      if (voice.source) {
        voice.source.onended = null;
        voice.source.stop();
        voice.source.disconnect();
        voice.source = undefined;
      }
      voice.until = 0;
    }
    if (this.context && this.master) {
      this.master.gain.cancelScheduledValues(this.context.currentTime);
      this.master.gain.value = 0;
      this.master.gain.setValueAtTime(0, this.context.currentTime);
    }
  }
  suspend() {
    this.stop();
    if (this.context && this.context.state !== "closed")
      void this.context.suspend().catch(() => {});
  }
  stats() {
    return {
      enabled: this.enabled,
      musicEnabled: this.musicEnabled,
      state: this.context?.state ?? "uninitialized",
      voices: this.voices.length,
      activeVoices: this.voices.filter((v) => v.source).length,
      gain: this.master?.gain.value ?? 0,
      loaded: !!this.buffer,
      played: this.played,
      lastCue: this.lastCue,
      musicPlaying: !!this.music,
      codecOffset: this.codecOffset,
      decodedBytes: this.buffer
        ? this.buffer.length * this.buffer.numberOfChannels * 4
        : 0,
    };
  }
  dispose() {
    this.alive = false;
    this.loading?.abort();
    for (const off of this.off) off();
    this.stop();
    for (const voice of this.voices) {
      voice.filter.disconnect();
      voice.gain.disconnect();
    }
    this.musicGain?.disconnect();
    this.limiter?.disconnect();
    this.master?.disconnect();
    this.buffer = undefined;
    this.bytes = undefined;
    if (this.context) void this.context.close().catch(() => {});
  }
}

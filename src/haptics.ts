import { GameEvent, GameEvents } from "./events";
import { bonusKindForObject } from "./bonuses";

/** Unsupported browsers (notably iOS) are a deliberate silent no-op. */
export class Haptics {
  enabled = true;
  private last = -Infinity;
  private readonly off: (() => void)[];
  private readonly patterns = {
    jump: 8,
    land: 12,
    hit: [35, 25, 45],
    death: [65, 40, 95],
    pickup: 10,
    heal: [12, 25, 12],
  };
  constructor(events: GameEvents) {
    this.off = [
      events.on(GameEvent.Jump, () => this.play(this.patterns.jump)),
      events.on(GameEvent.Land, () => this.play(this.patterns.land)),
      events.on(GameEvent.Hit, () => this.play(this.patterns.hit)),
      events.on(GameEvent.Death, () => this.play(this.patterns.death, true)),
      events.on(GameEvent.Pickup, () => this.play(this.patterns.pickup)),
      events.on(GameEvent.Heal, () => this.play(this.patterns.heal)),
      events.on(GameEvent.Collected, (kind) => {
        if (bonusKindForObject(kind) !== undefined) this.play(this.patterns.heal);
      }),
    ];
  }
  private play(pattern: number | number[], force = false) {
    if (
      !this.enabled ||
      document.hidden ||
      typeof navigator.vibrate !== "function"
    )
      return;
    const now = performance.now();
    if (!force && now - this.last < 65) return;
    this.last = now;
    try {
      navigator.vibrate(pattern);
    } catch {
      /* Optional device capability. */
    }
  }
  stop() {
    try {
      navigator.vibrate?.(0);
    } catch {
      /* Optional. */
    }
  }
  dispose() {
    for (const off of this.off) off();
    this.stop();
  }
}

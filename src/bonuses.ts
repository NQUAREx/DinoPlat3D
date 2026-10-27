/** Numeric order is shared with ObjectKind's contiguous 12–18 pickup range. */
export enum BonusKind {
  Jetpack,
  Invisibility,
  Magnet,
  Blindness,
  Turbo,
  Reverse,
  Shake,
}

/** Online accepted distance budget is 26 metres per active second (+5m slack). */
export const TURBO_MAX_SPEED = 26;

export const BONUS_DEFINITIONS = Object.freeze([
  { kind: BonusKind.Jetpack, name: "Jetpack", icon: "jetpack", duration: 6, weight: 1.2 },
  { kind: BonusKind.Invisibility, name: "Invisibility", icon: "invisibility", duration: 8, weight: 1.5 },
  { kind: BonusKind.Magnet, name: "Coin magnet", icon: "magnet", duration: 10, weight: 2 },
  { kind: BonusKind.Blindness, name: "Blindness", icon: "blindness", duration: 4, weight: 0.6 },
  { kind: BonusKind.Turbo, name: "Turbo", icon: "turbo", duration: 5, weight: 1 },
  { kind: BonusKind.Reverse, name: "Reverse controls", icon: "reverse", duration: 5, weight: 0.6 },
  { kind: BonusKind.Shake, name: "Extreme shake", icon: "shake", duration: 3, weight: 0.4 },
].map((definition) => Object.freeze(definition)));

/** Deliberately numeric: importing world here would introduce a cycle. */
export function bonusKindForObject(kind: number): BonusKind | undefined {
  return Number.isInteger(kind) && kind >= 12 && kind <= 18 ? kind - 12 : undefined;
}

/** Timers advance only when the simulation advances active gameplay. */
export class BonusState {
  readonly remaining = new Float64Array(BONUS_DEFINITIONS.length);
  active(kind: BonusKind): boolean {
    return this.remaining[kind] > 0;
  }
  /** Last 350ms fade out for visual effects; gameplay uses active(). */
  strength(kind: BonusKind): number {
    const t = Math.max(0, Math.min(1, (this.remaining[kind] ?? 0) / 0.35));
    return t * t * (3 - 2 * t);
  }
  reset() {
    this.remaining.fill(0);
  }
  step(dt: number) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    for (let i = 0; i < this.remaining.length; i++) {
      const next = this.remaining[i] - dt;
      this.remaining[i] = next < 1e-9 ? 0 : next;
    }
  }
  activate(kind: BonusKind) {
    const definition = BONUS_DEFINITIONS[kind];
    if (definition) this.remaining[kind] = definition.duration;
  }
}

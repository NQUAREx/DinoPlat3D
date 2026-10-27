import { GameEvent, type GameEvents } from "./events";
import { ObjectKind } from "./world";
import coinIcon from "./assets/icons/coin.png?url";
import diamondIcon from "./assets/icons/diamond.png?url";
import heartIcon from "./assets/icons/live.png?url";
import { BONUS_UI } from "./help";
import { bonusKindForObject } from "./bonuses";

/** Twelve reusable DOM labels, never sprites/meshes or a node per pickup. */
export class FloatingFeedback {
  readonly root = document.createElement("div");
  private readonly icons = new Map<number, string>([
    [ObjectKind.Coin, coinIcon],
    [ObjectKind.Diamond, diamondIcon],
    [ObjectKind.Heart, heartIcon],
  ]);
  private readonly slots = Array.from({ length: 12 }, () => {
    const element = document.createElement("div"),
      label = document.createElement("span"),
      icon = document.createElement("img"),
      glyph = document.createElement("span");
    element.className = "item-popup";
    element.hidden = true;
    icon.alt = "";
    glyph.className = "pickup-glyph";
    glyph.hidden = true;
    element.append(label, icon, glyph);
    this.root.append(element);
    return { element, label, icon, glyph, born: -Infinity, side: 0 };
  });
  private cursor = 0;
  private readonly off: (() => void)[];
  active = 0;
  constructor(
    events: GameEvents,
    host: HTMLElement,
    private readonly clock: () => number,
    private readonly reducedMotion: boolean,
  ) {
    this.root.className = "item-feedback";
    this.root.setAttribute("aria-hidden", "true");
    host.append(this.root);
    this.off = [
      events.on(GameEvent.Collected, (kind, amount) => this.show(kind, amount)),
      events.on(GameEvent.Hit, () => this.show(ObjectKind.Heart, -1)),
      events.on(GameEvent.Start, () => this.clear()),
    ];
  }
  registerIcon(kind: ObjectKind, url: string) {
    this.icons.set(kind, url);
  }
  private show(kind: number, amount: number) {
    const index = this.cursor++ % this.slots.length,
      slot = this.slots[index];
    const icon = this.icons.get(kind);
    // ObjectKind 12..18 matches BonusKind 0..6. Unknown kinds retain fallback feedback.
    const bonusKind = bonusKindForObject(kind);
    const bonus = bonusKind === undefined ? undefined : BONUS_UI[bonusKind];
    const negative = bonus?.negative;
    slot.born = this.clock();
    slot.side = ((index % 3) - 1) * 22;
    slot.label.textContent = bonus
      ? `${negative ? "! " : ""}${bonus.name} ${bonus.duration}с`
      : amount === 0 ? "MAX" : `${amount > 0 ? "+" : ""}${amount}`;
    slot.element.dataset.kind = String(kind);
    slot.element.dataset.bonus = String(!!bonus);
    slot.element.dataset.change = amount < 0 || negative ? "loss" : "gain";
    slot.glyph.hidden = true;
    if (icon) {
      slot.icon.src = icon;
      slot.icon.hidden = false;
    } else {
      slot.icon.hidden = true;
      if (bonus) {
        slot.glyph.textContent = bonus.icon;
        slot.glyph.hidden = false;
      } else {
        slot.label.textContent += " ✦";
      }
    }
    slot.element.hidden = false;
    this.active = Math.min(this.slots.length, this.active + 1);
  }
  update(time: number, x: number, y: number) {
    if (!this.active) return;
    let active = 0;
    for (const slot of this.slots) {
      if (slot.element.hidden) continue;
      const age = Math.max(0, time - slot.born);
      if (age >= 0.95) {
        slot.element.hidden = true;
        continue;
      }
      active++;
      const scale = this.reducedMotion
        ? 1
        : 1 + 0.12 * Math.max(0, 1 - age * 6);
      slot.element.style.transform = `translate3d(${x + slot.side}px,${y - age * (this.reducedMotion ? 12 : 48)}px,0) translate(-50%,-100%) scale(${scale})`;
      slot.element.style.opacity = String(Math.min(1, (0.95 - age) / 0.3));
    }
    this.active = active;
  }
  clear() {
    for (const slot of this.slots) slot.element.hidden = true;
    this.active = this.cursor = 0;
  }
  dispose() {
    for (const off of this.off) off();
    this.root.remove();
  }
}

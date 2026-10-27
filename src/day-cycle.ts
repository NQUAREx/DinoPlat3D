/** Pure time model: follows simulation time, so pause/reset/FPS are deterministic. */
export class DayCycle {
  hours = 9;
  automatic = true;
  private duration = 360 / 1.3;
  get cycleSeconds() {
    return this.duration;
  }
  set cycleSeconds(seconds: number) {
    if (!Number.isFinite(seconds) || seconds <= 0)
      throw new Error("Invalid day duration");
    this.duration = seconds;
  }
  private baseHours = 9;
  setTime(hours: number, automatic = false) {
    if (!Number.isFinite(hours)) throw new Error("Invalid time of day");
    this.baseHours = ((hours % 24) + 24) % 24;
    this.hours = this.baseHours;
    this.automatic = automatic;
  }
  sample(elapsed: number) {
    this.hours =
      (this.baseHours +
        (this.automatic
          ? (Math.max(0, elapsed) * 24) / this.cycleSeconds
          : 0)) %
      24;
    return this.hours;
  }
}

/** Classifies before moving. Up-swipes never need positional rollback. */
export class GestureRecognizer {
  static holdDelay = 30;
  private active = false;
  private state: "pending" | "hold" | "vertical" = "pending";
  private startX = 0;
  private startY = 0;
  private started = 0;
  private moved = false;
  private direction = 0;
  constructor(
    private readonly steer: (value: number) => void,
    private readonly jump: () => void,
    private readonly down: () => void = () => {},
  ) {}
  begin(x: number, y: number, now: number, direction: number) {
    this.clear();
    this.active = true;
    this.state = "pending";
    this.startX = x;
    this.startY = y;
    this.started = now;
    this.direction = direction;
    this.moved = false;
  }
  move(x: number, y: number, direction: number) {
    if (!this.active) return;
    const dx = x - this.startX,
      dy = y - this.startY;
    this.direction = direction;
    if (this.state === "vertical") return;
    // Classification is exclusive. A confirmed hold cannot later become a jump;
    // release it and start a fresh swipe. Thus jumping never inherits steering.
    if (this.state === "hold") {
      this.steer(direction);
      return;
    }
    if (Math.abs(dy) > 24 && Math.abs(dy) > Math.abs(dx) * 1.15) {
      this.state = "vertical";
      this.steer(0);
      if (dy < 0) this.jump();
      else this.down();
      return;
    }
    if (Math.abs(dy) > 2 || Math.abs(dx) > 2) this.moved = true;
    if (Math.abs(dx) > 2.7 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      this.state = "hold";
      this.steer(direction);
    }
  }
  update(now: number) {
    // A moving finger is still a gesture, however slowly it moves upward.
    if (
      this.active &&
      this.state === "pending" &&
      !this.moved &&
      now - this.started >= GestureRecognizer.holdDelay
    ) {
      this.state = "hold";
      this.steer(this.direction);
    }
  }
  clear() {
    this.active = false;
    this.state = "pending";
    this.steer(0);
  }
}

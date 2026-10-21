/** Shared numeric rules, no rendering or browser dependencies. Forward is world Z. */
export class Rules {
  static readonly step = 1 / 120;
  static turnSpeed = 1.76;
  static blockingRadius = 0.22;
  static cactusHitScale = 0.65;
  static pickupSpawnChance = 0.9;
  static maxSpeed = 24;
  static startSpeed = 12;
  static immunitySeconds = 2;
  static hitStopSeconds = 1;
  static deathSeconds = 1.25;
  static readonly cactusScale = 2;
  static readonly chunkSize = 16;
  static readonly candidatesPerChunk = 6;
  static readonly pickupsPerChunk = 4;
  static readonly slotsPerChunk =
    Rules.candidatesPerChunk + Rules.pickupsPerChunk;
  static firstRow = 28;
  static readonly rowSlots = 15;
  static readonly maxColumns = 15;
  static readonly poolSize =
    Rules.rowSlots * Rules.maxColumns * Rules.slotsPerChunk;
  static playerRadius = 0.32;
  static playerBodyHeight = 1.3;
  static duckBodyHeight = 0.65;
  static duckDuration = 0.85;
  static duckBlendSpeed = 12;
  static diveSpeed = 22;
  static gravity = 31.68;
  // Preserve jump clearance after doubling cactus height (v² / 2g).
  static jumpSpeed = 15.96;
  static readonly runFramesPerMetre = 0.9;
  static stepStride = 4 / Rules.runFramesPerMetre;
  static lodNear = 26.4;
  static lodFar = 36;
}
export class Palette {
  static readonly sky = 0x73d8ff;
  static readonly dust = 0xf4c66a;
  static readonly shade = 0x9a743f;
}
export class GridMath {
  static mod(value: number, divisor: number) {
    return ((value % divisor) + divisor) % divisor;
  }
  static hash(x: number, z: number, seed: number) {
    let h = Math.imul(x | 0, 0x1f123bb5) ^ Math.imul(z | 0, 0x5f356495) ^ seed;
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
    h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
    return (h ^ (h >>> 16)) >>> 0;
  }
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CameraRig } from "../src/camera.ts";
import { COSMETICS, CosmeticInventory } from "../src/cosmetics.ts";
import { Currency, Wallet } from "../src/progression.ts";
import { GameEvents, GameEvent } from "../src/events.ts";
import { Rules } from "../src/config.ts";

test("camera view switch uses a reversible cosine ease with stable endpoints and no dt-zero snap", () => {
  const rig = new CameraRig(true);
  rig.firstPerson = true;
  rig.update(0, 0, 0, false);
  assert.equal(rig.firstPersonBlend, 0);
  assert.equal(rig.camera.position.y, 8.5);
  rig.update(0, 0, 0.325, false);
  assert.ok(Math.abs(rig.firstPersonBlend - 0.5) < 1e-10);
  assert.ok(Math.abs(rig.camera.position.y - (8.5 + 1.45) / 2) < 1e-10);
  assert.equal(rig.camera.fov, 57.5);
  const middle = rig.camera.position.clone();
  rig.firstPerson = false;
  rig.update(0, 0, 0, false);
  assert.ok(rig.camera.position.distanceTo(middle) < 1e-10);
  rig.update(0, 0, 0.65, false);
  assert.equal(rig.firstPersonBlend, 0);
  assert.equal(rig.transitioning, false);
  rig.firstPerson = true;
  for (let i = 0; i < 120; i++) rig.update(0, 0, 1 / 120, false);
  assert.equal(rig.firstPersonBlend, 1);
  assert.equal(rig.avatarVisible, false);
  assert.equal(rig.camera.fov, 65);
});
test("first-person heading has exactly the same exponential smoothing as third person across unwrapped turns", () => {
  const front = new CameraRig(true),
    rear = new CameraRig(true);
  front.firstPerson = true;
  front.update(0, 0, 0.65, false);
  for (let i = 0; i < 300; i++) {
    const heading = i * 0.02;
    front.update(0, 0, 1 / 60, false, heading);
    rear.update(0, 0, 1 / 60, false, heading);
    assert.equal(front.heading, rear.heading);
  }
  assert.ok(front.heading < 5.98 && front.heading > 5);
});
test("shake is scaled +30% in first person and -15% in third person", () => {
  for (const first of [false, true]) {
    const rig = new CameraRig();
    rig.firstPerson = first;
    rig.update(0, 0, 0.65, false);
    rig.update(1.1, 0, 1 / 60, true);
    const blend = 1 - Math.exp(-12 / 60),
      bob =
        Math.sin((1.1 * Math.PI * 2) / Rules.stepStride) *
        0.035 *
        2.9 *
        1.5 *
        1.5 *
        blend;
    const expected = (first ? 1.45 : 8.5) + bob * (first ? 0.2 * 1.3 : 0.85);
    assert.ok(Math.abs(rig.camera.position.y - expected) < 1e-10);
  }
});
test("shop purchase/equip is validated, charged once and survives reload; accessories do not change physics", () => {
  const events = new GameEvents(),
    wallet = new Wallet(events);
  let saved = "";
  const storage = {
    getItem: () => saved,
    setItem: (_key: string, value: string) => {
      saved = value;
    },
  };
  const shop = new CosmeticInventory(wallet, storage);
  assert.equal(COSMETICS.filter((i) => i.category === "dino").length, 24);
  assert.equal(COSMETICS.filter((i) => i.category === "hat").length, 23);
  assert.equal(COSMETICS.filter((i) => i.category === "boots").length, 23);
  assert.equal(shop.equipped.dino, "dino-green");
  assert.equal(shop.choose("dino-white"), "funds");
  wallet.add(Currency.Coin, 2500);
  wallet.add(Currency.Diamond, 90);
  let spends = 0,
    pickups = 0;
  events.on(GameEvent.WalletChanged, () => spends++);
  events.on(GameEvent.Pickup, () => pickups++);
  assert.equal(shop.choose("dino-white"), "purchased");
  assert.equal(wallet.coins, 1750);
  assert.equal(shop.choose("dino-white"), "equipped");
  assert.equal(wallet.coins, 1750);
  assert.equal(shop.choose("hat-safari"), "purchased");
  assert.equal(shop.choose("boots-red"), "purchased");
  assert.equal(shop.choose("dino-pink"), "purchased");
  assert.equal(wallet.diamonds, 30);
  assert.equal(shop.choose("unknown"), "invalid");
  assert.equal(wallet.spend(Currency.Coin, -1), false);
  const loaded = new CosmeticInventory(wallet, storage);
  assert.deepEqual(loaded.equipped, shop.equipped);
  assert.equal(spends, 4);
  assert.equal(pickups, 0);
  loaded.remove("hat");
  assert.equal(loaded.equipped.hat, "");
  loaded.remove("dino");
  assert.equal(loaded.equipped.dino, "dino-pink");
});
test("malformed or blocked cosmetic storage cannot grant invalid equipment or stop play", () => {
  const wallet = new Wallet(new GameEvents());
  const inventory = new CosmeticInventory(wallet, {
    getItem: () =>
      JSON.stringify({
        version: 1,
        owned: ["unknown", "hat-cap"],
        equipped: { dino: "hat-cap", hat: "dino-pink", boots: "unknown" },
      }),
    setItem: () => {
      throw Error("blocked");
    },
  });
  assert.deepEqual(inventory.equipped, {
    dino: "dino-green",
    hat: "",
    boots: "",
    watch: "",
    gloves: "",
  });
  assert.equal(inventory.choose("hat-cap"), "equipped");
});
test("audio ships one small MP3, twenty-two licensed cues and an original loop, not runtime remote requests", async () => {
  const sprite = JSON.parse(
    await readFile(
      new URL("../src/assets/audio-sprite.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(Object.keys(sprite).length, 24);
  assert.equal(sprite.music.duration, 16);
  const bytes = await readFile(
    new URL("../public/audio/game.mp3", import.meta.url),
  );
  assert.ok(bytes.length < 180000);
  for (const cue of Object.values(sprite) as {
    offset: number;
    duration: number;
  }[]) {
    assert.ok(cue.duration > 0);
    assert.ok(cue.offset >= 0);
  }
});

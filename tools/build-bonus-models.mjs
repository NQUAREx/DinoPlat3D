// Original offline bonus props. Run: node tools/build-bonus-models.mjs
// All pieces are baked into one indexed, packed-colour mesh per pickup.
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { BoxGeometry, Color, CylinderGeometry, ExtrudeGeometry, OctahedronGeometry, Shape } from "three";
import { encodeGlb } from "./build-biome-models.mjs";

class Model {
  constructor(name) {
    this.name = name;
    this.positions = []; this.normals = []; this.colors = []; this.indices = [];
    this.vertices = new Map();
  }
  add(geometry, hex, x = 0, y = 0, z = 0, rotation = 0) {
    geometry.rotateZ(rotation).translate(x, y, z);
    const p = geometry.attributes.position, n = geometry.attributes.normal;
    const color = new Color(hex).toArray().map(v => Math.round(v * 255));
    for (let i = 0; i < (geometry.index?.count ?? p.count); i++) {
      const j = geometry.index ? geometry.index.getX(i) : i;
      const position = [p.getX(j), p.getY(j), p.getZ(j)];
      const normal = [n.getX(j), n.getY(j), n.getZ(j)];
      const key = [...position, ...normal, ...color].map(v => Math.round(v * 1e6)).join(",");
      let index = this.vertices.get(key);
      if (index === undefined) {
        index = this.positions.length / 3;
        this.vertices.set(key, index);
        this.positions.push(...position); this.normals.push(...normal); this.colors.push(...color);
      }
      this.indices.push(index);
    }
    geometry.dispose();
  }
  box(w, h, d, color, x, y, z) { this.add(new BoxGeometry(w, h, d), color, x, y, z); }
  cylinder(r, h, color, x, y, z = 0) { this.add(new CylinderGeometry(r, r, h, 6), color, x, y, z); }
  profile(points, depth, color, x = 0, y = 0, z = 0) {
    const shape = new Shape();
    points.forEach(([px, py], i) => i ? shape.lineTo(px, py) : shape.moveTo(px, py));
    shape.closePath();
    this.add(new ExtrudeGeometry(shape, { depth, steps: 1, bevelEnabled: false, curveSegments: 1 }).translate(0, 0, -depth / 2), color, x, y, z);
  }
  finish() {
    // All pickups share a Y=0 base, centered X/Z, <=.45m yaw radius.
    let minY = Infinity;
    for (let i = 1; i < this.positions.length; i += 3) minY = Math.min(minY, this.positions[i]);
    for (let i = 1; i < this.positions.length; i += 3) this.positions[i] -= minY;
    delete this.vertices;
    return this;
  }
}
const ink = 0x24374d, cream = 0xfff2c3, coral = 0xff704c, blue = 0x35c9ed;
const bevel = (w, h, b = .055) => [[-w/2+b,-h/2],[w/2-b,-h/2],[w/2,-h/2+b],[w/2,h/2-b],[w/2-b,h/2],[-w/2+b,h/2],[-w/2,h/2-b],[-w/2,-h/2+b]];
const arrow = [[-.34,-.075],[.09,-.075],[.09,-.17],[.34,0],[.09,.17],[.09,.075],[-.34,.075]];

export function buildBonusModels() {
  const models = [];
  const jet = new Model("bonus-jetpack");
  jet.profile(bevel(.55,.53), .12, ink, 0, .39, -.06);
  for (const x of [-.19,.19]) {
    jet.cylinder(.135,.58, blue,x,.43);
    jet.cylinder(.144,.09, cream,x,.62);
    jet.cylinder(.105,.13, ink,x,.075);
  }
  jet.box(.18,.2,.07,coral,0,.4,.13);
  models.push(jet.finish());

  const prism = new Model("bonus-invisibility");
  prism.add(new CylinderGeometry(.28,.28,.68,3),0x9ef9ff,0,.4,0);
  prism.add(new CylinderGeometry(.3,.3,.06,3),0x8275e5,0,.03,0);
  prism.add(new CylinderGeometry(.3,.3,.06,3),0x8275e5,0,.77,0);
  models.push(prism.finish());

  const magnet = new Model("bonus-magnet"), horseshoe = [];
  horseshoe.push([-.36,.7],[-.36,.36]);
  for (let i = 1; i <= 8; i++) { const a = Math.PI + i*Math.PI/8; horseshoe.push([Math.cos(a)*.36,.36+Math.sin(a)*.36]); }
  horseshoe.push([.36,.7],[.17,.7],[.17,.36]);
  for (let i = 1; i <= 8; i++) { const a = -i*Math.PI/8; horseshoe.push([Math.cos(a)*.17,.36+Math.sin(a)*.17]); }
  horseshoe.push([-.17,.7]);
  magnet.profile(horseshoe,.2,coral);
  for (const x of [-.265,.265]) magnet.box(.19,.14,.21,cream,x,.66,0);
  models.push(magnet.finish());

  const goggles = new Model("bonus-blindness");
  for (const x of [-.2,.2]) {
    goggles.profile(bevel(.36,.3),.16,0x8275e5,x,.22,0);
    goggles.profile(bevel(.27,.21,.035),.03,ink,x,.22,.095);
    goggles.box(.055,.08,.012,blue,x-.07,.26,.116);
  }
  goggles.box(.08,.07,.12,cream,0,.23,0);
  goggles.box(.69,.08,.06,ink,0,.24,-.16);
  models.push(goggles.finish());

  const bolt = new Model("bonus-turbo");
  const lightning = [[.04,.82],[-.29,.35],[-.04,.35],[-.14,0],[.31,.48],[.06,.48],[.2,.82]];
  bolt.profile(lightning,.19,0xffb52e);
  bolt.profile(lightning.map(([x,y]) => [x*.7,y*.7]),.025,cream,0,.12,.11);
  models.push(bolt.finish());

  const reverse = new Model("bonus-reverse");
  reverse.profile(arrow,.15,blue,0,.57,.035);
  reverse.profile(arrow.map(([x,y])=>[-x,-y]),.15,coral,0,.18,-.035);
  models.push(reverse.finish());

  const shake = new Model("bonus-shake");
  shake.profile(bevel(.39,.58),.22,0x8275e5,0,.34);
  shake.box(.25,.22,.02,ink,0,.42,.12);
  shake.box(.13,.06,.025,0x7be344,0,.43,.14);
  shake.cylinder(.055,.07,coral,0,.665);
  shake.box(.08,.06,.025,cream,0,.19,.13);
  const wave = [[-.035,-.18],[.055,-.09],[.02,0],[.055,.09],[-.035,.18],[-.075,.13],[-.015,.07],[-.045,0],[-.015,-.07],[-.075,-.13]];
  for (const sign of [-1,1]) shake.profile(wave.map(([x,y])=>[x*sign,y]),.08,0xffb52e,sign*.32,.34);
  models.push(shake.finish());

  // Auxiliary eight-triangle particle, also authored offline (not a pickup).
  const smoke = new Model("effect-smoke");
  smoke.add(new OctahedronGeometry(1,0),0xffffff);
  delete smoke.vertices;
  models.push(smoke);
  return models;
}

export function buildBonusGlb() { return encodeGlb(buildBonusModels()); }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const models = buildBonusModels(), bytes = encodeGlb(models);
  await writeFile(new URL("../src/assets/bonus-models.glb", import.meta.url), bytes);
  for (const m of models) console.log(`${m.name}: ${m.indices.length/3} triangles`);
  console.log(`bonus-models.glb: ${bytes.length} bytes`);
}

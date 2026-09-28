import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/* Blaze world — renderer, three map builders, shared low-poly visuals.
   Ported verbatim from the approved demo; only module exports were added. */
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);
const IS_TOUCH = window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;


/* ================= THREE SETUP (mobile-first perf) ================= */
export const Quality = {
  current: localStorage.getItem('blaze_quality') || 'auto',
  get level() { return this.current === 'auto' ? (IS_TOUCH ? 'low' : 'high') : this.current; },
};
export const canvas = $('game-canvas');
export const renderer = new THREE.WebGLRenderer({ canvas, antialias: !IS_TOUCH, powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = false;
renderer.shadowMap.type = THREE.PCFShadowMap;
export const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87b5e0);
scene.fog = new THREE.Fog(0xbcd4ea, 34, 110);
export const camera = new THREE.PerspectiveCamera(75, 1, 0.05, 260);
camera.rotation.order = 'YXZ';
scene.add(camera);
// Two lights total (was: hemi + dir + 6 point lights). Colors set per map by setMap().
const hemi = new THREE.HemisphereLight(0xbfd9ff, 0x7a7568, 1.15);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff2d9, 1.5);
sun.position.set(60, 90, 40);
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.left = -32; sun.shadow.camera.right = 32;
sun.shadow.camera.top = 32; sun.shadow.camera.bottom = -32;
sun.shadow.camera.near = 1; sun.shadow.camera.far = 160;
sun.shadow.bias = -0.002;
scene.add(sun);

export function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

/* ---- daytime sky per map: gradient dome + visible sun disc (2 draw calls) ---- */
function makeSky(top, mid, horizon, sunColor, sunR, sunDir) {
  const grp = new THREE.Group();
  const c = document.createElement('canvas'); c.width = 4; c.height = 256;
  const g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 0, 256);
  gr.addColorStop(0, top);
  gr.addColorStop(0.45, mid);
  gr.addColorStop(0.62, horizon);
  gr.addColorStop(1, horizon);
  g.fillStyle = gr; g.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const dome = new THREE.Mesh(new THREE.SphereGeometry(190, 12, 8),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false }));
  grp.add(dome);
  const dir = sunDir.clone().normalize();
  const disc = new THREE.Mesh(new THREE.CircleGeometry(sunR, 24),
    new THREE.MeshBasicMaterial({ color: sunColor, fog: false }));
  disc.position.copy(dir).multiplyScalar(175); disc.lookAt(0, 0, 0);
  grp.add(disc);
  const glow = new THREE.Mesh(new THREE.CircleGeometry(sunR * 2.4, 24),
    new THREE.MeshBasicMaterial({ color: sunColor, fog: false, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false }));
  glow.position.copy(dir).multiplyScalar(174); glow.lookAt(0, 0, 0);
  grp.add(glow);
  return grp;
}

/* ---- shared materials: MeshLambertMaterial (cheap) + MeshBasicMaterial (unlit) ---- */
const lam = (color, emissive = 0x000000, emissiveIntensity = 1) =>
  new THREE.MeshLambertMaterial({ color, emissive, emissiveIntensity });
const MAT = {
  ember:   new THREE.MeshBasicMaterial({ color: 0xff6b35 }),
  lamp:    new THREE.MeshBasicMaterial({ color: 0xffd23e }),
  // soldiers — player (ember), bot combat (red/grey), bot tracksuit (squid green)
  pTorso:  lam(0xe06a1f, 0x3a1500, 1),
  pLimb:   lam(0x7a3410),
  pHead:   lam(0xe8b58a),
  pVisor:  new THREE.MeshBasicMaterial({ color: 0xffd23e }),
  bTorso:  lam(0xc22a1c),
  bLimb:   lam(0x4a4a4e),
  bHead:   lam(0xd9a06f),
  bVisor:  new THREE.MeshBasicMaterial({ color: 0xff2d1e }),
  tTorso:  lam(0x0e8a5f),
  tLimb:   lam(0x0a6b48),
  tVisor:  new THREE.MeshBasicMaterial({ color: 0xffffff }),
  gunVC:   new THREE.MeshLambertMaterial({ vertexColors: true }),
  hit:     new THREE.MeshBasicMaterial({ visible: false }),
};
const GEO = {
  box:    new THREE.BoxGeometry(1, 1, 1),
  barrel: new THREE.CylinderGeometry(0.55, 0.55, 1.4, 8),
  head:   new THREE.SphereGeometry(0.21, 8, 6),
};

/* ================= MAP SYSTEM =================
   Three maps, built once at startup into separate groups (merged static geometry,
   single-digit draw calls per material). Only the active map is visible. */
export let mapKey = localStorage.getItem('blaze_map') || 'sector';
if (!['sector', 'dolls', 'harbor'].includes(mapKey)) mapKey = 'sector';
const mapCtxs = {};
export let cur = null;              // active map context
export let obstacles = [];          // reassigned on setMap — collide()/groundHeight() read these
export let ramps = [];
export let losMeshes = [];
export let SPAWNS = [];
let buckets = new Map();     // material -> transformed geometries (build-time only)
const _e = new THREE.Euler(), _q = new THREE.Quaternion(),
      _p = new THREE.Vector3(), _s = new THREE.Vector3(), _m4 = new THREE.Matrix4();
function pushGeo(mat, geo) {
  let arr = buckets.get(mat);
  if (!arr) { arr = []; buckets.set(mat, arr); }
  arr.push(geo);
}
function box(mat, sx, sy, sz, x, y, z, ry = 0, obstacle = true) {
  _e.set(0, ry, 0); _q.setFromEuler(_e);
  _p.set(x, y, z); _s.set(sx, sy, sz);
  _m4.compose(_p, _q, _s);
  const g = GEO.box.clone().applyMatrix4(_m4);
  pushGeo(mat, g);
  if (obstacle) { g.computeBoundingBox(); obstacles.push(g.boundingBox.clone()); }
}
function barrelAt(mat, x, z) {
  _e.set(0, 0, 0); _q.setFromEuler(_e);
  _p.set(x, 0.7, z); _s.set(1, 1, 1);
  _m4.compose(_p, _q, _s);
  const g = GEO.barrel.clone().applyMatrix4(_m4);
  pushGeo(mat, g);
  g.computeBoundingBox(); obstacles.push(g.boundingBox.clone());
}
function groupBox(mat, gx, gz, gry, lx, ly, lz, rx, sx, sy, sz, obstacle = false) {
  const grp = new THREE.Object3D();
  grp.position.set(gx, 0, gz); grp.rotation.y = gry;
  const m = new THREE.Object3D();
  m.position.set(lx, ly, lz); m.rotation.x = rx; m.scale.set(sx, sy, sz);
  grp.add(m); grp.updateMatrixWorld(true);
  const g = GEO.box.clone().applyMatrix4(m.matrixWorld);
  pushGeo(mat, g);
  if (obstacle) { g.computeBoundingBox(); obstacles.push(g.boundingBox.clone()); }
}
function decalCyl(mat, r, h, seg, x, y, z, ex, ey, ez) {
  _e.set(ex, ey, ez); _q.setFromEuler(_e);
  _p.set(x, y, z); _s.set(1, 1, 1);
  _m4.compose(_p, _q, _s);
  pushGeo(mat, new THREE.CylinderGeometry(r, r, h, seg).applyMatrix4(_m4));
}
export function groundHeight(x, z, feetY) {
  let g = 0;
  for (const b of obstacles) {
    if (x > b.min.x - 0.25 && x < b.max.x + 0.25 && z > b.min.z - 0.25 && z < b.max.z + 0.25) {
      if (b.max.y <= feetY + 0.55 && b.max.y > g) g = b.max.y;
    }
  }
  for (const r of ramps) {
    const dx = x - r.x, dz = z - r.z;
    const c = Math.cos(r.ry), s = Math.sin(r.ry);
    const lx = dx * c - dz * s, lz = dx * s + dz * c;
    if (Math.abs(lx) <= r.w / 2 + 0.25 && lz >= -r.len / 2 - 0.25 && lz <= r.len / 2 + 0.25) {
      const t = clamp((lz + r.len / 2) / r.len, 0, 1);
      const hh = r.h * (1 - t);
      if (hh <= feetY + 0.55 && hh > g) g = hh;
    }
  }
  return g;
}
function newCtx(key) {
  return { key, group: new THREE.Group(), sky: new THREE.Group(), doll: null,
           spawns: [], bounds: { hx: 26, hz: 26 }, obstacles: [], ramps: [], losMeshes: [],
           fogColor: 0xbcd4ea, hemiSky: 0xbfd9ff, hemiGround: 0x7a7568, hemiInt: 1.15,
           sunColor: 0xfff2d9, sunInt: 1.5, sunPos: [60, 90, 40] };
}
function finalizeMap(ctx) {
  for (const [mat, geos] of buckets) {
    const mesh = new THREE.Mesh(mergeGeometries(geos, false), mat);
    mesh.receiveShadow = true;
    ctx.group.add(mesh);
    ctx.losMeshes.push(mesh);
  }
  buckets = new Map();
  ctx.obstacles = obstacles; ctx.ramps = ramps;
  obstacles = []; ramps = [];
  ctx.group.visible = false; ctx.sky.visible = false;
  scene.add(ctx.group); scene.add(ctx.sky);
  mapCtxs[ctx.key] = ctx;
}

/* ---- MAP 1: SECTOR 04 — industrial arena, brightened to daytime ---- */
function buildSector04() {
  const ctx = newCtx('sector');
  const P = {
    floor: lam(0x70767e), wall: lam(0xa8adb5),
    stripe: lam(0xff6b35, 0x903000, 0.7),
    crate: lam(0x8a6f4d), crateD: lam(0x6b6248),
    barrel: lam(0xb34700), barrelB: lam(0x2e6a9e),
    pillar: lam(0x4a4a50), plat: lam(0x5a5a62),
    contA: lam(0x9a4a1e), contB: lam(0x3e6a8a),
  };
  const HALF = 26;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(HALF * 2 + 10, HALF * 2 + 10), P.floor);
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
  ctx.group.add(floor);
  const grid = new THREE.GridHelper(HALF * 2, 26, 0x8a8f96, 0x5f646c);
  grid.position.y = 0.02;
  ctx.group.add(grid);

  const W = HALF + 2;
  for (const [x, z, w, d] of [[0, -W, W * 2, 1], [0, W, W * 2, 1], [-W, 0, 1, W * 2], [W, 0, 1, W * 2]]) {
    box(P.wall, w, 4, d, x, 2, z, 0, false);
    box(P.stripe, w === 1 ? 1.1 : w, 0.5, d === 1 ? 1.1 : d, x, 0.55, z, 0, false);
  }
  box(P.pillar, 1.6, 7, 1.6, -4, 3.5, -4);
  box(P.pillar, 1.6, 7, 1.6, 4, 3.5, -4);
  box(P.pillar, 11, 1.2, 1.8, 0, 7.4, -4, 0, false);
  box(MAT.ember, 11, 0.18, 0.3, 0, 6.75, -3.05, 0, false);

  const plat = (x, z, w, d, h) => {
    box(P.plat, w, h, d, x, h / 2, z);
    box(P.stripe, w, 0.12, 0.25, x, h + 0.06, z - d / 2 + 0.15, 0, false);
  };
  plat(-14, -14, 6, 6, 2.2);
  plat(14, 14, 6, 6, 2.2);
  plat(0, 18, 8, 5, 1.6);
  const ramp = (x, z, w, len, h, ry) => {
    ramps.push({ x, z, w, len, h, ry });
    const hyp = Math.hypot(len, h), ang = Math.atan2(h, len);
    groupBox(P.plat, x, z, ry, 0, h / 2 - 0.08, 0, ang, w, 0.3, hyp, false);
    groupBox(MAT.ember, x, z, ry, 0, h + 0.02, -len / 2, 0, w, 0.1, 0.18, false);
  };
  ramp(-14, -9.2, 3, 4.8, 2.2, 0);
  ramp(14, 9.2, 3, 4.8, 2.2, Math.PI);
  ramp(0, 13.6, 3.5, 4.2, 1.6, Math.PI);

  const cont = (mat, x, z, ry) => {
    box(mat, 6, 2.6, 2.4, x, 1.3, z, ry);
    box(MAT.ember, 0.2, 2.2, 0.2, x + Math.cos(ry) * 2.9, 1.2, z - Math.sin(ry) * 2.9, 0, false);
  };
  cont(P.contA, -20, 4, 0.35);
  cont(P.contB, 20, -4, -0.35);
  cont(P.contB, 8, -18, 0.1);
  cont(P.contA, -8, 20, -0.12);

  const crates = [
    [-11, -11, 2.2], [-8.8, -11, 2.2], [-10, -8.8, 2.2], [-10, -11, 4.2, true],
    [11, 11, 2.2], [13.4, 11.4, 2.2], [12, 13.4, 2.2],
    [-16, 6, 2.8], [10, -12, 2.8], [-2.6, 12, 2.2], [6, 2, 2.2], [-6, 0, 2.2],
    [18, 6, 2.2], [-18, -6, 2.2], [2, -8, 2.4], [-3, -3, 2.0],
  ];
  crates.forEach(([x, z, s, stacked], i) => {
    box(i % 2 ? P.crate : P.crateD, s, s, s, x, s / 2, z, (x * 7 + z * 13) % 3 * 0.25);
    if (stacked) box(P.crateD, s * 0.75, s * 0.75, s * 0.75, x, s + s * 0.36, z, 0.4);
  });
  const barrelSpots = [[-18, -18], [-16.9, -16.7], [18, 18], [16.9, 18], [18, -10], [-18, 12], [8, 20], [-8, -20], [4, 8], [-4, -8]];
  barrelSpots.forEach(([x, z], i) => {
    barrelAt(i % 2 ? P.barrelB : P.barrel, x, z);
    box(MAT.ember, 1.12, 0.08, 1.12, x, 1.15, z, 0, false);
  });
  box(P.wall, 8, 1.1, 0.6, -6, 0.55, -14);
  box(P.wall, 8, 1.1, 0.6, 6, 0.55, 14);
  box(P.wall, 0.6, 1.1, 8, -16, 0.55, 0);
  box(P.wall, 0.6, 1.1, 8, 16, 0.55, 0);
  const braz = (x, z) => {
    barrelAt(P.pillar, x, z);
    box(MAT.ember, 0.9, 0.25, 0.9, x, 1.5, z, 0, false);
  };
  braz(-4, -4); braz(4, 6);
  const lampAt = (x, z) => box(MAT.lamp, 2.2, 0.25, 2.2, x, 8.6, z, 0, false);
  lampAt(0, -4); lampAt(-12, 8); lampAt(12, -8); lampAt(0, 16);

  ctx.sky = makeSky('#2f6fd0', '#7fb2ee', '#cfe6ff', 0xfff6d8, 11, new THREE.Vector3(0.55, 0.62, 0.35));
  ctx.spawns = [new THREE.Vector3(0, 0, -20), new THREE.Vector3(18, 0, 18), new THREE.Vector3(-18, 0, 18)];
  ctx.bounds = { hx: 26, hz: 26 };
  ctx.fogColor = 0xbcd4ea;
  ctx.hemiSky = 0xbfd9ff; ctx.hemiGround = 0x7a7568; ctx.hemiInt = 1.15;
  ctx.sunColor = 0xfff2d9; ctx.sunInt = 1.5; ctx.sunPos = [60, 90, 40];
  finalizeMap(ctx);
}

/* ---- MAP 2: DOLL'S YARD — Squid Game red-light-green-light schoolyard ---- */
function buildDollsYard() {
  const ctx = newCtx('dolls');
  const P = {
    floor: lam(0xe6d3a3),            // sand
    wall: lam(0xf2a7bb),             // pastel pink walls
    wallTop: lam(0xe88ba5),
    decal: lam(0xffffff),            // painted shapes + yard lines
    lineRed: lam(0xd23c3c),
    platform: lam(0xc9b189),
    dress: lam(0xe8722a),
    skin: lam(0xf0c8a0),
    hair: lam(0x181818),
    trunk: lam(0x6b4a2e),
    leaf: lam(0x4e9a51),
    barrier: lam(0xef9db4),
  };
  const HX = 16, HZ = 24;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(HX * 2 + 14, HZ * 2 + 14), P.floor);
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
  ctx.group.add(floor);

  // walls (pastel pink) + painted circle / triangle / square decals
  const WH = 5;
  box(P.wall, HX * 2 + 2, WH, 1, 0, WH / 2, -HZ - 0.5, 0, false);
  box(P.wall, HX * 2 + 2, WH, 1, 0, WH / 2, HZ + 0.5, 0, false);
  box(P.wall, 1, WH, HZ * 2 + 2, -HX - 0.5, WH / 2, 0, 0, false);
  box(P.wall, 1, WH, HZ * 2 + 2, HX + 0.5, WH / 2, 0, 0, false);
  box(P.wallTop, HX * 2 + 2.2, 0.5, 1.2, 0, WH + 0.25, -HZ - 0.5, 0, false);
  box(P.wallTop, HX * 2 + 2.2, 0.5, 1.2, 0, WH + 0.25, HZ + 0.5, 0, false);
  // painted shapes on the inner faces (white decals, no extra lights)
  decalCyl(P.decal, 1.3, 0.08, 24, -8, 2.8, -HZ + 0.06, Math.PI / 2, 0, 0);   // circle
  decalCyl(P.decal, 1.3, 0.08, 3, 8, 2.8, -HZ + 0.06, Math.PI / 2, 0, 0);      // triangle
  box(P.decal, 2.2, 2.2, 0.08, 0, 2.8, -HZ + 0.06, 0, false);                 // square
  decalCyl(P.decal, 1.1, 0.08, 24, -HX + 0.06, 2.6, 6, 0, 0, Math.PI / 2);    // circle (side)
  box(P.decal, 1.9, 1.9, 0.08, HX - 0.06, 2.6, -6, 0, false);                 // square (side)

  // yard lines: start, finish (double white + red), sidelines
  box(P.decal, HX * 2 - 2, 0.06, 0.7, 0, 0.03, -20, 0, false);
  box(P.decal, HX * 2 - 2, 0.06, 0.7, 0, 0.03, 15.2, 0, false);
  box(P.lineRed, HX * 2 - 2, 0.06, 0.5, 0, 0.03, 16.0, 0, false);
  box(P.decal, 0.5, 0.06, 36, -HX + 1.2, 0.03, -2, 0, false);
  box(P.decal, 0.5, 0.06, 36, HX - 1.2, 0.03, -2, 0, false);

  // a few low pink barriers as light cover
  box(P.barrier, 3, 0.9, 0.5, -7, 0.45, -6);
  box(P.barrier, 3, 0.9, 0.5, 7, 0.45, 2);
  box(P.barrier, 0.5, 0.9, 3, 5, 0.45, -12);
  box(P.barrier, 0.5, 0.9, 3, -5, 0.45, 8);

  // doll platform
  box(P.platform, 12, 1, 8, 0, 0.5, 21, 0, false);
  // giant doll body (merged, static) — Young-hee style
  const dy = 1; // platform top
  box(P.skin, 0.5, 1.3, 0.5, -0.4, dy + 0.65, 21);       // legs
  box(P.skin, 0.5, 1.3, 0.5, 0.4, dy + 0.65, 21);
  box(P.dress, 0.9, 0.5, 0.7, -0.4, dy + 1.55, 21, 0, false); // shoes hint
  box(P.dress, 0.9, 0.5, 0.7, 0.4, dy + 1.55, 21, 0, false);
  { // dress: tapered cylinder, orange
    _e.set(0, 0, 0); _q.setFromEuler(_e); _p.set(0, dy + 2.9, 21); _s.set(1, 1, 1);
    _m4.compose(_p, _q, _s);
    pushGeo(P.dress, new THREE.CylinderGeometry(0.85, 1.55, 2.3, 10).applyMatrix4(_m4));
  }
  box(P.dress, 1.25, 0.9, 0.8, 0, dy + 4.3, 21, 0, false);   // torso
  box(P.skin, 0.32, 1.6, 0.32, -0.95, dy + 4.1, 21, 0, false); // arms
  box(P.skin, 0.32, 1.6, 0.32, 0.95, dy + 4.1, 21, 0, false);
  // tree beside the doll
  { _e.set(0, 0, 0); _q.setFromEuler(_e); _p.set(7.5, 1.5, 21); _s.set(1, 1, 1);
    _m4.compose(_p, _q, _s);
    pushGeo(P.trunk, new THREE.CylinderGeometry(0.35, 0.5, 3, 8).applyMatrix4(_m4));
    const blobs = [[7.5, 3.8, 21, 1.7], [6.4, 3.1, 20.4, 1.2], [8.6, 3.1, 21.6, 1.2]];
    for (const [bx, by, bz, br] of blobs) {
      _p.set(bx, by, bz); _s.set(br, br, br); _m4.compose(_p, _q, _s);
      pushGeo(P.leaf, new THREE.SphereGeometry(1, 8, 6).applyMatrix4(_m4));
    }
  }
  // doll head (separate group — rotates; eyes swap color, NO extra lights)
  const headG = new THREE.Group();
  headG.position.set(0, dy + 5.35, 21);
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0x37d67a });
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.55, 12, 10), P.skin);
  headG.add(skull);
  const hairBack = new THREE.Mesh(GEO.box, P.hair);
  hairBack.scale.set(1.25, 1.05, 0.75); hairBack.position.set(0, 0.18, -0.28); headG.add(hairBack);
  const fringe = new THREE.Mesh(GEO.box, P.hair);
  fringe.scale.set(1.05, 0.32, 0.2); fringe.position.set(0, 0.42, 0.42); headG.add(fringe);
  const bunL = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 6), P.hair);
  bunL.position.set(-0.62, 0.35, -0.1); headG.add(bunL);
  const bunR = bunL.clone(); bunR.position.x = 0.62; headG.add(bunR);
  const eyeGeo = new THREE.BoxGeometry(0.16, 0.2, 0.06);
  const eyeL = new THREE.Mesh(eyeGeo, eyeMat); eyeL.position.set(-0.2, 0.05, 0.48); headG.add(eyeL);
  const eyeR = new THREE.Mesh(eyeGeo, eyeMat); eyeR.position.set(0.2, 0.05, 0.48); headG.add(eyeR);
  const eyeAnchor = new THREE.Object3D(); eyeAnchor.position.set(0, 0.05, 0.5); headG.add(eyeAnchor);
  headG.rotation.y = 0; // 0 = facing the wall (+z, away from players); PI = facing players
  ctx.group.add(headG);
  ctx.doll = { head: headG, eyeMat, eyeAnchor };

  ctx.sky = makeSky('#2f7fd0', '#8fc3f2', '#d8ecff', 0xfff6d8, 12, new THREE.Vector3(-0.45, 0.68, 0.3));
  ctx.spawns = [new THREE.Vector3(0, 0, -20), new THREE.Vector3(-8, 0, -20), new THREE.Vector3(8, 0, -20)];
  ctx.bounds = { hx: 16, hz: 24 };
  ctx.fogColor = 0xcfe0f2;
  ctx.hemiSky = 0xcfe4ff; ctx.hemiGround = 0x9a8a6a; ctx.hemiInt = 1.25;
  ctx.sunColor = 0xfff6e0; ctx.sunInt = 1.6; ctx.sunPos = [-50, 80, 30];
  finalizeMap(ctx);
}

/* ---- MAP 3: TIDE DOCK — container port at golden hour ---- */
function buildHarbor() {
  const ctx = newCtx('harbor');
  const P = {
    floor: lam(0x8a8578), water: lam(0x2e6f9e, 0x0a2a3a, 0.6),
    stripe: lam(0xff6b35, 0x903000, 0.7),
    contR: lam(0x8a3b22), contB: lam(0x2e5a7a), contG: lam(0x3f6b4f), contY: lam(0xb98a2e),
    crane: lam(0x3a3f45), cab: lam(0x22262b),
    crate: lam(0x7a6248), barrel: lam(0x5a6a7a),
  };
  const HALF = 26;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(HALF * 2 + 10, HALF * 2 + 60), P.floor);
  floor.rotation.x = -Math.PI / 2; floor.position.x = -10; floor.receiveShadow = true;
  ctx.group.add(floor);
  // water strip along the east edge
  const water = new THREE.Mesh(new THREE.PlaneGeometry(40, HALF * 2 + 60), P.water);
  water.rotation.x = -Math.PI / 2; water.position.set(HALF + 21, -0.6, 0);
  ctx.group.add(water);
  box(P.stripe, 1.2, 0.08, HALF * 2 + 8, HALF - 0.6, 0.04, 0, 0, false); // dock edge stripe

  // container stacks (merged)
  const contCols = [P.contR, P.contB, P.contG, P.contY];
  const stacks = [
    [-18, -14, 0.1, 2], [-11, -14, -0.06, 1], [-18, -8, 0.05, 1],
    [8, -18, 0.12, 2], [15, -14, -0.1, 1], [2, -10, 0.04, 1],
    [-20, 8, -0.08, 2], [-12, 12, 0.06, 1], [-4, 16, -0.04, 2],
    [10, 10, 0.1, 1], [18, 4, -0.12, 2], [4, 2, 0.02, 1],
    [-8, -2, 0.08, 1], [14, 20, -0.06, 1],
  ];
  stacks.forEach(([x, z, ry, h], i) => {
    const m = contCols[i % 4];
    for (let k = 0; k < h; k++) box(m, 6, 2.6, 2.4, x, 1.3 + k * 2.6, z, ry);
    box(P.stripe, 0.25, 2.2, 0.25, x + Math.cos(ry) * 2.9, 1.2 + (h - 1) * 2.6, z - Math.sin(ry) * 2.9, 0, false);
  });
  // two gantry cranes
  const crane = (x, z) => {
    for (const [lx, lz] of [[-5, -3], [5, -3], [-5, 3], [5, 3]])
      box(P.crane, 1.2, 13, 1.2, x + lx, 6.5, z + lz);
    box(P.crane, 13, 1.6, 8.4, x, 13.6, z, 0, false);
    box(P.cab, 2.4, 2.2, 2.4, x + 3, 11.8, z + 2, 0, false);
    box(P.stripe, 13, 0.3, 0.4, x, 12.7, z + 4.1, 0, false);
    box(P.crane, 0.3, 5, 0.3, x - 2, 10, z, 0, false);       // cable
    box(P.contY, 1.6, 1.2, 1.2, x - 2, 7, z, 0, false);      // hanging container
  };
  crane(-6, -20); crane(10, 20);
  // crates + barrels
  const crates = [[-14, 2, 2.4], [0, 14, 2.2], [20, -6, 2.6], [-2, -20, 2.2], [6, 8, 2.0]];
  crates.forEach(([x, z, s], i) => box(i % 2 ? P.crate : P.contG, s, s, s, x, s / 2, z, i * 0.3));
  [[-22, -4], [22, 12], [-10, 20], [12, -8]].forEach(([x, z], i) =>
    barrelAt(i % 2 ? P.barrel : P.contB, x, z));

  ctx.sky = makeSky('#2e5fc0', '#9fc0ee', '#ffc37a', 0xffd9a0, 16, new THREE.Vector3(-0.72, 0.2, 0.25));
  ctx.spawns = [new THREE.Vector3(-20, 0, -20), new THREE.Vector3(20, 0, 18), new THREE.Vector3(-20, 0, 18)];
  ctx.bounds = { hx: 26, hz: 26 };
  ctx.fogColor = 0xf0c49a;
  ctx.hemiSky = 0xffd9b0; ctx.hemiGround = 0x5a5a6a; ctx.hemiInt = 1.1;
  ctx.sunColor = 0xffc37a; ctx.sunInt = 1.7; ctx.sunPos = [-80, 26, 28];
  finalizeMap(ctx);
}

buildSector04();
buildDollsYard();
buildHarbor();

export function setMap(key) {
  for (const k in mapCtxs) { mapCtxs[k].group.visible = false; mapCtxs[k].sky.visible = false; }
  cur = mapCtxs[key];
  cur.group.visible = true; cur.sky.visible = true;
  obstacles = cur.obstacles; ramps = cur.ramps; losMeshes = cur.losMeshes;
  SPAWNS = cur.spawns;
  scene.fog.color.setHex(cur.fogColor);
  scene.background.setHex(cur.fogColor);
  hemi.color.setHex(cur.hemiSky); hemi.groundColor.setHex(cur.hemiGround); hemi.intensity = cur.hemiInt;
  sun.color.setHex(cur.sunColor); sun.intensity = cur.sunInt;
  sun.position.set(cur.sunPos[0], cur.sunPos[1], cur.sunPos[2]);
}
setMap(mapKey);

/* ================= QUALITY ================= */
let particleCap = 60;
export function applyQuality() {
  const low = Quality.level === 'low';
  renderer.setPixelRatio(low ? Math.min(window.devicePixelRatio || 1, 1.25)
                             : Math.min(window.devicePixelRatio || 1, 2));
  const shadows = !low;
  if (renderer.shadowMap.enabled !== shadows) {
    renderer.shadowMap.enabled = shadows;
    scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
  }
  sun.castShadow = shadows;
  scene.fog.near = low ? 25 : 34;
  scene.fog.far = low ? 70 : 110;
  camera.far = low ? 170 : 260;
  camera.updateProjectionMatrix();
  particleCap = low ? 30 : 60;
  document.querySelectorAll('.qbtn').forEach((b) =>
    b.classList.toggle('selected', b.dataset.q === Quality.current));
  document.querySelectorAll('#set-quality .segbtn').forEach((b) =>
    b.classList.toggle('selected', b.dataset.q === Quality.current));
}
export function setQuality(q) {
  Quality.current = q;
  localStorage.setItem('blaze_quality', q);
  applyQuality();
}
applyQuality();

/* ================= LOW-POLY SOLDIER (shared geos + mats, ~10 draw calls each) ================= */
const _c = new THREE.Color();
function tintGeo(geo, hex) {
  _c.setHex(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = _c.r; arr[i * 3 + 1] = _c.g; arr[i * 3 + 2] = _c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}
function partGeo(sx, sy, sz, x, y, z, hex, rx = 0) {
  _e.set(rx, 0, 0); _q.setFromEuler(_e);
  _p.set(x, y, z); _s.set(sx, sy, sz);
  _m4.compose(_p, _q, _s);
  return tintGeo(GEO.box.clone().applyMatrix4(_m4), hex);
}
const GUN_DARK = 0x232428, GUN_EMBER = 0xff6b35;
const gunGeos = {};
function getGunGeo(wkey) {
  if (gunGeos[wkey]) return gunGeos[wkey];
  const parts = [];
  if (wkey === 'rifle') {
    parts.push(partGeo(0.09, 0.13, 0.62, 0, 0, 0, GUN_DARK));
    parts.push(partGeo(0.05, 0.05, 0.34, 0, 0.04, -0.45, GUN_DARK));
    parts.push(partGeo(0.07, 0.2, 0.1, 0, -0.14, 0.08, GUN_DARK, 0.35));
    parts.push(partGeo(0.03, 0.07, 0.06, 0, 0.1, -0.05, GUN_DARK));
    parts.push(partGeo(0.095, 0.018, 0.22, 0, -0.015, -0.08, GUN_EMBER));
  } else if (wkey === 'smg') {
    parts.push(partGeo(0.08, 0.12, 0.42, 0, 0, 0, GUN_DARK));
    parts.push(partGeo(0.045, 0.045, 0.22, 0, 0.03, -0.3, GUN_DARK));
    parts.push(partGeo(0.06, 0.18, 0.08, 0, -0.13, 0.05, GUN_DARK, 0.3));
    parts.push(partGeo(0.09, 0.018, 0.18, 0, -0.015, -0.05, GUN_EMBER));
  } else {
    parts.push(partGeo(0.08, 0.12, 0.85, 0, 0, -0.1, GUN_DARK));
    parts.push(partGeo(0.04, 0.04, 0.5, 0, 0.03, -0.7, GUN_DARK));
    parts.push(partGeo(0.05, 0.09, 0.14, 0, 0.09, -0.25, GUN_DARK));
    parts.push(partGeo(0.07, 0.16, 0.09, 0, -0.12, 0.15, GUN_DARK));
    parts.push(partGeo(0.085, 0.018, 0.3, 0, -0.015, -0.2, GUN_EMBER));
  }
  const g = mergeGeometries(parts, false);
  gunGeos[wkey] = g;
  return g;
}
const GUN_TIP_Z = { rifle: -0.62, smg: -0.42, sniper: -0.95 };

/* ================= FPS VIEWMODEL (first-person gun, bottom-right) ================= */
export const vmGroup = new THREE.Group();
camera.add(vmGroup);
export const vmState = { gun: null, tip: null, flash: null, kick: 0, adsK: 0 };
export function buildViewmodel(wkey) {
  while (vmGroup.children.length) vmGroup.remove(vmGroup.children[0]);
  vmState.gun = new THREE.Mesh(getGunGeo(wkey), MAT.gunVC);
  vmState.gun.frustumCulled = false;
  vmState.gun.position.set(0.27, -0.26, -0.5);
  vmGroup.add(vmState.gun);
  vmState.tip = new THREE.Object3D();
  vmState.tip.position.set(0, 0.03, GUN_TIP_Z[wkey]);
  vmState.gun.add(vmState.tip);
  vmState.flash = makeFlash(0.3);
  vmState.flash.position.copy(vmState.tip.position);
  vmState.flash.visible = false;
  vmState.gun.add(vmState.flash);
  vmState.kick = 0; vmState.adsK = 0;
}

export function makeNameLabel(text, color = '#ffe9c9') {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.font = '700 34px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.shadowColor = 'rgba(0,0,0,0.9)'; g.shadowBlur = 8; g.fillStyle = color;
  g.fillText(text.slice(0, 16), 128, 32);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  spr.scale.set(2.4, 0.6, 1); spr.position.y = 2.3;
  return spr;
}

// bot uniform: 'combat' on sector04/harbor, 'tracksuit' (squid green) on doll's yard
export let botUniform = 'combat';
export function setBotUniform(u) { botUniform = u; }
export function setMapKey(k) { mapKey = k; }
export function makeSoldier(name, team /* 'player' | 'bot' */, wkey) {
  let T;
  if (team === 'player') T = { torso: MAT.pTorso, limb: MAT.pLimb, head: MAT.pHead, visor: MAT.pVisor };
  else if (botUniform === 'tracksuit') T = { torso: MAT.tTorso, limb: MAT.tLimb, head: MAT.bHead, visor: MAT.tVisor };
  else T = { torso: MAT.bTorso, limb: MAT.bLimb, head: MAT.bHead, visor: MAT.bVisor };
  const group = new THREE.Group();
  const parts = {};
  const bx = (mat, sx, sy, sz, x, y, z, parent = group) => {
    const m = new THREE.Mesh(GEO.box, mat);
    m.scale.set(sx, sy, sz); m.position.set(x, y, z); m.castShadow = true;
    parent.add(m); return m;
  };
  bx(T.torso, 0.62, 0.72, 0.38, 0, 1.18, 0);
  bx(MAT.ember, 0.2, 0.5, 0.03, 0, 1.2, 0.21);
  const headG = new THREE.Group(); headG.position.set(0, 1.72, 0); group.add(headG);
  const skull = new THREE.Mesh(GEO.head, T.head); skull.position.y = 0.12; skull.castShadow = true; headG.add(skull);
  const visor = new THREE.Mesh(GEO.box, T.visor); visor.scale.set(0.3, 0.09, 0.08); visor.position.set(0, 0.13, 0.17); headG.add(visor);
  parts.head = headG;
  const mkArm = (side) => {
    const sh = new THREE.Group(); sh.position.set(0.4 * side, 1.48, 0); group.add(sh);
    bx(T.limb, 0.17, 0.78, 0.17, 0, -0.36, 0, sh);
    return sh;
  };
  parts.armL = mkArm(-1); parts.armR = mkArm(1);
  const gun = new THREE.Mesh(getGunGeo(wkey), MAT.gunVC);
  gun.position.set(0.22, 1.28, 0.42); gun.castShadow = true;
  group.add(gun);
  const tip = new THREE.Object3D();
  tip.position.set(0.22, 1.32, 0.42 + GUN_TIP_Z[wkey]);
  group.add(tip);
  parts.gunTip = tip;
  const mkLeg = (side) => {
    const hip = new THREE.Group(); hip.position.set(0.17 * side, 0.86, 0); group.add(hip);
    bx(T.limb, 0.2, 0.84, 0.2, 0, -0.42, 0, hip);
    return hip;
  };
  parts.legL = mkLeg(-1); parts.legR = mkLeg(1);
  const label = makeNameLabel(name, team === 'player' ? '#ffe9c9' : '#ff8a8a');
  group.add(label);
  parts.label = label;
  const hitbox = new THREE.Mesh(GEO.box, MAT.hit);
  hitbox.scale.set(1.0, 2.0, 1.0); hitbox.position.y = 1.0;
  group.add(hitbox);

  let walkPhase = 0;
  return {
    group, hitbox, parts,
    setWalk(dt, speed01) {
      walkPhase += dt * (4 + speed01 * 9);
      const a = Math.sin(walkPhase) * 0.6 * speed01;
      parts.legL.rotation.x = a; parts.legR.rotation.x = -a;
      parts.armL.rotation.x = -a * 0.7; parts.armR.rotation.x = a * 0.7;
    },
    idle(dt, t) {
      parts.armL.rotation.x *= 0.9; parts.armR.rotation.x *= 0.9;
      parts.legL.rotation.x *= 0.9; parts.legR.rotation.x *= 0.9;
      headG.rotation.y = Math.sin(t * 0.7) * 0.25;
    },
  };
}

/* ---- muzzle flash sprite ---- */
const flashTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  gr.addColorStop(0, 'rgba(255,240,200,1)');
  gr.addColorStop(0.4, 'rgba(255,160,60,0.9)');
  gr.addColorStop(1, 'rgba(255,80,20,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
})();
export function makeFlash(scale = 0.5) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  s.scale.set(scale, scale, 1); s.visible = false;
  return s;
}

/* ---- tracers: pooled lines, preallocated position buffers (no per-shot allocation) ---- */
export const tracers = [];
for (let i = 0; i < 10; i++) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffc37a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending }));
  line.visible = false; line.frustumCulled = false;
  scene.add(line);
  tracers.push({ line, until: 0 });
}
let tracerIdx = 0;
const _tv = [new THREE.Vector3(), new THREE.Vector3()];
export function spawnTracer(from, to, color = 0xffc37a) {
  const t = tracers[tracerIdx++ % tracers.length];
  const a = t.line.geometry.attributes.position;
  a.setXYZ(0, from.x, from.y, from.z);
  a.setXYZ(1, to.x, to.y, to.z);
  a.needsUpdate = true;
  t.line.material.color.setHex(color);
  t.line.visible = true; t.line.material.opacity = 0.9;
  t.until = performance.now() + 70;
}

/* ---- particle bursts: fixed pool of 60 sprites, capped by quality, zero per-frame alloc ---- */
const PARTICLE_POOL = 60;
const particles = [];
for (let i = 0; i < PARTICLE_POOL; i++) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xff8a3d }));
  s.visible = false; scene.add(s);
  particles.push({ s, vel: new THREE.Vector3(), until: 0 });
}
let partIdx = 0;
function activeParticles() {
  let n = 0;
  for (const p of particles) if (p.s.visible) n++;
  return n;
}
export function burst(pos, n = 10, color = 0xff8a3d, speed = 4) {
  if (activeParticles() >= particleCap) return;
  n = Math.min(n, particleCap - activeParticles());
  for (let i = 0; i < n; i++) {
    const p = particles[partIdx++ % particles.length];
    p.s.visible = true;
    p.s.material.color.setHex(color);
    p.s.position.copy(pos);
    p.s.scale.setScalar(rand(0.15, 0.4));
    p.vel.set(rand(-1, 1), rand(0.2, 1.4), rand(-1, 1)).normalize().multiplyScalar(rand(speed * 0.4, speed));
    p.until = performance.now() + rand(300, 700);
  }
}
export function updateParticles(now, dt) {
  for (const p of particles) {
    if (!p.s.visible) continue;
    if (now > p.until) { p.s.visible = false; continue; }
    p.vel.y -= 9 * dt;
    p.s.position.addScaledVector(p.vel, dt);
    p.s.material.opacity = clamp((p.until - now) / 400, 0, 1);
  }
}

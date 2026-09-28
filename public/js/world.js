// Blaze world — builds the industrial arena, enemy soldier figures,
// floating username labels and solo-mode practice dummies.
import * as THREE from 'three';

export const ARENA_HALF = 28; // must match server ARENA_BOUND

// Reused materials/geometries keep mobile draw cost low.
const MAT = {
  floor: new THREE.MeshStandardMaterial({ color: 0x1b1b1f, roughness: 0.95 }),
  wall: new THREE.MeshStandardMaterial({ color: 0x2a2a30, roughness: 0.9 }),
  wallStripe: new THREE.MeshStandardMaterial({ color: 0xff6b35, roughness: 0.7, emissive: 0x903000, emissiveIntensity: 0.6 }),
  crate: new THREE.MeshStandardMaterial({ color: 0x4a3b28, roughness: 0.85 }),
  crateDark: new THREE.MeshStandardMaterial({ color: 0x35301f, roughness: 0.85 }),
  barrel: new THREE.MeshStandardMaterial({ color: 0xb34700, roughness: 0.6, metalness: 0.4 }),
  barrelBlue: new THREE.MeshStandardMaterial({ color: 0x1f4e79, roughness: 0.6, metalness: 0.4 }),
  pillar: new THREE.MeshStandardMaterial({ color: 0x232327, roughness: 0.8, metalness: 0.3 }),
  lamp: new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xffd9a0, emissiveIntensity: 2.2 }),
  enemyBody: new THREE.MeshStandardMaterial({ color: 0xc22a1c, roughness: 0.7 }),
  enemyHead: new THREE.MeshStandardMaterial({ color: 0xe8b58a, roughness: 0.7 }),
  enemyGun: new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.5, metalness: 0.5 }),
  dummyBody: new THREE.MeshStandardMaterial({ color: 0xff8c1a, roughness: 0.7, emissive: 0x552200, emissiveIntensity: 0.5 }),
};

const GEO = {
  box: new THREE.BoxGeometry(1, 1, 1),
  barrel: new THREE.CylinderGeometry(0.55, 0.55, 1.4, 12),
  capsule: new THREE.CapsuleGeometry(0.34, 0.85, 6, 12),
  head: new THREE.SphereGeometry(0.24, 14, 12),
};

/** Build the arena. Returns { obstacles: THREE.Box3[], hitMeshes: [] } for collision/raycast. */
export function buildArena(scene) {
  const obstacles = [];

  // Fog + lights: dusk-industrial mood, cheap to render.
  scene.fog = new THREE.Fog(0x0a0a0c, 30, 95);
  scene.add(new THREE.HemisphereLight(0x8a7a6a, 0x0b0b0d, 0.85));
  const sun = new THREE.DirectionalLight(0xffb37a, 1.1);
  sun.position.set(24, 38, 12);
  scene.add(sun);

  // Floor + grid.
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(ARENA_HALF * 2 + 8, ARENA_HALF * 2 + 8), MAT.floor);
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  const grid = new THREE.GridHelper(ARENA_HALF * 2, 28, 0x3a3a42, 0x242429);
  grid.position.y = 0.02;
  scene.add(grid);

  const addBox = (mat, sx, sy, sz, x, y, z, ry = 0, obstacle = true) => {
    const m = new THREE.Mesh(GEO.box, mat);
    m.scale.set(sx, sy, sz);
    m.position.set(x, y, z);
    m.rotation.y = ry;
    scene.add(m);
    if (obstacle) {
      m.updateMatrixWorld(true);
      obstacles.push(new THREE.Box3().setFromObject(m));
    }
    return m;
  };

  // Perimeter walls with hazard stripes.
  const W = ARENA_HALF + 2;
  for (const [x, z, w, d] of [[0, -W, W * 2, 1], [0, W, W * 2, 1], [-W, 0, 1, W * 2], [W, 0, 1, W * 2]]) {
    addBox(MAT.wall, w, 4, d, x, 2, z, 0, false);
    addBox(MAT.wallStripe, w === 1 ? 1.1 : w, 0.5, d === 1 ? 1.1 : d, x, 0.6, z, 0, false);
  }

  // Central structure: two pillars + crossbeam, crates around.
  addBox(MAT.pillar, 1.6, 7, 1.6, -4, 3.5, -4);
  addBox(MAT.pillar, 1.6, 7, 1.6, 4, 3.5, -4);
  addBox(MAT.pillar, 11, 1.2, 1.8, 0, 7.2, -4);
  addBox(MAT.pillar, 1.6, 7, 1.6, -4, 3.5, 6);
  addBox(MAT.pillar, 1.6, 7, 1.6, 4, 3.5, 6);

  // Crate clusters (cover).
  const crates = [
    [-12, -12, 2.4], [-9.2, -12, 2.4], [-10.6, -9.6, 2.4], [-10.6, -12, 4.6, true],
    [12, 10, 2.4], [14.6, 10.5, 2.4], [13.2, 12.8, 2.4],
    [-14, 8, 3], [10, -14, 3], [0, 14, 2.4], [-2.6, 14, 2.4],
    [16, -6, 2.2], [-16, -2, 2.2], [6, 0, 2.2], [-6, 2, 2.2],
  ];
  for (const [x, z, s, stacked] of crates) {
    addBox(Math.random() > 0.5 ? MAT.crate : MAT.crateDark, s, s, s, x, s / 2, z, (x * 7 + z * 13) % 3 * 0.2);
    if (stacked) addBox(MAT.crateDark, s * 0.8, s * 0.8, s * 0.8, x, s + s * 0.4, z, 0.35);
  }

  // Barrels.
  const barrelSpots = [[-18, -18], [-17, -16.6], [18, 18], [16.8, 18], [18, -10], [-18, 12], [8, 18], [-8, -18]];
  barrelSpots.forEach(([x, z], i) => {
    const m = new THREE.Mesh(GEO.barrel, i % 2 ? MAT.barrelBlue : MAT.barrel);
    m.position.set(x, 0.7, z);
    scene.add(m);
    m.updateMatrixWorld(true);
    obstacles.push(new THREE.Box3().setFromObject(m));
  });

  // Overhead lamps (emissive boxes + a few real point lights).
  const lampAt = (x, z) => {
    const lamp = new THREE.Mesh(GEO.box, MAT.lamp);
    lamp.scale.set(2.2, 0.25, 2.2);
    lamp.position.set(x, 8.6, z);
    scene.add(lamp);
    const pl = new THREE.PointLight(0xffc98a, 18, 26, 1.8);
    pl.position.set(x, 7.8, z);
    scene.add(pl);
  };
  lampAt(0, -4); lampAt(-12, 8); lampAt(12, -8); lampAt(0, 16);

  return { obstacles };
}

/** Floating username label (canvas sprite), always faces camera. */
export function makeNameLabel(text) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.font = '700 34px system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.shadowColor = 'rgba(0,0,0,0.9)'; g.shadowBlur = 8;
  g.fillStyle = '#ffd9c9';
  g.fillText(text.slice(0, 16), 128, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  spr.scale.set(2.4, 0.6, 1);
  spr.position.y = 2.35;
  return spr;
}

/** Stylised low-poly enemy soldier. Returns { group, hitbox, label }. */
export function makeSoldier(username) {
  const group = new THREE.Group();

  const body = new THREE.Mesh(GEO.capsule, MAT.enemyBody);
  body.position.y = 1.05;
  group.add(body);

  const head = new THREE.Mesh(GEO.head, MAT.enemyHead);
  head.position.y = 1.95;
  group.add(head);

  // Visor stripe — reads as hostile at a glance.
  const visor = new THREE.Mesh(GEO.box, new THREE.MeshStandardMaterial({ color: 0x0a0a0c, emissive: 0xff2d1e, emissiveIntensity: 1.4 }));
  visor.scale.set(0.34, 0.09, 0.1);
  visor.position.set(0, 1.97, 0.2);
  group.add(visor);

  const gun = new THREE.Mesh(GEO.box, MAT.enemyGun);
  gun.scale.set(0.12, 0.12, 0.9);
  gun.position.set(0.28, 1.25, 0.4);
  group.add(gun);

  const label = makeNameLabel(username);
  group.add(label);

  // Invisible hitbox (raycaster still intersects invisible meshes).
  const hitbox = new THREE.Mesh(GEO.box, new THREE.MeshBasicMaterial({ visible: false }));
  hitbox.scale.set(1.0, 2.1, 1.0);
  hitbox.position.y = 1.05;
  group.add(hitbox);

  return { group, hitbox, label };
}

/** Solo-mode practice dummy — orange range target on a stand. */
export function makeDummy() {
  const group = new THREE.Group();
  const stand = new THREE.Mesh(GEO.box, MAT.pillar);
  stand.scale.set(0.18, 1.1, 0.18);
  stand.position.y = 0.55;
  group.add(stand);
  const torso = new THREE.Mesh(GEO.capsule, MAT.dummyBody);
  torso.scale.set(1, 0.8, 1);
  torso.position.y = 1.65;
  group.add(torso);
  const head = new THREE.Mesh(GEO.head, MAT.dummyBody);
  head.position.y = 2.35;
  group.add(head);
  const hitbox = new THREE.Mesh(GEO.box, new THREE.MeshBasicMaterial({ visible: false }));
  hitbox.scale.set(1.0, 2.6, 1.0);
  hitbox.position.y = 1.5;
  group.add(hitbox);
  return { group, hitbox };
}

export const SPAWN_POINTS = [
  new THREE.Vector3(-20, 0, -20),
  new THREE.Vector3(20, 0, -20),
  new THREE.Vector3(-20, 0, 20),
  new THREE.Vector3(20, 0, 20),
];

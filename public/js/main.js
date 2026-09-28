// Blaze client — game orchestration: menus, net, three.js scene, input,
// shooting, enemies, dummies (solo), HUD and match flow.
import * as THREE from 'three';
import { AudioSynth } from './audio.js';
import { Net } from './net.js';
import { buildArena, makeSoldier, makeDummy, ARENA_HALF } from './world.js';

/* ================= config ================= */
const WEAPONS = {
  rifle:  { name: 'Assault Rifle', damage: 25, interval: 0.115, mag: 30, reload: 1.8, auto: true,  spread: 0.014, range: 90, color: 0x3a3f45 },
  smg:    { name: 'SMG',           damage: 14, interval: 0.072, mag: 40, reload: 1.5, auto: true,  spread: 0.032, range: 60, color: 0x4a3b28 },
  sniper: { name: 'Sniper',        damage: 90, interval: 0.95,  mag: 5,  reload: 2.6, auto: false, spread: 0.001, range: 140, color: 0x1f2a1f, scope: true },
};
const EYE = 1.7;
const MOVE_SPEED = 8;
const PLAYER_RADIUS = 0.45;
const STATE_HZ = 20;
const IS_TOUCH = window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

/* ================= dom ================= */
const $ = (id) => document.getElementById(id);
const screens = { home: $('screen-home'), loadout: $('screen-loadout'), game: $('screen-game'), end: $('screen-end') };
function show(name) { for (const k in screens) screens[k].classList.toggle('active', k === name); }

// Stamp the logo template everywhere.
for (const id of ['home-logo', 'loadout-logo', 'end-logo']) {
  $(id).appendChild($('blaze-logo-tpl').content.cloneNode(true));
}

/* ================= state ================= */
const audio = new AudioSynth();
const net = new Net();
let mode = 'home';           // home | loadout | connecting | playing | ended
let playerId = null, roomCode = null, username = '', loadoutKey = 'rifle';
let pendingRoom = '';        // '' = create, else join code
let alive = true, hp = 100, ammo = 30, reloading = false, reloadEnd = 0;
let yaw = 0, pitch = 0, aiming = false;
let endsAt = 0, matchOver = false;
let soloMode = false;
const enemies = new Map();   // id -> {group, hitbox, label, target:Vector3, ry, hp, alive, deadUntil}
const dummies = [];          // solo practice targets
const scores = new Map();    // id -> {username, kills, deaths}
let lastHurtAt = 0;

/* ================= three setup ================= */
const canvas = $('game-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a0c);
const camera = new THREE.PerspectiveCamera(75, 1, 0.05, 220);
camera.rotation.order = 'YXZ';
scene.add(camera);

const { obstacles } = buildArena(scene);
const playerPos = new THREE.Vector3(0, 0, -20);

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

/* ---- weapon viewmodel (boxes attached to camera) ---- */
const gunGroup = new THREE.Group();
{
  const mat = new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.45, metalness: 0.6 });
  const grip = new THREE.MeshStandardMaterial({ color: 0x17181b, roughness: 0.8 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.14, 0.62), mat);
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.34), mat);
  barrel.position.set(0, 0.045, -0.44);
  const gripM = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.2, 0.1), grip);
  gripM.position.set(0, -0.14, 0.08); gripM.rotation.x = 0.35;
  const sight = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.07, 0.06), grip);
  sight.position.set(0, 0.1, -0.05);
  const ember = new THREE.Mesh(new THREE.BoxGeometry(0.095, 0.02, 0.2),
    new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xff6b35, emissiveIntensity: 1.6 }));
  ember.position.set(0, -0.02, -0.1);
  gunGroup.add(body, barrel, gripM, sight, ember);
  gunGroup.position.set(0.32, -0.3, -0.55);
  gunGroup.rotation.y = 0.04;
  camera.add(gunGroup);
}
// Muzzle flash sprite.
const flashTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  grad.addColorStop(0, 'rgba(255,240,200,1)');
  grad.addColorStop(0.4, 'rgba(255,160,60,0.9)');
  grad.addColorStop(1, 'rgba(255,80,20,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
})();
const muzzleFlash = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
muzzleFlash.scale.set(0.42, 0.42, 1);
muzzleFlash.position.set(0, 0.045, -0.62);
muzzleFlash.visible = false;
gunGroup.add(muzzleFlash);

// Enemy muzzle flashes (small pool).
const enemyFlashes = [];
for (let i = 0; i < 4; i++) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  s.scale.set(0.5, 0.5, 1); s.visible = false;
  scene.add(s);
  enemyFlashes.push({ s, until: 0 });
}
let flashIdx = 0;
function enemyFlash(pos) {
  const f = enemyFlashes[flashIdx++ % enemyFlashes.length];
  f.s.position.copy(pos); f.s.position.y += 1.5;
  f.s.visible = true; f.until = performance.now() + 60;
}

// Tracers (short-lived lines, pooled).
const tracers = [];
for (let i = 0; i < 8; i++) {
  const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffc37a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending }));
  line.visible = false; line.frustumCulled = false;
  scene.add(line);
  tracers.push({ line, until: 0 });
}
let tracerIdx = 0;
function spawnTracer(from, to) {
  const t = tracers[tracerIdx++ % tracers.length];
  t.line.geometry.setFromPoints([from, to]);
  t.line.visible = true;
  t.line.material.opacity = 0.9;
  t.until = performance.now() + 70;
}

/* ================= audio unlock ================= */
function unlockAudio() { audio.ensure(); }
window.addEventListener('pointerdown', unlockAudio, { once: false });
window.addEventListener('touchstart', unlockAudio, { once: false, passive: true });

/* ================= menus ================= */
username = localStorage.getItem('blaze_username') || '';
$('username').value = username;
loadoutKey = localStorage.getItem('blaze_loadout') || 'rifle';

function validUsername(v) { return /^[A-Za-z0-9_]{1,16}$/.test(v); }

$('btn-create').onclick = () => {
  audio.ensure(); audio.uiClick();
  const v = $('username').value.trim();
  if (!validUsername(v)) { $('home-error').textContent = 'Callsign: 1-16 chars, letters/numbers/_'; return; }
  $('home-error').textContent = '';
  username = v; localStorage.setItem('blaze_username', v);
  pendingRoom = '';
  enterLoadout();
};
$('btn-join').onclick = () => {
  audio.ensure(); audio.uiClick();
  const v = $('username').value.trim();
  if (!validUsername(v)) { $('home-error').textContent = 'Callsign: 1-16 chars, letters/numbers/_'; return; }
  const code = $('room-code').value.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) { $('home-error').textContent = 'Room code is 6 characters'; return; }
  $('home-error').textContent = '';
  username = v; localStorage.setItem('blaze_username', v);
  pendingRoom = code;
  enterLoadout();
};

function enterLoadout() {
  mode = 'loadout';
  $('loadout-user').textContent = username;
  document.querySelectorAll('.weapon-card').forEach((c) =>
    c.classList.toggle('selected', c.dataset.weapon === loadoutKey));
  show('loadout');
}
document.querySelectorAll('.weapon-card').forEach((c) => {
  c.onclick = () => {
    audio.ensure(); audio.uiClick();
    loadoutKey = c.dataset.weapon;
    localStorage.setItem('blaze_loadout', loadoutKey);
    document.querySelectorAll('.weapon-card').forEach((x) => x.classList.toggle('selected', x === c));
  };
});
$('btn-loadout-back').onclick = () => { audio.uiClick(); mode = 'home'; show('home'); };

$('btn-start').onclick = async () => {
  audio.ensure(); audio.uiClick();
  $('loadout-error').textContent = '';
  // Landscape lock on phones (best-effort; overlay covers the rest).
  try {
    if (IS_TOUCH && screen.orientation && screen.orientation.lock) {
      await screen.orientation.lock('landscape');
    }
  } catch { /* not supported — rotate overlay handles it */ }
  startMatch();
};

$('btn-again').onclick = () => { audio.uiClick(); startMatch(true); };
$('btn-home').onclick = () => { audio.uiClick(); net.close(); mode = 'home'; show('home'); };

/* ================= rotate overlay ================= */
function updateRotateOverlay() {
  const portrait = window.innerHeight > window.innerWidth;
  $('rotate-overlay').classList.toggle('hidden', !(IS_TOUCH && portrait));
}
window.addEventListener('resize', updateRotateOverlay);
window.addEventListener('orientationchange', () => setTimeout(updateRotateOverlay, 200));
updateRotateOverlay();

/* ================= net wiring ================= */
net.on('joined', (m) => {
  playerId = m.playerId; roomCode = m.roomCode;
  $('room-code-hud').textContent = roomCode;
  endsAt = m.endsAt;
  playerPos.set(m.spawn[0], 0, m.spawn[2]);
  yaw = Math.atan2(-playerPos.x, -playerPos.z); // face arena centre
  pitch = 0;
  alive = true; hp = 100;
  ammo = WEAPONS[loadoutKey].mag; reloading = false;
  matchOver = false;
  scores.clear(); enemies.forEach((e) => scene.remove(e.group)); enemies.clear();
  clearDummies();
  $('connecting').classList.add('hidden');
  $('hud').classList.remove('hidden');
  $('death-overlay').classList.add('hidden');
  updateHealthHUD(); updateAmmoHUD();
  addFeed(`Room <b>${roomCode}</b> — good hunting, <span class="vk">${escapeHtml(username)}</span>`, true);
  setSolo(m.solo);
  mode = 'playing';
});

net.on('players', (m) => {
  for (const p of m.players) {
    if (p.id === playerId) continue;
    spawnEnemy(p);
    scores.set(p.id, { username: p.username, kills: p.kills || 0, deaths: p.deaths || 0 });
  }
});

net.on('player-joined', (m) => {
  spawnEnemy({ id: m.id, username: m.username, loadout: m.loadout, p: [0, 0, -24], ry: 0, hp: 100, alive: true });
  scores.set(m.id, { username: m.username, kills: 0, deaths: 0 });
  addFeed(`<span class="vk">${escapeHtml(m.username)}</span> joined the fight`, false);
});

net.on('player-left', (m) => {
  const e = enemies.get(m.id);
  if (e) { scene.remove(e.group); enemies.delete(m.id); }
  const s = scores.get(m.id);
  if (s) addFeed(`<span class="vv">${escapeHtml(s.username)}</span> left`, false);
  scores.delete(m.id);
});

net.on('player-state', (m) => {
  if (m.id === playerId) {
    if (m.hp < hp) { audio.hurt(); lastHurtAt = performance.now(); }
    hp = m.hp;
    updateHealthHUD();
    return;
  }
  const e = enemies.get(m.id);
  if (!e) return;
  e.target.set(m.p[0], 0, m.p[2]);
  e.ry = m.ry; e.hp = m.hp;
  if (!m.hp || m.hp <= 0) { /* death handled via killed */ }
});

net.on('shot', (m) => {
  const e = enemies.get(m.id);
  if (e) { enemyFlash(e.group.position); audio.distantShot(); }
});

net.on('killed', (m) => {
  addFeed(`<span class="vk">${escapeHtml(m.killerName)}</span> ⟂ <span class="vv">${escapeHtml(m.victimName)}</span>`,
    m.killer === playerId || m.victim === playerId);
  if (m.killer === playerId) { audio.kill(); }
  if (m.victim === playerId) {
    alive = false;
    audio.death();
    $('death-overlay').classList.remove('hidden');
  } else {
    const e = enemies.get(m.victim);
    if (e) { e.alive = false; e.group.visible = false; e.deadUntil = performance.now() + 3000; }
  }
});

net.on('respawn', (m) => {
  if (m.id === playerId) {
    playerPos.set(m.p[0], 0, m.p[2]);
    hp = 100; alive = true;
    ammo = WEAPONS[loadoutKey].mag; reloading = false;
    $('death-overlay').classList.add('hidden');
    updateHealthHUD(); updateAmmoHUD();
  } else {
    const e = enemies.get(m.id);
    if (e) {
      e.group.position.set(m.p[0], 0, m.p[2]);
      e.target.copy(e.group.position);
      e.group.visible = true; e.alive = true;
    }
  }
});

net.on('scoreboard', (m) => {
  for (const p of m.players) {
    const s = scores.get(p.id) || { username: p.username };
    s.kills = p.kills; s.deaths = p.deaths; s.username = p.username;
    scores.set(p.id, s);
  }
  renderScoreboard();
});

net.on('solo', (m) => setSolo(m.value));

net.on('error', (m) => {
  $('connecting').classList.add('hidden');
  const msg = m.message || 'Something went wrong';
  if (mode === 'connecting') {
    $('loadout-error').textContent = msg;
    mode = 'loadout'; show('loadout');
  } else {
    addFeed(`<span class="vv">${escapeHtml(msg)}</span>`, false);
  }
});

net.on('__close', () => {
  if (mode === 'playing' || mode === 'connecting') {
    $('connecting').classList.add('hidden');
    $('loadout-error').textContent = 'Disconnected from server';
    mode = 'loadout'; show('loadout');
    $('hud').classList.add('hidden');
  }
});

/* ================= enemies & dummies ================= */
function spawnEnemy(p) {
  if (enemies.has(p.id) || p.id === playerId) return;
  const { group, hitbox } = makeSoldier(p.username);
  hitbox.userData.playerId = p.id;
  group.position.set(p.p[0], 0, p.p[2]);
  group.visible = p.alive !== false;
  scene.add(group);
  enemies.set(p.id, {
    group, hitbox, target: group.position.clone(),
    ry: p.ry || 0, hp: p.hp ?? 100, alive: p.alive !== false, deadUntil: 0,
  });
}

function setSolo(v) {
  soloMode = v;
  if (v) spawnDummies();
  else clearDummies();
}

const DUMMY_SPOTS = [[-10, -6], [10, -8], [0, 8], [-14, 10], [14, 4]];
function spawnDummies() {
  clearDummies();
  DUMMY_SPOTS.forEach(([x, z], i) => {
    const { group, hitbox } = makeDummy();
    hitbox.userData.dummyId = 'd' + i;
    group.position.set(x, 0, z);
    scene.add(group);
    dummies.push({ id: 'd' + i, group, hitbox, hp: 100, alive: true, respawnAt: 0 });
  });
  addFeed('Solo mode — practice targets deployed', true);
}
function clearDummies() {
  for (const d of dummies) scene.remove(d.group);
  dummies.length = 0;
}

/* ================= input: desktop ================= */
const keys = {};
window.addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (mode !== 'playing') return;
  if (e.code === 'KeyR') startReload();
  if (e.code === 'Tab') { e.preventDefault(); $('scoreboard').classList.remove('hidden'); }
  if (e.code === 'KeyM') toggleMute();
});
window.addEventListener('keyup', (e) => {
  keys[e.code] = false;
  if (e.code === 'Tab') $('scoreboard').classList.add('hidden');
});
canvas.addEventListener('click', () => {
  if (mode === 'playing' && !IS_TOUCH && document.pointerLockElement !== canvas) {
    canvas.requestPointerLock();
  }
});
document.addEventListener('pointerlockchange', () => {
  $('lock-hint')?.classList.toggle('hidden', document.pointerLockElement === canvas || IS_TOUCH);
});
document.addEventListener('mousemove', (e) => {
  if (mode !== 'playing' || document.pointerLockElement !== canvas) return;
  const sens = aiming ? 0.0009 : 0.0021;
  yaw -= e.movementX * sens;
  pitch -= e.movementY * sens;
  pitch = Math.max(-1.45, Math.min(1.45, pitch));
});
canvas.addEventListener('mousedown', (e) => {
  if (mode !== 'playing' || document.pointerLockElement !== canvas) return;
  if (e.button === 0) { firing = true; tryFire(); }
  if (e.button === 2 && WEAPONS[loadoutKey].scope) aiming = true;
});
window.addEventListener('mouseup', (e) => {
  if (e.button === 0) firing = false;
  if (e.button === 2) aiming = false;
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
let firing = false;

/* ================= input: touch ================= */
const joy = { active: false, id: null, dx: 0, dy: 0 };
const look = { id: null, lx: 0, ly: 0 };
if (IS_TOUCH) $('touch-ui').classList.remove('hidden');

function touchPos(t) { return { x: t.clientX, y: t.clientY }; }

document.addEventListener('touchstart', (e) => {
  if (mode !== 'playing') return;
  for (const t of e.changedTouches) {
    const el = document.elementFromPoint(t.clientX, t.clientY);
    if (el && el.closest('#joystick')) {
      joy.active = true; joy.id = t.identifier; joy.dx = 0; joy.dy = 0;
      moveStick(0, 0);
    } else if (el && (el.closest('.touch-btn') || el.closest('#hud-top') || el.closest('#room-chip'))) {
      // buttons handle themselves
    } else if (t.clientX > window.innerWidth * 0.35 && look.id === null) {
      look.id = t.identifier; look.lx = t.clientX; look.ly = t.clientY;
    }
  }
}, { passive: true });

document.addEventListener('touchmove', (e) => {
  if (mode !== 'playing') return;
  for (const t of e.changedTouches) {
    if (t.identifier === joy.id) {
      const r = $('joystick').getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      let dx = (t.clientX - cx) / (r.width / 2), dy = (t.clientY - cy) / (r.height / 2);
      const m = Math.hypot(dx, dy);
      if (m > 1) { dx /= m; dy /= m; }
      joy.dx = dx; joy.dy = dy;
      moveStick(dx, dy);
      e.preventDefault();
    } else if (t.identifier === look.id) {
      const sens = aiming ? 0.0016 : 0.0042;
      yaw -= (t.clientX - look.lx) * sens;
      pitch -= (t.clientY - look.ly) * sens;
      pitch = Math.max(-1.45, Math.min(1.45, pitch));
      look.lx = t.clientX; look.ly = t.clientY;
      e.preventDefault();
    }
  }
}, { passive: false });

function touchEnd(e) {
  for (const t of e.changedTouches) {
    if (t.identifier === joy.id) { joy.active = false; joy.id = null; joy.dx = 0; joy.dy = 0; moveStick(0, 0); }
    if (t.identifier === look.id) look.id = null;
  }
}
document.addEventListener('touchend', touchEnd);
document.addEventListener('touchcancel', touchEnd);

function moveStick(dx, dy) {
  $('stick').style.transform = `translate(calc(-50% + ${dx * 34}px), calc(-50% + ${dy * 34}px))`;
}

$('btn-fire').addEventListener('touchstart', (e) => { e.preventDefault(); firing = true; tryFire(); }, { passive: false });
$('btn-fire').addEventListener('touchend', () => { firing = false; });
$('btn-reload-touch').addEventListener('touchstart', (e) => { e.preventDefault(); startReload(); }, { passive: false });
$('btn-aim').addEventListener('touchstart', (e) => {
  e.preventDefault();
  if (WEAPONS[loadoutKey].scope) aiming = !aiming;
}, { passive: false });

/* ================= HUD ================= */
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function updateHealthHUD() {
  $('health-bar').firstElementChild.style.width = Math.max(0, hp) + '%';
  $('health-bar').classList.toggle('low', hp <= 35);
  $('health-num').textContent = Math.max(0, Math.ceil(hp));
}
function updateAmmoHUD() {
  $('ammo').textContent = ammo;
  document.querySelector('#ammo-wrap .ammo-sub').textContent = '/ ' + WEAPONS[loadoutKey].mag;
  $('ammo-wrap').classList.toggle('reloading', reloading);
}
function addFeed(html, me) {
  const div = document.createElement('div');
  div.className = 'feed-item' + (me ? ' me' : '');
  div.innerHTML = html;
  const feed = $('killfeed');
  feed.prepend(div);
  while (feed.children.length > 5) feed.lastChild.remove();
  setTimeout(() => { div.style.transition = 'opacity .6s'; div.style.opacity = '0'; setTimeout(() => div.remove(), 650); }, 5200);
}
function renderScoreboard() {
  const rows = [...scores.entries()]
    .map(([id, s]) => ({ id, ...s }))
    .sort((a, b) => (b.kills - a.kills) || (a.deaths - b.deaths));
  const html = rows.map((r) =>
    `<tr class="${r.id === playerId ? 'me' : ''}"><td>${escapeHtml(r.username)}</td><td>${r.kills}</td><td>${r.deaths}</td></tr>`).join('');
  document.querySelector('#score-table tbody').innerHTML = html;
  document.querySelector('#end-table tbody').innerHTML = html;
}
$('btn-scoreboard').onclick = () => { audio.uiClick(); $('scoreboard').classList.toggle('hidden'); };
$('room-chip').onclick = async () => {
  if (!roomCode) return;
  try { await navigator.clipboard.writeText(roomCode); addFeed('Room code copied', true); }
  catch { addFeed(`Room code: <b>${roomCode}</b>`, true); }
};
function toggleMute() {
  audio.setMuted(!audio.muted);
  $('btn-mute').textContent = audio.muted ? '🔇' : '🔊';
}
$('btn-mute').onclick = () => { audio.ensure(); toggleMute(); };

/* ================= match flow ================= */
async function startMatch(rematch = false) {
  // pendingRoom '' = create; on rematch reuse the same code.
  const room = rematch && roomCode ? roomCode : pendingRoom;
  if (rematch) {
    try { net.leave(); } catch { /* noop */ }
    await new Promise((r) => setTimeout(r, 350)); // let the leave flush
  } else {
    show('game');
    $('connecting').classList.remove('hidden');
  }
  mode = 'connecting';
  if (!net.connected) {
    // Room/identity go in the WS URL query so the Workers backend can route
    // to the room's Durable Object; the join message stays authoritative.
    try { await net.connect(room, username, loadoutKey); }
    catch {
      $('connecting').classList.add('hidden');
      $('loadout-error').textContent = 'Could not reach server';
      mode = 'loadout'; show('loadout');
      return;
    }
  }
  if (!rematch) { show('game'); $('connecting').classList.remove('hidden'); }
  net.join(room, username, loadoutKey);
}

function endMatch() {
  if (matchOver) return;
  matchOver = true;
  mode = 'ended';
  firing = false;
  renderScoreboard();
  // Winner banner.
  const rows = [...scores.values()].sort((a, b) => (b.kills - a.kills) || (a.deaths - b.deaths));
  $('end-title').textContent = rows.length && rows[0].username === username ? 'VICTORY' : 'TIME UP';
  document.exitPointerLock?.();
  show('end');
  try { net.leave(); } catch { /* noop */ }
}

/* ================= shooting ================= */
const raycaster = new THREE.Raycaster();
const aimDir = new THREE.Vector3();
let lastShotAt = 0;

function tryFire() {
  if (mode !== 'playing' || !alive || matchOver) return;
  const w = WEAPONS[loadoutKey];
  const now = performance.now() / 1000;
  if (reloading || now - lastShotAt < w.interval) return;
  if (ammo <= 0) { audio.emptyClick(); startReload(); return; }
  lastShotAt = now;
  ammo--;
  updateAmmoHUD();

  // Muzzle flash + audio.
  muzzleFlash.visible = true;
  muzzleFlash.material.rotation = Math.random() * Math.PI;
  setTimeout(() => { muzzleFlash.visible = false; }, 45);
  audio.shot(loadoutKey);
  net.shoot();
  if (!w.auto) firing = false;

  // Raycast from camera centre with spread.
  camera.getWorldDirection(aimDir);
  aimDir.x += (Math.random() - 0.5) * 2 * w.spread;
  aimDir.y += (Math.random() - 0.5) * 2 * w.spread;
  aimDir.z += (Math.random() - 0.5) * 2 * w.spread;
  aimDir.normalize();
  raycaster.set(camera.getWorldPosition(new THREE.Vector3()), aimDir);
  raycaster.far = w.range;

  const targets = [];
  for (const e of enemies.values()) if (e.alive) targets.push(e.hitbox);
  for (const d of dummies) if (d.alive) targets.push(d.hitbox);
  const hits = raycaster.intersectObjects(targets, false);

  const from = new THREE.Vector3();
  muzzleFlash.getWorldPosition(from);
  if (hits.length) {
    const h = hits[0];
    spawnTracer(from, h.point);
    const ud = h.object.userData;
    if (ud.playerId) {
      net.hit(ud.playerId, w.damage);
      audio.hitmarker();
      popHitmarker();
    } else if (ud.dummyId) {
      const d = dummies.find((x) => x.id === ud.dummyId);
      if (d) damageDummy(d, w.damage);
      audio.hitmarker();
      popHitmarker();
    }
  } else {
    // Miss — tracer into the distance, thud against arena.
    const wallHits = raycaster.intersectObjects(scene.children, true)
      .filter((x) => !x.object.isSprite && x.object.visible && !x.object.userData.playerId && !x.object.userData.dummyId);
    const end = wallHits.length ? wallHits[0].point : camera.getWorldPosition(new THREE.Vector3()).addScaledVector(aimDir, w.range);
    spawnTracer(from, end);
  }

  if (ammo === 0) startReload();
}

function popHitmarker() {
  const hm = $('hitmarker');
  hm.classList.remove('pop');
  void hm.offsetWidth;
  hm.classList.add('pop');
}

function damageDummy(d, dmg) {
  d.hp -= dmg;
  if (d.hp <= 0) {
    d.alive = false; d.group.visible = false;
    d.respawnAt = performance.now() + 3000;
    audio.kill();
    addFeed(`<span class="vk">${escapeHtml(username)}</span> ⟂ <span class="vv">TARGET</span>`, true);
  }
}

function startReload() {
  const w = WEAPONS[loadoutKey];
  if (reloading || ammo === w.mag || !alive) return;
  reloading = true;
  reloadEnd = performance.now() + w.reload * 1000;
  audio.reload();
  updateAmmoHUD();
  setTimeout(() => {
    if (mode !== 'playing') { reloading = false; return; }
    ammo = w.mag; reloading = false;
    updateAmmoHUD();
  }, w.reload * 1000);
}

/* ================= movement + collision ================= */
const moveVec = new THREE.Vector3();
function collide(pos) {
  // Clamp arena bounds.
  pos.x = Math.max(-ARENA_HALF, Math.min(ARENA_HALF, pos.x));
  pos.z = Math.max(-ARENA_HALF, Math.min(ARENA_HALF, pos.z));
  // Push out of obstacle boxes (XZ only, circle approx).
  for (const box of obstacles) {
    const cx = Math.max(box.min.x, Math.min(pos.x, box.max.x));
    const cz = Math.max(box.min.z, Math.min(pos.z, box.max.z));
    const dx = pos.x - cx, dz = pos.z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 < PLAYER_RADIUS * PLAYER_RADIUS) {
      if (d2 > 1e-6) {
        const d = Math.sqrt(d2);
        pos.x = cx + (dx / d) * PLAYER_RADIUS;
        pos.z = cz + (dz / d) * PLAYER_RADIUS;
      } else {
        // Inside the box: push along smallest penetration axis.
        const px = Math.min(pos.x - box.min.x + PLAYER_RADIUS, box.max.x - pos.x + PLAYER_RADIUS);
        const pz = Math.min(pos.z - box.min.z + PLAYER_RADIUS, box.max.z - pos.z + PLAYER_RADIUS);
        if (px < pz) pos.x = (pos.x - box.min.x < box.max.x - pos.x) ? box.min.x - PLAYER_RADIUS : box.max.x + PLAYER_RADIUS;
        else pos.z = (pos.z - box.min.z < box.max.z - pos.z) ? box.min.z - PLAYER_RADIUS : box.max.z + PLAYER_RADIUS;
      }
    }
  }
}

function updatePlayer(dt) {
  if (!alive || matchOver) return;
  let ix = 0, iz = 0;
  if (keys.KeyW || keys.ArrowUp) iz -= 1;
  if (keys.KeyS || keys.ArrowDown) iz += 1;
  if (keys.KeyA || keys.ArrowLeft) ix -= 1;
  if (keys.KeyD || keys.ArrowRight) ix += 1;
  if (joy.active) { ix += joy.dx; iz += joy.dy; }

  const len = Math.hypot(ix, iz);
  if (len > 0.01) {
    const cl = Math.min(1, len);
    ix = (ix / len) * cl; iz = (iz / len) * cl;
    const sin = Math.sin(yaw), cos = Math.cos(yaw);
    moveVec.set(ix * cos - iz * sin, 0, -ix * sin - iz * cos).multiplyScalar(MOVE_SPEED * dt);
    playerPos.add(moveVec);
    collide(playerPos);
    // Subtle gun bob.
    const t = performance.now() / 1000;
    gunGroup.position.y = -0.3 + Math.sin(t * 11) * 0.008;
  }
  camera.position.set(playerPos.x, EYE, playerPos.z);
  camera.rotation.y = yaw;
  camera.rotation.x = pitch;

  // Sniper scope zoom.
  const targetFov = (aiming && WEAPONS[loadoutKey].scope) ? 26 : 75;
  if (Math.abs(camera.fov - targetFov) > 0.5) {
    camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 10);
    camera.updateProjectionMatrix();
  }
  gunGroup.visible = !(aiming && WEAPONS[loadoutKey].scope);
  $('crosshair').classList.toggle('scoped', aiming && WEAPONS[loadoutKey].scope);

  if (firing && WEAPONS[loadoutKey].auto) tryFire();
}

/* ================= per-frame ================= */
const clock = new THREE.Clock();
function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(0.05, clock.getDelta());
  const now = performance.now();

  if (mode === 'playing') {
    updatePlayer(dt);

    // Enemy interpolation + respawn visibility.
    for (const e of enemies.values()) {
      if (!e.alive && now > e.deadUntil && e.deadUntil !== 0) {
        // Server will send respawn; safety net in case it was missed.
        e.group.visible = true; e.alive = true; e.deadUntil = 0;
      }
      e.group.position.lerp(e.target, Math.min(1, dt * 12));
      e.group.rotation.y = e.ry + Math.PI;
    }
    // Dummy respawns.
    for (const d of dummies) {
      if (!d.alive && now >= d.respawnAt && d.respawnAt !== 0) {
        d.alive = true; d.hp = 100; d.group.visible = true; d.respawnAt = 0;
      }
    }
    // Expire tracers / flashes.
    for (const t of tracers) if (t.line.visible && now > t.until) t.line.visible = false;
    for (const f of enemyFlashes) if (f.s.visible && now > f.until) f.s.visible = false;

    // Match timer.
    const remain = Math.max(0, endsAt - Date.now());
    const mm = Math.floor(remain / 60000), ss = Math.floor((remain % 60000) / 1000);
    $('timer').textContent = `${mm}:${ss.toString().padStart(2, '0')}`;
    $('timer').classList.toggle('low', remain < 60000);
    if (remain <= 0) endMatch();
  }

  renderer.render(scene, camera);
}
tick();

/* ---- 20Hz state sync ---- */
setInterval(() => {
  if (mode === 'playing' && net.connected && !matchOver) {
    net.state([+playerPos.x.toFixed(2), 0, +playerPos.z.toFixed(2)], +yaw.toFixed(3), Math.round(hp));
  }
}, 1000 / STATE_HZ);

/* ---- lock hint for desktop ---- */
if (!IS_TOUCH) {
  const hint = document.createElement('div');
  hint.id = 'lock-hint';
  hint.className = 'hidden';
  hint.style.cssText = 'position:absolute;left:50%;top:58%;transform:translateX(-50%);background:rgba(0,0,0,.7);padding:10px 18px;border-radius:10px;font-size:13px;letter-spacing:2px;pointer-events:none;';
  hint.textContent = 'CLICK TO AIM';
  $('hud').appendChild(hint);
}

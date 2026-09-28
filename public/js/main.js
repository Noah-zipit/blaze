import * as THREE from 'three';
import { AudioSynth } from './audio.js';
import { Net } from './net.js';
import {
  canvas, renderer, scene, camera, resize,
  setMap, setMapKey, mapKey, cur, obstacles, losMeshes, SPAWNS, groundHeight,
  Quality, setQuality,
  buildViewmodel, vmGroup, vmState,
  makeSoldier, setBotUniform, makeFlash,
  spawnTracer, tracers, burst, updateParticles,
} from './world.js';

/* Blaze main — game logic ported verbatim from the approved demo, plus the
   multiplayer layer (mode 'multi') on the frozen server protocol. */

/* ================= CONFIG ================= */
const WEAPONS = {
  rifle:  { name: 'ASSAULT RIFLE', damage: 25, interval: 0.115, mag: 30, reload: 1.8, auto: true,  spread: 0.014, range: 95, scope: false },
  smg:    { name: 'SMG',           damage: 14, interval: 0.072, mag: 40, reload: 1.5, auto: true,  spread: 0.034, range: 65, scope: false },
  sniper: { name: 'SNIPER',        damage: 90, interval: 0.95,  mag: 5,  reload: 2.6, auto: false, spread: 0.001, range: 150, scope: true },
};
const EYE = 1.68, PLAYER_RADIUS = 0.42;
const GRAVITY = 26, JUMP_VEL = 9.2, WALK_ACCEL = 46, FRICTION = 11;
const MAX_SPEED = 8.2, SPRINT_MULT = 1.35;
const SLIDE_BOOST = 13, SLIDE_TIME = 0.75, SLIDE_COOLDOWN = 1.6;
const IS_TOUCH = window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
if (IS_TOUCH) document.body.classList.add('touch');

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

/* ================= SETTINGS (persisted) ================= */
const Settings = Object.assign(
  { sens: 1, volume: 0.9, invertY: false, camBob: true },
  JSON.parse(localStorage.getItem('blaze_settings') || '{}')
);
if (Settings.sens === undefined || Settings.sens === null) Settings.sens = 1;
if (Settings.camBob === undefined || Settings.camBob === null) Settings.camBob = true;
AudioSynth.setVolume(Settings.volume);
function saveSettings() {
  localStorage.setItem('blaze_settings', JSON.stringify({
    sens: Settings.sens, volume: Settings.volume, invertY: Settings.invertY,
    camBob: Settings.camBob, quality: Quality.current,
  }));
  localStorage.setItem('blaze_quality', Quality.current); // legacy key, kept in sync
}

/* ================= AUDIO (100% synthesized) ================= */
}

/* ================= GAME STATE ================= */
let mode = 'home'; // home | playing | ended
let username = localStorage.getItem('blaze_username') || '';
let loadoutKey = localStorage.getItem('blaze_loadout') || 'rifle';
let hp = 100, alive = true, ammo = 30, reloading = false, reloadEnd = 0;
let yaw = 0, pitch = 0, aiming = false;
let firing = false, matchOver = false, paused = false;
let matchElapsed = 0;            // game-time seconds (freezes on pause)
const MATCH_LEN = 5 * 60;        // seconds
const playerPos = new THREE.Vector3(0, 0, -20);
const playerVel = new THREE.Vector3();
let vy = 0, grounded = true;
let sliding = false, slideT = 0, slideCdUntil = 0;
const slideDir = new THREE.Vector3();
let sprinting = false;
let walkPhase = 0;
const scores = new Map(); // name -> {kills, deaths, me}
let playerFlash = null;
let playerRespawnAt = 0, spawnStamp = 0;   // game-time; loadout locked 5s after each spawn
let rlgl = null;                 // red-light-green-light state (doll's yard only)
let rlMoveT = 0;                 // player's sustained movement during red light
let dollHeadAnim = null;         // {t, dur, from, to}

/* ================= COLLISION ================= */
function collide(pos, feetY) {
  const hx = cur ? cur.bounds.hx : 26, hz = cur ? cur.bounds.hz : 26;
  pos.x = clamp(pos.x, -hx, hx);
  pos.z = clamp(pos.z, -hz, hz);
  for (const b of obstacles) {
    if (b.max.y <= feetY + 0.55) continue;
    if (b.min.y > feetY + 1.6) continue;
    const cx = clamp(pos.x, b.min.x, b.max.x);
    const cz = clamp(pos.z, b.min.z, b.max.z);
    const dx = pos.x - cx, dz = pos.z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 < PLAYER_RADIUS * PLAYER_RADIUS) {
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        pos.x = cx + dx / d * PLAYER_RADIUS;
        pos.z = cz + dz / d * PLAYER_RADIUS;
      } else {
        const px1 = pos.x - b.min.x + PLAYER_RADIUS, px2 = b.max.x - pos.x + PLAYER_RADIUS;
        const pz1 = pos.z - b.min.z + PLAYER_RADIUS, pz2 = b.max.z - pos.z + PLAYER_RADIUS;
        const m = Math.min(px1, px2, pz1, pz2);
        if (m === px1) pos.x = b.min.x - PLAYER_RADIUS;
        else if (m === px2) pos.x = b.max.x + PLAYER_RADIUS;
        else if (m === pz1) pos.z = b.min.z - PLAYER_RADIUS;
        else pos.z = b.max.z + PLAYER_RADIUS;
      }
    }
  }
}

/* ================= BOTS ================= */
const bots = [];
const BOT_DEFS = [
  { name: 'RAZOR', spawn: 1, wkey: 'rifle' },
  { name: 'HAVOC', spawn: 2, wkey: 'smg' },
];
const BOT_THINK_HZ = 10;
const raycaster = new THREE.Raycaster();
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();

function spawnBots() {
  for (const b of bots) scene.remove(b.s.group);
  bots.length = 0;
  BOT_DEFS.forEach((def, i) => {
    const s = makeSoldier(def.name, 'bot', def.wkey);
    const p = SPAWNS[def.spawn].clone();
    s.group.position.copy(p);
    scene.add(s.group);
    const flash = makeFlash(0.55);
    scene.add(flash);
    bots.push({
      name: def.name, wkey: def.wkey, s, flash, flashUntil: 0,
      pos: p, vel: new THREE.Vector3(), hp: 100, alive: true,
      state: 'roam', wp: new THREE.Vector3(rand(-20, 20), 0, rand(-20, 20)),
      thinkT: rand(0, 0.1), strafeDir: 1, strafeT: 0, shootT: rand(0.8, 1.6),
      losOk: false, deathT: 0, respawnAt: 0, walkAmt: 0, spawnIdx: def.spawn,
      laneX: [-8, 8][i] !== undefined ? [-8, 8][i] : rand(-10, 10),
      reactT: 0, stillT: 0, lastDesired: new THREE.Vector3(),
    });
    if (!scores.has(def.name)) scores.set(def.name, { kills: 0, deaths: 0, me: false });
  });
}

function botLOS(b) {
  _v1.copy(b.pos); _v1.y += 1.6;
  _v2.copy(playerPos); _v2.y += 1.2;
  _v3.copy(_v2).sub(_v1);
  const dist = _v3.length();
  raycaster.set(_v1, _v3.normalize());
  raycaster.far = dist;
  const hits = raycaster.intersectObjects(losMeshes, false);
  return hits.length === 0;
}

function randomWp(out) {
  out.set(rand(-22, 22), 0, rand(-22, 22));
  return out;
}

function dollRespawnPos(b) {
  b.pos.set(b.laneX, 0, -20);
}

function updateBot(b, dt, now) {
  const g = b.s.group;
  if (!b.alive) {
    if (b.deathT < 1.4) {
      b.deathT += dt;
      const k = clamp(b.deathT / 0.35, 0, 1);
      g.rotation.x = -Math.PI / 2 * k;
      g.position.y = b.pos.y - k * 0.25;
      if (b.deathT > 1.1) g.visible = false;
    }
    if (matchElapsed >= b.respawnAt) {
      if (mapKey === 'dolls') dollRespawnPos(b); else b.pos.copy(SPAWNS[b.spawnIdx]);
      b.vel.set(0, 0, 0);
      b.hp = 100; b.alive = true; b.deathT = 0;
      g.visible = true; g.rotation.x = 0; g.position.copy(b.pos);
      b.state = 'roam'; randomWp(b.wp);
      addFeed(`<span class="vv">${b.name}</span> redeployed`, false);
    }
    return;
  }

  b.thinkT -= dt;
  _v1.copy(playerPos).sub(b.pos); _v1.y = 0;
  const dist = _v1.length();
  const desired = _v2.set(0, 0, 0);
  let speed = 0, faceX = 0, faceZ = 1, accelRate = 6;
  const isDolls = mapKey === 'dolls' && rlgl;

  if (isDolls) {
    // red-light-green-light: advance to the finish line, freeze on red
    if (b.thinkT <= 0) {
      b.thinkT = 1 / BOT_THINK_HZ;
      b.losOk = alive && !matchOver && dist < 45 && botLOS(b);
    }
    const red = rlgl.phase === 'red';
    if (red) {
      b.reactT -= dt;
      if (b.reactT > 0) {
        desired.copy(b.lastDesired); speed = 4.2; // hasn't reacted yet — keeps advancing
        accelRate = 6;
      } else {
        desired.set(0, 0, 0); speed = 0;          // frozen — decelerate hard or get caught
        accelRate = b.stumble ? 2.5 : 8;
        b.stillT = Math.hypot(b.vel.x, b.vel.z) > 1.0 ? b.stillT + dt : 0;
        if (b.stillT > 0.3) { killBot(b, true); return; }  // CAUGHT by the doll
      }
      faceX = -b.pos.x; faceZ = 21 - b.pos.z; // face the doll while frozen
    } else {
      _v3.set(b.laneX, 0, 15.2).sub(b.pos); _v3.y = 0;
      if (_v3.length() < 1.2) { lineCross(b); return; }
      _v3.normalize();
      desired.copy(_v3);
      speed = 4.2;
      if (b.losOk && dist < 18) {
        // strafe-fight while still drifting toward the line
        b.strafeT -= dt;
        if (b.strafeT <= 0) { b.strafeT = rand(0.8, 1.8); b.strafeDir = Math.random() < 0.5 ? -1 : 1; }
        _v1.normalize();
        desired.x = desired.x * 0.5 + (-_v1.z * b.strafeDir) * 0.7;
        desired.z = desired.z * 0.5 + (_v1.x * b.strafeDir) * 0.7;
        desired.normalize();
        speed = 4.6;
        faceX = _v1.x; faceZ = _v1.z;
        b.shootT -= dt;
        if (b.shootT <= 0) { b.shootT = rand(0.6, 1.3); botFire(b, dist); }
      } else { faceX = desired.x; faceZ = desired.z; }
      b.lastDesired.copy(desired);
    }
  } else {
    if (b.thinkT <= 0) {
      b.thinkT = 1 / BOT_THINK_HZ;
      b.losOk = alive && !matchOver && dist < 45 && botLOS(b);
      if (b.losOk) {
        if (b.state !== 'combat') { b.state = 'combat'; b.strafeT = 0; b.shootT = rand(0.5, 1.0); }
      } else if (b.state === 'combat') {
        b.state = 'roam'; randomWp(b.wp);
      }
      if (b.state === 'roam' && (b.pos.distanceTo(b.wp) < 2 || Math.random() < 0.12)) randomWp(b.wp);
    }

    if (b.state === 'combat') {
      b.strafeT -= dt;
      if (b.strafeT <= 0) { b.strafeT = rand(0.8, 1.8); b.strafeDir = Math.random() < 0.5 ? -1 : 1; }
      _v1.normalize();
      desired.set(-_v1.z * b.strafeDir, 0, _v1.x * b.strafeDir);
      const radial = dist > 20 ? 0.7 : dist < 9 ? -0.8 : 0;
      desired.x += _v1.x * radial; desired.z += _v1.z * radial;
      desired.normalize();
      speed = 5.2;
      faceX = _v1.x; faceZ = _v1.z;
      b.shootT -= dt;
      if (b.shootT <= 0 && b.losOk) { b.shootT = rand(0.55, 1.25); botFire(b, dist); }
    } else {
      _v3.copy(b.wp).sub(b.pos); _v3.y = 0;
      if (_v3.lengthSq() > 0.5) {
        desired.copy(_v3.normalize());
        speed = 3.4;
        faceX = desired.x; faceZ = desired.z;
      }
    }
  }

  b.vel.x += (desired.x * speed - b.vel.x) * Math.min(1, dt * accelRate);
  b.vel.z += (desired.z * speed - b.vel.z) * Math.min(1, dt * 6);
  b.pos.x += b.vel.x * dt;
  b.pos.z += b.vel.z * dt;
  const gy = groundHeight(b.pos.x, b.pos.z, b.pos.y);
  b.pos.y += (gy - b.pos.y) * Math.min(1, dt * 10);
  collide(b.pos, b.pos.y);
  g.position.copy(b.pos);
  g.rotation.y = Math.atan2(faceX, faceZ);
  b.walkAmt += (clamp(b.vel.length() / 5, 0, 1) - b.walkAmt) * Math.min(1, dt * 8);
  b.s.setWalk(dt, b.walkAmt);
  if (now > b.flashUntil) b.flash.visible = false;
}

function botFire(b, dist) {
  b.s.parts.gunTip.getWorldPosition(_v1);
  b.flash.position.copy(_v1);
  b.flash.material.rotation = Math.random() * Math.PI;
  b.flash.visible = true;
  b.flashUntil = performance.now() + 60;
  AudioSynth.botShot(dist);
  _v2.copy(playerPos); _v2.y += 1.2;
  const miss = dist * 0.06;
  _v2.x += rand(-miss, miss); _v2.y += rand(-miss * 0.6, miss * 0.6); _v2.z += rand(-miss, miss);
  spawnTracer(_v1, _v2);
  const hitChance = clamp(0.5 - dist * 0.01, 0.06, 0.45);
  if (Math.random() < hitChance) damagePlayer(Math.round(rand(8, 15)), b.name);
}

/* ---- doll-yard scoring: line cross = +1, first to 7 wins ---- */
function checkDollWin(name) {
  if (mapKey === 'dolls' && !matchOver && scores.get(name).kills >= 7) endMatch(name);
}
function lineCross(b) {
  scores.get(b.name).kills++;
  burst(_v3.copy(b.pos).setY(b.pos.y + 1.5), 12, 0x37d67a, 5);
  addFeed(`<span class="vk">${b.name}</span> crossed the line <span style="color:#37d67a;font-weight:800">+1</span>`, b.name === username);
  renderScoreboard();
  checkDollWin(b.name);
  dollRespawnPos(b);
  b.vel.set(0, 0, 0);
  b.s.group.position.copy(b.pos);
  AudioSynth.kill();
}
function playerLineCross() {
  scores.get(username).kills++;
  burst(_v3.copy(playerPos).setY(playerPos.y + 1.5), 12, 0x37d67a, 5);
  addFeed(`<span class="vk">${escapeHtml(username)}</span> crossed the line <span style="color:#37d67a;font-weight:800">+1</span>`, true);
  renderScoreboard();
  checkDollWin(username);
  playerPos.set(clamp(playerPos.x, -10, 10), 0, -20);
  playerVel.set(0, 0, 0); vy = 0;
  AudioSynth.kill();
}

function damageBot(b, dmg, byPlayer) {
  if (!b.alive || matchOver) return;
  b.hp -= dmg;
  burst(_v3.copy(b.pos).setY(b.pos.y + 1.3), 5, 0xff6b35, 3);
  if (b.hp <= 0) killBot(b, false, byPlayer);
}
function killBot(b, byDoll, byPlayer = false) {
  if (!b.alive || matchOver) return;
  b.alive = false; b.deathT = 0; b.respawnAt = matchElapsed + 3;
  b.s.parts.gunTip.getWorldPosition(_v1);
  if (byDoll) {
    AudioSynth.zap();
    dollZapFx(b.pos);
    burst(_v1, 16, 0xff3b30, 6);
    addFeed(`<span style="color:#ff3b30;font-weight:800">DOLL</span> ⌖ <span class="vv">${b.name}</span>`, false);
  } else {
    burst(_v1, 14, 0xff6b35, 5);
    AudioSynth.death();
  }
  scores.get(b.name).deaths++;
  if (byPlayer && !byDoll) {
    scores.get(username).kills++;
    AudioSynth.kill();
    addFeed(`<span class="vk">${escapeHtml(username)}</span> ⟂ <span class="vv">${b.name}</span>`, true);
  }
  renderScoreboard();
}

/* ================= PLAYER COMBAT ================= */
function damagePlayer(dmg, fromName) {
  if (!alive || matchOver) return;
  hp -= dmg;
  AudioSynth.hurt();
  const dv = $('dmg-vignette');
  dv.style.opacity = '1';
  setTimeout(() => { dv.style.opacity = '0'; }, 140);
  updateHealthHUD();
  if (hp <= 0) playerDie(fromName, false);
}
function playerDie(fromName, byDoll) {
  if (!alive || matchOver) return;
  hp = 0; alive = false; firing = false; rlMoveT = 0;
  scores.get(username).deaths++;
  if (byDoll) {
    AudioSynth.zap();
    dollZapFx(playerPos);
    const dv = $('dmg-vignette');
    dv.style.opacity = '1';
    setTimeout(() => { dv.style.opacity = '0'; }, 600);
    addFeed(`<span style="color:#ff3b30;font-weight:800">DOLL</span> ⌖ <span class="vv">${escapeHtml(username)}</span>`, true);
  } else {
    AudioSynth.death();
    if (fromName && scores.has(fromName)) scores.get(fromName).kills++;
    addFeed(`<span class="vk">${escapeHtml(fromName || 'ARENA')}</span> ⟂ <span class="vv">${escapeHtml(username)}</span>`, true);
  }
  renderScoreboard();
  $('death-overlay').classList.add('on');
  playerRespawnAt = matchElapsed + 3;
}
function dollZapFx(pos) {
  if (!cur || !cur.doll) return;
  cur.doll.eyeAnchor.getWorldPosition(_v1);
  _v2.copy(pos); _v2.y += 1.2;
  spawnTracer(_v1, _v2, 0xff2d1e);
  burst(_v2, 10, 0xff3b30, 5);
}

const aimDir = new THREE.Vector3();
const shotTargets = [];
let lastShotAt = 0;
function tryFire() {
  if (mode !== 'playing' || paused || !alive || matchOver) return;
  const w = WEAPONS[loadoutKey];
  const nowS = performance.now() / 1000;
  if (reloading || nowS - lastShotAt < w.interval) return;
  if (ammo <= 0) { AudioSynth.emptyClick(); startReload(); return; }
  lastShotAt = nowS;
  ammo--;
  updateAmmoHUD();

  vmState.tip.getWorldPosition(_v1);
  playerFlash.position.copy(_v1);
  playerFlash.material.rotation = Math.random() * Math.PI;
  playerFlash.visible = true;
  setTimeout(() => { playerFlash.visible = false; }, 45);
  if (vmState.flash) {
    vmState.flash.visible = true;
    vmState.flash.material.rotation = Math.random() * Math.PI;
    setTimeout(() => { if (vmState.flash) vmState.flash.visible = false; }, 45);
  }
  vmState.kick = 1; // viewmodel kickback, decayed in updateCamera
  AudioSynth.shot(loadoutKey);
  if (!w.auto) firing = false;
  if (playMode === 'multi' && net.connected) net.shoot();

  camera.getWorldDirection(aimDir);
  aimDir.x += (Math.random() - 0.5) * 2 * w.spread;
  aimDir.y += (Math.random() - 0.5) * 2 * w.spread;
  aimDir.z += (Math.random() - 0.5) * 2 * w.spread;
  aimDir.normalize();
  raycaster.set(camera.getWorldPosition(_v2), aimDir);
  raycaster.far = w.range;
  shotTargets.length = 0;
  if (playMode === 'multi') {
    for (const r of remotes.values()) if (r.alive) shotTargets.push(r.s.hitbox);
  } else {
    for (const b of bots) if (b.alive) shotTargets.push(b.s.hitbox);
  }
  const hits = raycaster.intersectObjects(shotTargets, false);
  if (hits.length) {
    const h = hits[0];
    spawnTracer(_v1, h.point);
    const pid = h.object.userData && h.object.userData.playerId;
    if (playMode === 'multi' && pid) {
      net.hit(pid, w.damage); // server is authoritative — no local damage
      AudioSynth.hitmarker(); popHitmarker();
    } else {
      const b = bots.find((x) => x.s.hitbox === h.object);
      if (b) { damageBot(b, w.damage, true); AudioSynth.hitmarker(); popHitmarker(); }
    }
  } else {
    const wall = raycaster.intersectObjects(losMeshes, false);
    const end = wall.length ? wall[0].point : _v2.addScaledVector(aimDir, w.range);
    spawnTracer(_v1, end);
    if (wall.length) burst(wall[0].point, 3, 0xffc37a, 2);
  }
  if (ammo === 0) startReload();
}

function startReload() {
  const w = WEAPONS[loadoutKey];
  if (reloading || ammo === w.mag || !alive || matchOver) return;
  reloading = true;
  AudioSynth.reload();
  updateAmmoHUD();
  setTimeout(() => {
    if (mode !== 'playing') { reloading = false; return; }
    ammo = w.mag; reloading = false;
    updateAmmoHUD();
  }, w.reload * 1000);
}

/* ================= HUD ================= */
function updateHealthHUD() {
  $('health-bar').firstElementChild.style.width = clamp(hp, 0, 100) + '%';
  $('health-bar').classList.toggle('low', hp <= 35);
  $('health-num').textContent = Math.max(0, Math.ceil(hp));
}
function updateAmmoHUD() {
  $('ammo').textContent = ammo;
  document.querySelector('#ammo-wrap .ammo-sub').textContent = '/ ' + WEAPONS[loadoutKey].mag;
  $('ammo-wrap').classList.toggle('reloading', reloading);
  $('wname').textContent = WEAPONS[loadoutKey].name;
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
    .map(([key, s]) => ({ name: s.name || key, ...s }))
    .sort((a, b) => (b.kills - a.kills) || (a.deaths - b.deaths));
  const html = rows.map((r) =>
    `<tr class="${r.me ? 'me' : ''}"><td>${escapeHtml(r.name)}</td><td>${r.kills}</td><td>${r.deaths}</td></tr>`).join('');
  document.querySelector('#scoreboard tbody').innerHTML = html;
  document.querySelector('#screen-end tbody').innerHTML = html;
}
function popHitmarker() {
  const hm = $('hitmarker');
  hm.classList.remove('pop');
  void hm.offsetWidth;
  hm.classList.add('pop');
}
function setBanner(kind, text) {
  const b = $('rlgl-banner');
  if (!kind) { b.className = ''; b.textContent = ''; return; }
  b.className = 'on ' + kind;
  b.textContent = text;
}

/* ================= PING (honest network latency) ================= */
async function measurePing() {
  const t0 = performance.now();
  try {
    await fetch('https://cdn.jsdelivr.net/', { method: 'HEAD', mode: 'no-cors', cache: 'no-store' });
  } catch (e) { /* offline or blocked */ }
  const ms = Math.round(performance.now() - t0);
  const chip = $('ping-chip');
  chip.textContent = 'PING ' + ms + ' MS';
  chip.style.color = ms < 120 ? '#9fe8a8' : ms < 300 ? '#ffd23e' : '#ff3b30';
}
setInterval(() => { if (mode === 'playing') measurePing(); }, 5000);

/* ================= INPUT: DESKTOP ================= */
const keys = {};
window.addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (e.code === 'Escape' && mode === 'playing') { setPaused(!paused); return; }
  if (mode !== 'playing' || paused) return;
  if (e.code === 'KeyR') startReload();
  if (e.code === 'Tab') { e.preventDefault(); $('scoreboard').classList.remove('hidden'); }
  if (e.code === 'KeyM') toggleMute();
  if (e.code === 'Space') { e.preventDefault(); doJump(); }
  if (e.code === 'KeyC') doSlide();
});
window.addEventListener('keyup', (e) => {
  keys[e.code] = false;
  if (e.code === 'Tab') $('scoreboard').classList.add('hidden');
});
canvas.addEventListener('click', () => {
  if (mode === 'playing' && !paused && !IS_TOUCH && document.pointerLockElement !== canvas) {
    try { canvas.requestPointerLock(); } catch (e) { /* unsupported */ }
  }
});
document.addEventListener('pointerlockchange', () => {
  const h = $('lock-hint');
  if (h) h.classList.toggle('hidden', document.pointerLockElement === canvas || IS_TOUCH);
});
document.addEventListener('mousemove', (e) => {
  if (mode !== 'playing' || paused || document.pointerLockElement !== canvas) return;
  const sens = (aiming ? 0.0009 : 0.0021) * Settings.sens;
  const dir = Settings.invertY ? 1 : -1;
  yaw -= e.movementX * sens;
  pitch = clamp(pitch + dir * e.movementY * sens, -1.45, 1.45);
});
canvas.addEventListener('mousedown', (e) => {
  if (mode !== 'playing' || paused || document.pointerLockElement !== canvas) return;
  if (e.button === 0) { firing = true; tryFire(); }
  if (e.button === 2 && WEAPONS[loadoutKey].scope) aiming = true;
});
window.addEventListener('mouseup', (e) => {
  if (e.button === 0) firing = false;
  if (e.button === 2) aiming = false;
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('contextmenu', (e) => { if (mode === 'playing') e.preventDefault(); });

/* ================= INPUT: TOUCH ================= */
const joy = { active: false, id: null, dx: 0, dy: 0 };
const look = { id: null, lx: 0, ly: 0 };
function moveStick(dx, dy) {
  $('stick').style.transform = `translate(calc(-50% + ${dx * 34}px), calc(-50% + ${dy * 34}px))`;
}
document.addEventListener('touchstart', (e) => {
  if (mode !== 'playing' || paused) return;
  for (const t of e.changedTouches) {
    const el = document.elementFromPoint(t.clientX, t.clientY);
    if (el && el.closest('#joystick')) {
      joy.active = true; joy.id = t.identifier; joy.dx = 0; joy.dy = 0; moveStick(0, 0);
    } else if (el && el.closest('.touch-btn')) {
      // buttons handle themselves
    } else if (t.clientX > window.innerWidth * 0.35 && look.id === null) {
      look.id = t.identifier; look.lx = t.clientX; look.ly = t.clientY;
    }
  }
}, { passive: true });
document.addEventListener('touchmove', (e) => {
  if (mode === 'playing' && !paused) e.preventDefault();
  if (mode !== 'playing' || paused) return;
  for (const t of e.changedTouches) {
    if (t.identifier === joy.id) {
      const r = $('joystick').getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      let dx = (t.clientX - cx) / (r.width / 2), dy = (t.clientY - cy) / (r.height / 2);
      const m = Math.hypot(dx, dy);
      if (m > 1) { dx /= m; dy /= m; }
      joy.dx = dx; joy.dy = dy; moveStick(dx, dy);
    } else if (t.identifier === look.id) {
      const sens = (aiming ? 0.0016 : 0.0042) * Settings.sens;
      const dir = Settings.invertY ? 1 : -1;
      yaw -= (t.clientX - look.lx) * sens;
      pitch = clamp(pitch + dir * (t.clientY - look.ly) * sens, -1.45, 1.45);
      look.lx = t.clientX; look.ly = t.clientY;
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
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());

const bindBtn = (id, down, up) => {
  const el = $(id);
  el.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); down(); }, { passive: false });
  if (up) { el.addEventListener('touchend', (e) => { e.preventDefault(); up(); }); }
};
bindBtn('btn-fire', () => { firing = true; tryFire(); }, () => { firing = false; });
bindBtn('btn-jump', () => doJump());
bindBtn('btn-slide', () => doSlide());
bindBtn('btn-reload-touch', () => startReload());
bindBtn('btn-aim', () => { aiming = !aiming; });

/* ================= MOVEMENT ================= */
function doJump() {
  if (mode !== 'playing' || paused || !alive || matchOver) return;
  if (grounded && !sliding) {
    vy = JUMP_VEL; grounded = false;
    AudioSynth.jump();
  }
}
function doSlide() {
  if (mode !== 'playing' || paused || !alive || matchOver || sliding) return;
  const now = performance.now();
  if (!grounded || now < slideCdUntil) return;
  const sp = Math.hypot(playerVel.x, playerVel.z);
  if (sp < 3 && !sprinting) return;
  sliding = true; slideT = SLIDE_TIME;
  slideCdUntil = now + SLIDE_COOLDOWN * 1000;
  if (sp > 0.5) slideDir.set(playerVel.x / sp, 0, playerVel.z / sp);
  else slideDir.set(-Math.sin(yaw), 0, -Math.cos(yaw));
  AudioSynth.slideSnd();
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
  sprinting = (keys.ShiftLeft || keys.ShiftRight || (joy.active && joy.dy < -0.92)) && len > 0.1 && !sliding;

  if (sliding) {
    slideT -= dt;
    const k = Math.max(0, slideT / SLIDE_TIME);
    playerVel.x = slideDir.x * SLIDE_BOOST * (0.35 + 0.65 * k);
    playerVel.z = slideDir.z * SLIDE_BOOST * (0.35 + 0.65 * k);
    if (slideT <= 0) sliding = false;
  } else if (len > 0.01) {
    const cl = Math.min(1, len);
    ix = ix / len * cl; iz = iz / len * cl;
    const sin = Math.sin(yaw), cos = Math.cos(yaw);
    const wx = cos * ix + sin * iz;
    const wz = -sin * ix + cos * iz;
    const maxSp = MAX_SPEED * (sprinting ? SPRINT_MULT : 1) * (aiming ? 0.6 : 1);
    const rate = grounded ? 10 : 3.5;
    playerVel.x += (wx * maxSp - playerVel.x) * Math.min(1, dt * rate);
    playerVel.z += (wz * maxSp - playerVel.z) * Math.min(1, dt * rate);
  } else if (grounded) {
    const f = Math.max(0, 1 - FRICTION * dt);
    playerVel.x *= f; playerVel.z *= f;
  }

  playerPos.x += playerVel.x * dt;
  playerPos.z += playerVel.z * dt;
  collide(playerPos, playerPos.y);

  vy -= GRAVITY * dt;
  let ny = playerPos.y + vy * dt;
  const gy = groundHeight(playerPos.x, playerPos.z, playerPos.y);
  if (ny <= gy) {
    if (!grounded && vy < -12) burst(_v1.copy(playerPos).setY(gy + 0.1), 4, 0x5a5a60, 2);
    ny = gy; vy = 0; grounded = true;
  } else if (ny > gy + 0.02) {
    grounded = false;
  }
  playerPos.y = ny;

  // RED LIGHT: any sustained movement = elimination by the doll
  if (rlgl && rlgl.phase === 'red') {
    const spd = Math.hypot(playerVel.x, playerVel.z, vy * 0.6);
    if (spd > 1.0) rlMoveT += dt; else rlMoveT = 0;
    if (rlMoveT > 0.35) { rlMoveT = 0; playerDie('DOLL', true); return; }
  }

  // doll's yard: crossing the finish line scores +1
  if (mapKey === 'dolls' && alive && playerPos.z >= 15.2) playerLineCross();

  walkPhase += dt * Math.hypot(playerVel.x, playerVel.z) * 1.4;

  updateCamera(dt);
  if (firing && WEAPONS[loadoutKey].auto) tryFire();
}

/* ---- first-person camera: eye height, yaw/pitch, slide dip + roll, sprint bob, FOV kicks ---- */
let bobPhase = 0;
function updateCamera(dt) {
  const hSpeed = Math.hypot(playerVel.x, playerVel.z);
  const dip = sliding ? 0.62 : 0;
  const bobOn = Settings.camBob !== false && grounded && !sliding && hSpeed > 0.8 && alive;
  if (bobOn) bobPhase += dt * (5 + hSpeed * 1.1);
  const bobAmt = bobOn ? Math.min(1, hSpeed / MAX_SPEED) : 0;
  const bobY = Math.sin(bobPhase * 2) * 0.028 * bobAmt;
  const bobX = Math.cos(bobPhase) * 0.014 * bobAmt;

  camera.position.set(
    playerPos.x + bobX * Math.cos(yaw),
    playerPos.y + EYE - dip + bobY,
    playerPos.z - bobX * Math.sin(yaw)
  );
  camera.rotation.y = yaw;
  camera.rotation.x = pitch;
  camera.rotation.z = sliding ? 0.14 : 0;

  // viewmodel dynamics: fire kick, reload dip, ADS centering
  vmState.kick = Math.max(0, vmState.kick - dt * 7);
  vmState.adsK += ((aiming ? 1 : 0) - vmState.adsK) * Math.min(1, dt * 12);
  if (vmState.gun) {
    vmState.gun.position.set(
      0.27 + (0.0 - 0.27) * vmState.adsK,
      -0.26 + (0.06) * vmState.adsK - (reloading ? 0.14 : 0),
      -0.5 + (0.12) * vmState.adsK + vmState.kick * 0.09
    );
    vmState.gun.rotation.x = vmState.kick * 0.14 + (reloading ? 0.35 : 0);
  }
  vmGroup.visible = alive && mode === 'playing';

  const w = WEAPONS[loadoutKey];
  const targetFov = aiming ? (w.scope ? 50 : 64) : (sliding ? 84 : 75);
  if (Math.abs(camera.fov - targetFov) > 0.3) {
    camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 10);
    camera.updateProjectionMatrix();
  }
}

/* ================= RED LIGHT / GREEN LIGHT ================= */
function startRLGL() {
  rlgl = { phase: 'green', until: matchElapsed + 3 };
  rlMoveT = 0;
  const D = cur.doll;
  D.head.rotation.y = 0; // facing the wall
  D.eyeMat.color.setHex(0x37d67a);
  setBanner('green', '🟢 GREEN LIGHT');
}
function updateRLGL(dt) {
  if (!rlgl || matchOver) return;
  const D = cur.doll;
  if (rlgl.phase === 'green' && matchElapsed >= rlgl.until) {
    rlgl.phase = 'chant';
    rlgl.until = matchElapsed + 2.0;
    AudioSynth.chant();
    dollHeadAnim = { t: 0, dur: 1.7, from: 0, to: Math.PI }; // turns to face players
    setBanner('ready', '♪ GET READY ♪');
  } else if (rlgl.phase === 'chant' && matchElapsed >= rlgl.until) {
    rlgl.phase = 'red';
    rlgl.until = matchElapsed + rand(2, 5);
    D.eyeMat.color.setHex(0xff2d1e);
    for (const b of bots) {
      b.reactT = Math.random() < 0.3 ? rand(0.7, 1.2) : rand(0.2, 0.6); // stumblers get caught
      b.stumble = b.reactT > 0.65;
      b.stillT = 0;
      b.lastDesired.set(0, 0, 0);
    }
    setBanner('red', '🔴 RED LIGHT');
  } else if (rlgl.phase === 'red' && matchElapsed >= rlgl.until) {
    rlgl.phase = 'green';
    rlgl.until = matchElapsed + rand(4, 8);
    D.eyeMat.color.setHex(0x37d67a);
    dollHeadAnim = { t: 0, dur: 0.8, from: Math.PI, to: 0 }; // turns back to the wall
    setBanner('green', '🟢 GREEN LIGHT');
  }
  if (dollHeadAnim) {
    dollHeadAnim.t += dt;
    const k = clamp(dollHeadAnim.t / dollHeadAnim.dur, 0, 1);
    const s = k * k * (3 - 2 * k); // smoothstep
    D.head.rotation.y = dollHeadAnim.from + (dollHeadAnim.to - dollHeadAnim.from) * s;
    if (k >= 1) dollHeadAnim = null;
  }
}

/* ================= MATCH FLOW ================= */
function goFullscreen() {
  try {
    const el = document.documentElement;
    if (el.requestFullscreen) { el.requestFullscreen().catch(() => {}); }
    else if (el.webkitRequestFullscreen) { el.webkitRequestFullscreen(); }
  } catch (e) { /* unsupported — landscape prompt covers it */ }
}

function respawnPlayer(pos) {
  buildViewmodel(loadoutKey); // FPS viewmodel gun for the current loadout
  playerPos.copy(pos || SPAWNS[0]); playerVel.set(0, 0, 0); vy = 0; grounded = true;
  sliding = false; slideT = 0; slideCdUntil = 0;
  yaw = Math.atan2(-playerPos.x, -playerPos.z); pitch = 0;
  hp = 100; alive = true; ammo = WEAPONS[loadoutKey].mag; reloading = false;
  rlMoveT = 0;
  spawnStamp = matchElapsed;   // loadout locked for 5s from here
  $('death-overlay').classList.remove('on');
  updateHealthHUD(); updateAmmoHUD();
}

function startMatch() {
  playMode = 'solo';
  setMap(mapKey);
  setBotUniform(mapKey === 'dolls' ? 'tracksuit' : 'combat');
  scores.clear();
  scores.set(username, { kills: 0, deaths: 0, me: true });
  aiming = false; firing = false;
  matchOver = false; paused = false;
  matchElapsed = 0;
  rlgl = null; dollHeadAnim = null;
  setBanner(null);

  if (playerFlash) scene.remove(playerFlash);
  playerFlash = makeFlash(0.5);
  scene.add(playerFlash);

  respawnPlayer();
  spawnBots();
  if (mapKey === 'dolls') startRLGL();

  renderScoreboard();
  $('killfeed').innerHTML = '';
  $('scoreboard').classList.add('hidden');
  $('pause-menu').classList.add('hidden');

  $('screen-home').classList.remove('active');
  $('screen-end').classList.remove('active');
  $('hud').classList.add('on');
  if (IS_TOUCH) $('touch-ui').classList.add('on');
  $('mode-chip').textContent = 'SKIRMISH';
  mode = 'playing';
  resize();
  measurePing();
  const mapName = mapKey === 'dolls' ? "DOLL'S YARD" : mapKey === 'harbor' ? 'TIDE DOCK' : 'SECTOR 04';
  addFeed(`<span class="vk">${escapeHtml(username)}</span> deployed to ${mapName} — 2 hostiles inbound`, true);
  if (mapKey === 'dolls') addFeed('First to 7 wins. <span style="color:#ff3b30;font-weight:800">Do not move on red.</span>', true);
}

function endMatch(winnerName) {
  if (matchOver) return;
  matchOver = true; mode = 'ended'; firing = false;
  setPaused(false);
  renderScoreboard();
  $('end-title').textContent = !winnerName ? 'TIME UP'
    : winnerName === username ? 'VICTORY' : escapeHtml(winnerName) + ' WINS';
  try { document.exitPointerLock && document.exitPointerLock(); } catch (e) {}
  $('screen-end').classList.add('active');
}

/* ================= PAUSE + SETTINGS ================= */
function setPaused(p) {
  if (mode !== 'playing') p = false;
  paused = p;
  $('pause-menu').classList.toggle('hidden', !p);
  if (p) {
    try { document.exitPointerLock && document.exitPointerLock(); } catch (e) {}
    firing = false;
    updateLoadoutLockUI();
  }
  AudioSynth.uiClick();
}
function showPauseTab(name) {
  $('ptab-settings').classList.toggle('selected', name === 'settings');
  $('ptab-loadout').classList.toggle('selected', name === 'loadout');
  $('ppanel-settings').classList.toggle('hidden', name !== 'settings');
  $('ppanel-loadout').classList.toggle('hidden', name !== 'loadout');
  AudioSynth.uiClick();
}
$('ptab-settings').onclick = () => showPauseTab('settings');
$('ptab-loadout').onclick = () => showPauseTab('loadout');
$('btn-resume').onclick = () => setPaused(false);
$('btn-pause').onclick = () => { if (mode === 'playing') setPaused(true); };
$('btn-quit').onclick = () => {
  AudioSynth.uiClick();
  setPaused(false);
  if (playMode === 'multi') { try { net.close(); } catch (e) {} }
  playMode = 'solo';
  clearMulti();
  mode = 'home';
  $('hud').classList.remove('on');
  $('touch-ui').classList.remove('on');
  $('pause-menu').classList.add('hidden');
  $('screen-home').classList.add('active');
  try { document.exitPointerLock && document.exitPointerLock(); } catch (e) {}
};

function loadoutLocked() { return (matchElapsed - spawnStamp) < 5; }
function updateLoadoutLockUI() {
  const rem = Math.max(0, 5 - (matchElapsed - spawnStamp));
  const el = $('loadout-lock');
  if (rem > 0) {
    el.textContent = `LOADOUT LOCKED — available in ${Math.ceil(rem)}s`;
    el.classList.remove('free');
  } else {
    el.textContent = 'LOADOUT UNLOCKED — changing respawns you with the new weapon';
    el.classList.add('free');
  }
  document.querySelectorAll('#loadout-row2 .weapon-card').forEach((c) =>
    c.classList.toggle('locked', rem > 0));
}
document.querySelectorAll('#loadout-row2 .weapon-card').forEach((c) => {
  c.onclick = () => {
    AudioSynth.ensure();
    if (mode !== 'playing') return;
    if (loadoutLocked()) { AudioSynth.deny(); updateLoadoutLockUI(); return; }
    if (c.dataset.weapon === loadoutKey) return;
    AudioSynth.uiClick();
    loadoutKey = c.dataset.weapon;
    localStorage.setItem('blaze_loadout', loadoutKey);
    document.querySelectorAll('#loadout-row2 .weapon-card').forEach((x) =>
      x.classList.toggle('selected', x === c));
    document.querySelectorAll('#loadout-row .weapon-card').forEach((x) =>
      x.classList.toggle('selected', x.dataset.weapon === loadoutKey));
    respawnPlayer();
    addFeed(`<span class="vk">${escapeHtml(username)}</span> switched to ${WEAPONS[loadoutKey].name}`, true);
    updateLoadoutLockUI();
  };
});

/* ---- settings controls ---- */
function syncSettingsUI() {
  $('set-sens').value = Settings.sens;
  $('set-sens-val').textContent = Number(Settings.sens).toFixed(1);
  $('set-vol').value = Math.round(Settings.volume * 100);
  $('set-vol-val').textContent = Math.round(Settings.volume * 100);
  $('set-inverty').checked = !!Settings.invertY;
  $('set-cambob').checked = Settings.camBob !== false;
  document.querySelectorAll('#set-quality .segbtn').forEach((b) =>
    b.classList.toggle('selected', b.dataset.q === Quality.current));
}
$('set-sens').oninput = (e) => {
  Settings.sens = parseFloat(e.target.value);
  $('set-sens-val').textContent = Settings.sens.toFixed(1);
  saveSettings();
};
$('set-vol').oninput = (e) => {
  Settings.volume = parseInt(e.target.value, 10) / 100;
  $('set-vol-val').textContent = e.target.value;
  AudioSynth.ensure(); AudioSynth.setVolume(Settings.volume);
  saveSettings();
};
$('set-inverty').onchange = (e) => { Settings.invertY = e.target.checked; saveSettings(); AudioSynth.uiClick(); };
$('set-cambob').onchange = (e) => { Settings.camBob = e.target.checked; saveSettings(); AudioSynth.uiClick(); };
document.querySelectorAll('.qbtn').forEach((b) => {
  b.onclick = () => { AudioSynth.ensure(); AudioSynth.uiClick(); setQuality(b.dataset.q); };
});
document.querySelectorAll('#set-quality .segbtn').forEach((b) => {
  b.onclick = () => { AudioSynth.ensure(); AudioSynth.uiClick(); setQuality(b.dataset.q); };
});
syncSettingsUI();

/* ---- menus ---- */
$('username').value = username;
document.querySelectorAll('#loadout-row .weapon-card').forEach((c) => {
  c.classList.toggle('selected', c.dataset.weapon === loadoutKey);
  c.onclick = () => {
    AudioSynth.ensure(); AudioSynth.uiClick();
    loadoutKey = c.dataset.weapon;
    localStorage.setItem('blaze_loadout', loadoutKey);
    document.querySelectorAll('#loadout-row .weapon-card').forEach((x) => x.classList.toggle('selected', x === c));
    document.querySelectorAll('#loadout-row2 .weapon-card').forEach((x) => x.classList.toggle('selected', x.dataset.weapon === loadoutKey));
  };
});
document.querySelectorAll('#loadout-row2 .weapon-card').forEach((c) =>
  c.classList.toggle('selected', c.dataset.weapon === loadoutKey));
const MAP_NAMES = { sector: 'SECTOR 04', dolls: "DOLL'S YARD", harbor: 'TIDE DOCK' };
function updateDeployLabel() {
  $('btn-play').innerHTML = '&#9654;&nbsp; DEPLOY TO ' + (MAP_NAMES[mapKey] || 'SECTOR 04');
}
document.querySelectorAll('#map-row .map-card').forEach((c) => {
  c.classList.toggle('selected', c.dataset.map === mapKey);
  c.onclick = () => {
    AudioSynth.ensure(); AudioSynth.uiClick();
    setMapKey(c.dataset.map);
    localStorage.setItem('blaze_map', mapKey);
    document.querySelectorAll('#map-row .map-card').forEach((x) => x.classList.toggle('selected', x === c));
    updateDeployLabel();
  };
});
updateDeployLabel();
function validUsername(v) { return /^[A-Za-z0-9_]{1,16}$/.test(v); }
$('btn-play').onclick = async () => {
  AudioSynth.ensure(); AudioSynth.uiClick();
  if (!readUsername()) return;
  goFullscreen();
  try {
    if (IS_TOUCH && screen.orientation && screen.orientation.lock) {
      await screen.orientation.lock('landscape').catch(() => {});
    }
  } catch (e) { /* overlay covers it */ }
  startMatch();
};
$('btn-create').onclick = () => { AudioSynth.ensure(); AudioSynth.uiClick(); connectRoom(''); };
$('btn-join-room').onclick = () => {
  AudioSynth.ensure(); AudioSynth.uiClick();
  const code = $('room-code').value.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) { $('home-error').textContent = 'Room code is 6 characters A-Z / 0-9'; return; }
  $('room-code').value = code;
  connectRoom(code);
};
$('btn-again').onclick = () => {
  AudioSynth.uiClick();
  if (playMode === 'multi') { $('btn-home2').onclick(); return; }
  goFullscreen(); startMatch();
};
$('btn-home2').onclick = () => {
  AudioSynth.uiClick();
  if (playMode === 'multi') { try { net.close(); } catch (e) {} }
  playMode = 'solo';
  clearMulti();
  mode = 'home';
  $('screen-end').classList.remove('active');
  $('hud').classList.remove('on');
  $('touch-ui').classList.remove('on');
  $('screen-home').classList.add('active');
  try { document.exitPointerLock && document.exitPointerLock(); } catch (e) {}
};
function toggleMute() {
  AudioSynth.setMuted(!AudioSynth.muted);
  const ic = AudioSynth.muted ? '&#128263;' : '&#128266;';
  $('btn-mute').innerHTML = ic;
  $('btn-mute-home').innerHTML = ic;
}
$('btn-mute').onclick = () => { AudioSynth.ensure(); toggleMute(); };
$('btn-mute-home').onclick = () => { AudioSynth.ensure(); toggleMute(); };
$('btn-score').onclick = () => { AudioSynth.uiClick(); $('scoreboard').classList.toggle('hidden'); };
$('btn-gl-reload').onclick = () => location.reload();

/* ---- rotate overlay ---- */
function updateRotateOverlay() {
  const portrait = window.innerHeight > window.innerWidth;
  $('rotate-overlay').classList.toggle('on', IS_TOUCH && portrait && mode === 'playing');
}
window.addEventListener('resize', updateRotateOverlay);
window.addEventListener('orientationchange', () => setTimeout(updateRotateOverlay, 250));

/* ---- desktop lock hint ---- */
if (!IS_TOUCH) {
  const hint = document.createElement('div');
  hint.id = 'lock-hint';
  hint.className = 'hidden';
  hint.style.cssText = 'position:absolute;left:50%;top:58%;transform:translateX(-50%);background:rgba(0,0,0,.7);padding:10px 18px;border-radius:10px;font-size:13px;letter-spacing:2px;pointer-events:none;';
  hint.textContent = 'CLICK TO AIM';
  $('hud').appendChild(hint);
}

/* ================= ROBUSTNESS ================= */
let glLost = false;
canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  glLost = true;
  $('gl-overlay').classList.add('on');
});
canvas.addEventListener('webglcontextrestored', () => {
  glLost = false;
  $('gl-overlay').classList.remove('on');
  resize();
});
let tabHidden = false;
document.addEventListener('visibilitychange', () => { tabHidden = document.hidden; });


/* ================= MULTIPLAYER (Cloudflare Worker + Durable Objects) ================= */
const net = new Net();
let playMode = 'solo'; // 'solo' | 'multi'
let myId = null, roomCode = '', mySpawn = null, endsAt = 0;
const remotes = new Map(); // id -> { s, group, target, ry, hp, alive, name }
let stateAcc = 0, multiRespawnAt = 0;

function setMpBusy(busy) {
  const c = $('btn-create'), j = $('btn-join-room');
  if (c) { c.disabled = busy; c.innerHTML = busy ? 'CONNECTING&hellip;' : '&#9654;&nbsp; CREATE ROOM'; }
  if (j) j.disabled = busy;
}
function setWaiting(v) { $('waiting-chip').classList.toggle('hidden', !v); }
function readUsername() {
  const v = $('username').value.trim();
  if (!validUsername(v)) { $('home-error').textContent = 'Callsign: 1-16 chars, letters/numbers/_'; return null; }
  $('home-error').textContent = '';
  username = v;
  localStorage.setItem('blaze_username', v);
  return v;
}
async function connectRoom(room) {
  if (!readUsername()) return;
  setMpBusy(true);
  goFullscreen();
  try { if (IS_TOUCH && screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape').catch(() => {}); } catch (e) {}
  try {
    await net.connect(room, username, loadoutKey);
    net.join(room, username, loadoutKey);
  } catch (e) {
    setMpBusy(false);
    $('home-error').textContent = 'Could not reach the game server — check your connection and retry.';
  }
}
function spawnRemote(p) {
  if (remotes.has(p.id) || p.id === myId) return;
  const s = makeSoldier(p.username || 'SOLDIER', 'bot', p.loadout || 'rifle');
  s.hitbox.userData.playerId = p.id;
  const start = (p.p && p.p.length === 3) ? new THREE.Vector3(p.p[0], 0, p.p[2]) : new THREE.Vector3(0, 0, -20);
  s.group.position.copy(start);
  const aliveNow = p.alive !== false && (p.hp === undefined || p.hp > 0);
  s.group.visible = aliveNow;
  scene.add(s.group);
  remotes.set(p.id, { s, group: s.group, target: start.clone(), ry: p.ry || 0,
    hp: p.hp === undefined ? 100 : p.hp, alive: aliveNow, name: p.username || 'SOLDIER' });
}
const _rv = new THREE.Vector3();
function updateRemotes(dt, now) {
  const k = 1 - Math.exp(-12 * dt);
  for (const r of remotes.values()) {
    if (!r.alive) continue;
    _rv.copy(r.target).sub(r.group.position);
    const dist = Math.hypot(_rv.x, _rv.z);
    r.group.position.lerp(r.target, k);
    let d = r.ry - r.group.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    r.group.rotation.y += d * Math.min(1, dt * 10);
    const spd = dist / Math.max(dt, 1e-4);
    if (spd > 0.5) r.s.setWalk(dt, clamp(spd / 8, 0, 1));
    else r.s.idle(dt, now / 1000);
  }
}
function remoteShotFx(r) {
  r.s.parts.gunTip.getWorldPosition(_v1);
  const f = makeFlash(0.4);
  f.visible = true;
  f.position.copy(_v1);
  scene.add(f);
  setTimeout(() => { scene.remove(f); }, 60);
  _v2.set(-Math.sin(r.ry), 0, -Math.cos(r.ry));
  spawnTracer(_v1, _v2.multiplyScalar(25).add(_v1), 0xffc37a);
  AudioSynth.botShot(camera.position.distanceTo(_v1));
}
function multiDie() {
  if (!alive || matchOver) return;
  hp = 0; alive = false; firing = false;
  AudioSynth.death();
  $('death-overlay').classList.add('on');
  multiRespawnAt = performance.now() + 3500; // fallback if the server's respawn message is missed
}
function multiRespawn(p) {
  const pos = (p && p.length === 3) ? new THREE.Vector3(p[0], 0, p[2]) : mySpawn;
  respawnPlayer(pos);
  multiRespawnAt = 0;
}
function clearMulti() {
  for (const r of remotes.values()) scene.remove(r.group);
  remotes.clear();
  setWaiting(false);
}

net.on('joined', (m) => {
  myId = m.playerId; roomCode = m.roomCode; endsAt = m.endsAt || 0;
  mySpawn = new THREE.Vector3(m.spawn[0], 0, m.spawn[2]);
  playMode = 'multi';
  setMapKey('sector'); setMap('sector'); setBotUniform('combat');
  for (const b of bots) scene.remove(b.s.group);
  bots.length = 0;
  clearMulti();
  scores.clear();
  scores.set(myId, { name: username, kills: 0, deaths: 0, me: true });
  aiming = false; firing = false;
  matchOver = false; paused = false;
  matchElapsed = 0; stateAcc = 0; multiRespawnAt = 0;
  rlgl = null; dollHeadAnim = null;
  setBanner(null);
  if (playerFlash) scene.remove(playerFlash);
  playerFlash = makeFlash(0.5);
  scene.add(playerFlash);
  respawnPlayer(mySpawn);
  $('mode-chip').textContent = 'ROOM ' + roomCode;
  $('killfeed').innerHTML = '';
  $('scoreboard').classList.add('hidden');
  $('pause-menu').classList.add('hidden');
  $('screen-home').classList.remove('active');
  $('screen-end').classList.remove('active');
  $('hud').classList.add('on');
  if (IS_TOUCH) $('touch-ui').classList.add('on');
  setMpBusy(false);
  mode = 'playing';
  resize();
  measurePing();
  addFeed(`<span class="vk">${escapeHtml(username)}</span> joined ROOM <b>${escapeHtml(roomCode)}</b>`, true);
  setWaiting(m.solo === true);
});
net.on('players', (m) => {
  if (playMode !== 'multi') return;
  for (const p of m.players || []) {
    if (p.id === myId) continue;
    spawnRemote(p);
    scores.set(p.id, { name: p.username, kills: p.kills || 0, deaths: p.deaths || 0 });
  }
  renderScoreboard();
});
net.on('player-joined', (m) => {
  if (playMode !== 'multi') return;
  spawnRemote({ id: m.id, username: m.username, loadout: m.loadout, p: [0, 0, -24], ry: 0, hp: 100, alive: true });
  scores.set(m.id, { name: m.username, kills: 0, deaths: 0 });
  addFeed(`<span class="vk">${escapeHtml(m.username)}</span> joined the fight`, false);
  renderScoreboard();
});
net.on('player-left', (m) => {
  if (playMode !== 'multi') return;
  const r = remotes.get(m.id);
  if (r) { scene.remove(r.group); remotes.delete(m.id); }
  const s = scores.get(m.id);
  if (s) addFeed(`<span class="vv">${escapeHtml(s.name)}</span> left`, false);
  scores.delete(m.id);
  renderScoreboard();
});
net.on('player-state', (m) => {
  if (playMode !== 'multi') return;
  if (m.id === myId) {
    if (m.hp < hp) {
      AudioSynth.hurt();
      const dv = $('dmg-vignette');
      dv.style.opacity = '1';
      setTimeout(() => { dv.style.opacity = '0'; }, 140);
    }
    hp = m.hp;
    updateHealthHUD();
    if (hp > 0 && !alive) multiRespawn(m.p); // server respawned us
    return;
  }
  const r = remotes.get(m.id);
  if (!r) return;
  r.target.set(m.p[0], 0, m.p[2]);
  r.ry = m.ry; r.hp = m.hp;
  if (m.hp > 0 && !r.alive) { r.alive = true; r.group.visible = true; r.group.position.copy(r.target); }
  else if (m.hp <= 0 && r.alive) { r.alive = false; r.group.visible = false; }
});
net.on('shot', (m) => {
  if (playMode !== 'multi') return;
  const r = remotes.get(m.id);
  if (r && r.alive) remoteShotFx(r);
});
net.on('killed', (m) => {
  if (playMode !== 'multi') return;
  addFeed(`<span class="vk">${escapeHtml(m.killerName)}</span> &#9656; <span class="vv">${escapeHtml(m.victimName)}</span>`,
    m.killer === myId || m.victim === myId);
  if (m.killer === myId) {
    AudioSynth.kill();
    const s = scores.get(myId);
    if (s) { s.kills++; renderScoreboard(); }
  }
  if (m.victim === myId) {
    multiDie();
  } else {
    const r = remotes.get(m.victim);
    if (r) { r.alive = false; r.group.visible = false; }
    const s = scores.get(m.victim);
    if (s) { s.deaths++; renderScoreboard(); }
  }
});
net.on('respawn', (m) => {
  if (playMode !== 'multi' || m.id !== myId) return;
  multiRespawn(m.p);
});
net.on('scoreboard', (m) => {
  if (playMode !== 'multi' || !m.players) return;
  for (const p of m.players) {
    const s = scores.get(p.id) || {};
    s.name = p.username; s.kills = p.kills; s.deaths = p.deaths;
    if (p.id === myId) s.me = true;
    scores.set(p.id, s);
  }
  renderScoreboard();
});
net.on('solo', (m) => { if (playMode === 'multi') setWaiting(!!m.value); });
net.on('error', (m) => {
  const msg = m.message || 'Server error';
  setMpBusy(false);
  if (mode !== 'playing') $('home-error').textContent = msg;
  else addFeed(`<span class="vv">${escapeHtml(msg)}</span>`, false);
});
net.on('__close', () => {
  if (playMode !== 'multi') return;
  playMode = 'solo';
  clearMulti();
  mode = 'home';
  $('hud').classList.remove('on');
  $('touch-ui').classList.remove('on');
  $('pause-menu').classList.add('hidden');
  $('screen-end').classList.remove('active');
  $('screen-home').classList.add('active');
  setMpBusy(false);
  $('home-error').textContent = 'Disconnected from the game server.';
  try { document.exitPointerLock && document.exitPointerLock(); } catch (e) {}
});

/* ================= MAIN LOOP ================= */
const clock = new THREE.Clock();
function tick() {
  requestAnimationFrame(tick);
  if (tabHidden || glLost) return;
  const dt = Math.min(0.05, clock.getDelta());
  const now = performance.now();

  if (mode === 'playing') {
    if (paused) { updateLoadoutLockUI(); }
    else {
    matchElapsed += dt;
    updatePlayer(dt);
    if (playMode === 'multi') {
      updateRemotes(dt, now);
      stateAcc += dt;
      if (net.connected && stateAcc >= 1 / 15) {
        stateAcc = 0;
        net.state([+playerPos.x.toFixed(2), +playerPos.y.toFixed(2), +playerPos.z.toFixed(2)], +yaw.toFixed(3), Math.round(hp));
      }
      if (!alive && !matchOver && multiRespawnAt && now >= multiRespawnAt) {
        multiRespawnAt = 0;
        multiRespawn(mySpawn ? [mySpawn.x, 0, mySpawn.z] : null);
      }
    } else {
      for (const b of bots) updateBot(b, dt, now);
      if (mapKey === 'dolls') updateRLGL(dt);
      if (!alive && !matchOver && matchElapsed >= playerRespawnAt) respawnPlayer();
    }
    updateParticles(now, dt);
    for (const t of tracers) {
      if (t.line.visible) {
        t.line.material.opacity = Math.max(0, (t.until - now) / 70) * 0.9;
        if (now > t.until) t.line.visible = false;
      }
    }
    const remain = (playMode === 'multi' && endsAt)
      ? Math.max(0, (endsAt - Date.now()) / 1000)
      : Math.max(0, MATCH_LEN - matchElapsed);
    const mm = Math.floor(remain / 60), ss = Math.floor(remain % 60);
    $('timer').textContent = mm + ':' + String(ss).padStart(2, '0');
    $('timer').classList.toggle('low', remain < 60);
    updateRotateOverlay();
    if (remain <= 0) endMatch(null);
    }
  }
  renderer.render(scene, camera);
}
resize();
tick();

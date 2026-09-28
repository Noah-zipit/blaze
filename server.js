// Blaze — authoritative multiplayer server.
// Node.js + Express + ws. Serves the static client from public/ and runs the
// WebSocket game protocol. The server is the authority on player list, health,
// kills/deaths, respawns and room membership.

const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT || '3000', 10);
const MAX_PLAYERS = 3;          // 2-3 player rooms (+1 slot: room holds max 3)
const ARENA_BOUND = 28;         // playable half-extent, clients mirror this
const MAX_HIT_DIST = 60;        // anti-cheat: hits must be within this range
const RESPAWN_DELAY_MS = 3000;
const ROOM_TTL_MS = 5 * 60 * 1000;   // empty rooms are swept after 5 minutes
const RATE_LIMIT_PER_SEC = 40;  // per-socket message rate limit
const MAX_PAYLOAD_BYTES = 4096;
const MATCH_DURATION_MS = 5 * 60 * 1000;

const LOADOUTS = new Set(['rifle', 'smg', 'sniper']);
const ROOM_CODE_RE = /^[A-Z0-9]{6}$/;
const USERNAME_RE = /^[A-Za-z0-9_]{1,16}$/;

// Four corner spawn points (y=0 ground level).
const SPAWNS = [
  [-20, 0, -20],
  [20, 0, -20],
  [-20, 0, 20],
  [20, 0, 20],
];

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const startedAt = Date.now();
const rooms = new Map(); // code -> room

// room = { code, players: Map<playerId, player>, createdAt, lastActive, endsAt, spawnIdx }
// player = { id, username, loadout, ws, p:[x,y,z], ry, hp, alive, kills, deaths, msgTimes:[] }

app.get('/health', (req, res) => {
  let players = 0;
  for (const room of rooms.values()) players += room.players.size;
  res.json({
    ok: true,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    rooms: rooms.size,
    players,
  });
});

const server = http.createServer(app);
// Note: constructed without a `path` filter, so the ws server accepts
// upgrades on every path — both `/` (legacy client) and `/ws` (the route
// the Cloudflare Workers backend uses). Local dev works with the same
// client either way.
const wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD_BYTES + 64 });

let nextPlayerId = 1;

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous I/1/O/0
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function send(ws, type, data = {}) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ type, ...data }));
}

function roomSnapshot(room) {
  return [...room.players.values()].map((p) => ({
    id: p.id,
    username: p.username,
    loadout: p.loadout,
    p: p.p,
    ry: p.ry,
    hp: p.hp,
    alive: p.alive,
    kills: p.kills,
    deaths: p.deaths,
  }));
}

function broadcast(room, type, data = {}, exceptId = null) {
  for (const p of room.players.values()) {
    if (p.id !== exceptId) send(p.ws, type, data);
  }
}

function broadcastScoreboard(room) {
  broadcast(room, 'scoreboard', {
    players: [...room.players.values()].map((p) => ({
      id: p.id, username: p.username, kills: p.kills, deaths: p.deaths,
    })),
  });
}

function broadcastSolo(room) {
  // Solo practice mode when exactly one player is in the room.
  broadcast(room, 'solo', { value: room.players.size === 1 });
}

function clampPos(p) {
  const c = (v) => Math.max(-ARENA_BOUND, Math.min(ARENA_BOUND, Number.isFinite(v) ? v : 0));
  return [c(p[0]), 0, c(p[2])]; // server pins y to ground plane
}

function dist3(a, b) {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function nextSpawn(room) {
  const s = SPAWNS[room.spawnIdx % SPAWNS.length];
  room.spawnIdx += 1;
  return [...s];
}

function removePlayer(room, player, reason) {
  if (!room.players.has(player.id)) return;
  room.players.delete(player.id);
  player.ws.__blazePlayer = null;
  console.log(`[leave] ${player.username} (${player.id}) left room ${room.code}${reason ? ' — ' + reason : ''}`);
  broadcast(room, 'player-left', { id: player.id });
  broadcastScoreboard(room);
  broadcastSolo(room);
  if (room.players.size === 0) room.lastActive = Date.now(); // starts TTL clock
}

function handleJoin(ws, msg) {
  if (ws.__blazePlayer) return send(ws, 'error', { message: 'Already in a room' });

  const username = String(msg.username || '');
  const loadout = String(msg.loadout || 'rifle');
  if (!USERNAME_RE.test(username)) return send(ws, 'error', { message: 'Username must be 1-16 chars: letters, numbers, underscore' });
  if (!LOADOUTS.has(loadout)) return send(ws, 'error', { message: 'Unknown loadout' });

  let room;
  const requested = String(msg.room || '').toUpperCase();
  if (requested) {
    if (!ROOM_CODE_RE.test(requested)) return send(ws, 'error', { message: 'Room code must be 6 characters A-Z/0-9' });
    room = rooms.get(requested);
    if (!room) return send(ws, 'error', { message: 'Room not found' });
  } else {
    // Create a fresh room.
    const code = makeRoomCode();
    room = {
      code,
      players: new Map(),
      createdAt: Date.now(),
      lastActive: Date.now(),
      endsAt: Date.now() + MATCH_DURATION_MS,
      spawnIdx: 0,
    };
    rooms.set(code, room);
  }

  if (room.players.size >= MAX_PLAYERS) {
    return send(ws, 'error', { message: 'Room is full' });
  }

  // Rematch into an expired room: restart the 5-minute clock.
  if (room.endsAt < Date.now()) room.endsAt = Date.now() + MATCH_DURATION_MS;

  const id = 'p' + (nextPlayerId++);
  const player = {
    id,
    username,
    loadout,
    ws,
    p: nextSpawn(room),
    ry: 0,
    hp: 100,
    alive: true,
    kills: 0,
    deaths: 0,
    msgTimes: [],
  };
  room.players.set(id, player);
  room.lastActive = Date.now();
  ws.__blazePlayer = { room, player };

  console.log(`[join] ${username} (${id}) joined room ${room.code} [${room.players.size}/${MAX_PLAYERS}]`);

  send(ws, 'joined', {
    playerId: id,
    roomCode: room.code,
    solo: room.players.size === 1,
    spawn: player.p,
    endsAt: room.endsAt,
  });
  send(ws, 'players', { players: roomSnapshot(room) });
  broadcastScoreboard(room);
  broadcast(room, 'player-joined', { id, username, loadout }, id);
  broadcastSolo(room);
}

function handleState(ws, msg) {
  const { room, player } = ws.__blazePlayer;
  if (!player.alive) return; // dead players don't move
  const p = msg.p;
  if (!Array.isArray(p) || p.length !== 3) return;
  player.p = clampPos(p);
  const ry = Number(msg.ry);
  player.ry = Number.isFinite(ry) ? ry : player.ry;
  room.lastActive = Date.now();
  // Relay to everyone else (hp is authoritative via damage handling).
  broadcast(room, 'player-state', { id: player.id, p: player.p, ry: player.ry, hp: player.hp }, player.id);
}

function handleShoot(ws) {
  const { room, player } = ws.__blazePlayer;
  broadcast(room, 'shot', { id: player.id }, player.id); // tracers + audio for others
}

function handleHit(ws, msg) {
  const { room, player: shooter } = ws.__blazePlayer;
  const target = room.players.get(String(msg.targetId));
  const damage = Number(msg.damage);
  if (!target || !Number.isFinite(damage) || damage <= 0 || damage > 100) return;
  if (!target.alive || target.id === shooter.id) return;
  // Anti-cheat: target must be reasonably close to the shooter.
  if (dist3(shooter.p, target.p) > MAX_HIT_DIST) return;

  target.hp = Math.max(0, target.hp - Math.round(damage));
  room.lastActive = Date.now();

  if (target.hp <= 0) {
    target.alive = false;
    target.deaths += 1;
    shooter.kills += 1;
    console.log(`[kill] ${shooter.username} killed ${target.username} in ${room.code}`);
    broadcast(room, 'killed', { killer: shooter.id, victim: target.id, killerName: shooter.username, victimName: target.username });
    broadcastScoreboard(room);
    // Respawn after a short delay at the next spawn point.
    setTimeout(() => {
      if (!rooms.get(room.code) || !room.players.get(target.id)) return;
      target.hp = 100;
      target.alive = true;
      target.p = nextSpawn(room);
      send(target.ws, 'respawn', { id: target.id, p: target.p });
      broadcast(room, 'player-state', { id: target.id, p: target.p, ry: target.ry, hp: target.hp });
    }, RESPAWN_DELAY_MS);
  } else {
    // Push the authoritative hp to the whole room (victim's bar + shooter's hitmarker).
    broadcast(room, 'player-state', { id: target.id, p: target.p, ry: target.ry, hp: target.hp });
  }
}

function checkRateLimit(player) {
  const now = Date.now();
  player.msgTimes = player.msgTimes.filter((t) => now - t < 1000);
  player.msgTimes.push(now);
  return player.msgTimes.length <= RATE_LIMIT_PER_SEC;
}

wss.on('connection', (ws) => {
  ws.__blazePlayer = null;
  ws.__msgBytes = 0;

  ws.on('message', (data) => {
    // Hard payload cap (ws maxPayload is a backstop; this gives a clean drop).
    const bytes = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(String(data));
    if (bytes > MAX_PAYLOAD_BYTES) return;

    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    // Only `join` is allowed before joining a room.
    if (msg.type !== 'join') {
      if (!ws.__blazePlayer) return;
      if (!checkRateLimit(ws.__blazePlayer.player)) return; // drop excess silently
    }

    switch (msg.type) {
      case 'join': handleJoin(ws, msg); break;
      case 'state': handleState(ws, msg); break;
      case 'shoot': handleShoot(ws); break;
      case 'hit': handleHit(ws, msg); break;
      case 'leave': {
        const ctx = ws.__blazePlayer;
        if (ctx) removePlayer(ctx.room, ctx.player, 'left');
        break;
      }
      default: break; // ignore unknown types
    }
  });

  ws.on('close', () => {
    const ctx = ws.__blazePlayer;
    if (ctx) removePlayer(ctx.room, ctx.player, 'disconnected');
  });

  ws.on('error', () => { /* socket-level errors are handled via close */ });
});

// Sweep empty rooms every minute.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.players.size === 0 && now - room.lastActive > ROOM_TTL_MS) {
      rooms.delete(code);
      console.log(`[room] expired empty room ${code}`);
    }
  }
}, 60 * 1000);

server.listen(PORT, () => {
  console.log(`Blaze server listening on :${PORT}`);
});

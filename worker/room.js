// worker/room.js — Blaze game logic on Cloudflare Durable Objects.
//
// One GameRoom DO instance exists per 6-character room code. This is a
// faithful port of server.js (Node + Express + ws): the JSON WebSocket
// protocol is identical, so the existing client works unchanged.
//
// Design notes:
// - WebSocket Hibernation API (acceptWebSocket / webSocketMessage /
//   webSocketClose): idle rooms cost nothing while sockets stay open.
// - The player roster (ids, usernames, loadouts, hp, alive, kills, deaths,
//   respawn timers, room timers) is persisted to the DO's SQLite storage, so
//   a room survives isolate eviction mid-match. Per-frame positions are kept
//   in memory only — clients re-send state at ~20Hz, self-healing within a
//   tick of a wake. Roster writes are throttled to one storage put per 5s for
//   positions, plus immediate writes on join/leave/hit/kill/respawn.
// - setTimeout does NOT survive eviction, so respawns and empty-room cleanup
//   run through a single durable alarm (earliest due event wins).

const MAX_PLAYERS = 3;          // 2-3 player rooms
const ARENA_BOUND = 28;         // playable half-extent, clients mirror this
const MAX_HIT_DIST = 60;        // anti-cheat: hits must be within this range
const RESPAWN_DELAY_MS = 3000;
const ROOM_TTL_MS = 5 * 60 * 1000;   // empty rooms are swept after 5 minutes
const RATE_LIMIT_PER_SEC = 40;  // per-socket message rate limit
const MAX_PAYLOAD_BYTES = 4096;
const MATCH_DURATION_MS = 5 * 60 * 1000;
const POS_PERSIST_MS = 5000;    // throttle for persisting positions

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

function randomHex(n) {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function clampPos(p) {
  const c = (v) => Math.max(-ARENA_BOUND, Math.min(ARENA_BOUND, Number.isFinite(v) ? v : 0));
  return [c(p[0]), 0, c(p[2])]; // server pins y to ground plane
}

function dist3(a, b) {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function byteLength(s) {
  return new TextEncoder().encode(s).length;
}

// ---------------------------------------------------------------------------
// GameRoom — one instance per room code.
// ---------------------------------------------------------------------------
export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.code = null;
    this.room = null;            // { code, createdAt, lastActive, endsAt, spawnIdx }
    this.players = new Map();    // pid -> player (in-memory view of persisted roster)
    this.sockets = new Map();    // pid -> WebSocket (rebuilt after eviction)
    this.lastRosterPersist = 0;

    // Load persisted roster; block all events until it is done.
    state.blockConcurrencyWhile(async () => {
      const storedRoom = await state.storage.get('room');
      if (!storedRoom) return;
      this.room = storedRoom;
      const storedPlayers = (await state.storage.get('players')) || [];
      for (const sp of storedPlayers) {
        this.players.set(sp.id, { ...sp, ws: null, msgTimes: [] });
      }
      // Reattach hibernated sockets via their persisted tags.
      for (const ws of state.getWebSockets()) {
        const pid = pidFromTags(state.getTags(ws));
        if (!pid) continue;
        this.sockets.set(pid, ws);
        const pl = this.players.get(pid);
        if (pl) pl.ws = ws;
      }
      await this.scheduleAlarm();
    });
  }

  // -- entry: WebSocket upgrade ------------------------------------------------
  async fetch(request) {
    const url = new URL(request.url);
    const code = (url.searchParams.get('room') || '').toUpperCase();
    if (!ROOM_CODE_RE.test(code)) return new Response('Bad room code', { status: 400 });
    this.code = code;
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // Player id is minted at upgrade time so the socket carries it as a tag;
    // tags survive eviction, letting us reattach sockets to players on wake.
    const pid = 'p' + randomHex(8);
    this.state.acceptWebSocket(server, ['pid:' + pid]);
    return new Response(null, { status: 101, webSocket: client });
  }

  // -- hibernation handlers ----------------------------------------------------
  async webSocketMessage(ws, message) {
    if (typeof message !== 'string') return;
    if (byteLength(message) > MAX_PAYLOAD_BYTES) return; // hard payload cap
    let msg;
    try { msg = JSON.parse(message); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    const pid = pidFromTags(this.state.getTags(ws));
    if (!pid) return;
    this.sockets.set(pid, ws);
    const player = this.players.get(pid) || null;

    // Only `join` is allowed before joining a room.
    if (msg.type !== 'join') {
      if (!player) return;
      if (!this.checkRateLimit(player)) return; // drop excess silently
    }

    switch (msg.type) {
      case 'join': await this.handleJoin(ws, pid, msg); break;
      case 'state': this.handleState(player, msg); break;
      case 'shoot': this.handleShoot(player); break;
      case 'hit': await this.handleHit(player, msg); break;
      case 'leave': await this.removePlayer(pid, 'left'); break;
      default: break; // ignore unknown types
    }
  }

  async webSocketClose(ws) {
    const pid = pidFromTags(this.state.getTags(ws)) || revLookup(this.sockets, ws);
    if (pid && this.players.has(pid)) await this.removePlayer(pid, 'disconnected');
  }

  async webSocketError(ws) {
    // Treat socket errors like closes; the close handler also runs.
    const pid = pidFromTags(this.state.getTags(ws)) || revLookup(this.sockets, ws);
    if (pid && this.players.has(pid)) await this.removePlayer(pid, 'socket error');
  }

  async alarm() {
    const now = Date.now();
    let changed = false;
    for (const p of this.players.values()) {
      if (!p.alive && p.respawnAt && p.respawnAt <= now) {
        p.hp = 100;
        p.alive = true;
        p.respawnAt = 0;
        p.p = this.nextSpawn();
        this.sendTo(p, 'respawn', { id: p.id, p: p.p });
        this.broadcast('player-state', { id: p.id, p: p.p, ry: p.ry, hp: p.hp });
        changed = true;
      }
    }
    if (changed) await this.persist();

    // Sweep the room once it has been empty past its TTL.
    if (this.players.size === 0 && this.room && now - this.room.lastActive > ROOM_TTL_MS) {
      await this.state.storage.deleteAll();
      this.room = null;
      this.players.clear();
      this.sockets.clear();
      return;
    }
    await this.scheduleAlarm();
  }

  // -- game handlers (mirror server.js) ----------------------------------------
  async handleJoin(ws, pid, msg) {
    if (this.players.has(pid)) {
      return this.sendRaw(ws, 'error', { message: 'Already in a room' });
    }
    const username = String(msg.username || '');
    const loadout = String(msg.loadout || 'rifle');
    if (!USERNAME_RE.test(username)) {
      return this.sendRaw(ws, 'error', { message: 'Username must be 1-16 chars: letters, numbers, underscore' });
    }
    if (!LOADOUTS.has(loadout)) {
      return this.sendRaw(ws, 'error', { message: 'Unknown loadout' });
    }

    const requested = String(msg.room || '').toUpperCase();
    if (requested && !ROOM_CODE_RE.test(requested)) {
      return this.sendRaw(ws, 'error', { message: 'Room code must be 6 characters A-Z/0-9' });
    }
    if (requested && requested !== this.code) {
      return this.sendRaw(ws, 'error', { message: 'Room mismatch' });
    }

    if (!requested) {
      // Creating: the worker generated this.code and routed here. Refuse if
      // this DO is already hosting a live (or recently live) room — the
      // client can simply create again for a fresh code.
      if (this.room && (this.players.size > 0 || Date.now() - this.room.lastActive < ROOM_TTL_MS)) {
        this.sendRaw(ws, 'error', { message: 'Room code collision — please try creating again' });
        try { ws.close(1011, 'collision'); } catch { /* noop */ }
        return;
      }
      this.room = {
        code: this.code,
        createdAt: Date.now(),
        lastActive: Date.now(),
        endsAt: Date.now() + MATCH_DURATION_MS,
        spawnIdx: 0,
      };
    } else if (!this.room) {
      return this.sendRaw(ws, 'error', { message: 'Room not found' });
    }

    const room = this.room;
    if (this.players.size >= MAX_PLAYERS) {
      return this.sendRaw(ws, 'error', { message: 'Room is full' });
    }

    // Rematch into an expired room: restart the 5-minute clock.
    if (room.endsAt < Date.now()) room.endsAt = Date.now() + MATCH_DURATION_MS;

    const player = {
      id: pid,
      username,
      loadout,
      ws,
      p: this.nextSpawn(),
      ry: 0,
      hp: 100,
      alive: true,
      kills: 0,
      deaths: 0,
      respawnAt: 0,
      msgTimes: [],
    };
    this.players.set(pid, player);
    this.sockets.set(pid, ws);
    room.lastActive = Date.now();
    await this.persist();
    this.report();

    this.sendTo(player, 'joined', {
      playerId: pid,
      roomCode: room.code,
      solo: this.players.size === 1,
      spawn: player.p,
      endsAt: room.endsAt,
    });
    this.sendTo(player, 'players', { players: this.snapshot() });
    this.broadcastScoreboard();
    this.broadcast('player-joined', { id: pid, username, loadout }, pid);
    this.broadcastSolo();
    await this.scheduleAlarm();
  }

  handleState(player, msg) {
    if (!player || !player.alive) return; // dead players don't move
    const p = msg.p;
    if (!Array.isArray(p) || p.length !== 3) return;
    player.p = clampPos(p);
    const ry = Number(msg.ry);
    player.ry = Number.isFinite(ry) ? ry : player.ry;
    this.room.lastActive = Date.now();
    this.maybePersistPositions();
    // Relay to everyone else (hp is authoritative via damage handling).
    this.broadcast('player-state', { id: player.id, p: player.p, ry: player.ry, hp: player.hp }, player.id);
  }

  handleShoot(player) {
    if (!player) return;
    this.broadcast('shot', { id: player.id }, player.id); // tracers + audio for others
  }

  async handleHit(player, msg) {
    if (!player) return;
    const shooter = player;
    const target = this.players.get(String(msg.targetId));
    const damage = Number(msg.damage);
    if (!target || !Number.isFinite(damage) || damage <= 0 || damage > 100) return;
    if (!target.alive || target.id === shooter.id) return;
    // Anti-cheat: target must be reasonably close to the shooter.
    if (dist3(shooter.p, target.p) > MAX_HIT_DIST) return;

    target.hp = Math.max(0, target.hp - Math.round(damage));
    this.room.lastActive = Date.now();

    if (target.hp <= 0) {
      target.alive = false;
      target.deaths += 1;
      shooter.kills += 1;
      target.respawnAt = Date.now() + RESPAWN_DELAY_MS;
      this.broadcast('killed', {
        killer: shooter.id, victim: target.id,
        killerName: shooter.username, victimName: target.username,
      });
      this.broadcastScoreboard();
      await this.persist();
      await this.scheduleAlarm();
    } else {
      // Push the authoritative hp to the whole room (victim's bar + shooter's hitmarker).
      this.broadcast('player-state', { id: target.id, p: target.p, ry: target.ry, hp: target.hp });
      await this.persist();
    }
  }

  async removePlayer(pid, reason) {
    const player = this.players.get(pid);
    if (!player) return;
    this.players.delete(pid);
    this.sockets.delete(pid);
    if (this.room) this.room.lastActive = Date.now(); // starts TTL clock when empty
    await this.persist();
    this.report();
    this.broadcast('player-left', { id: pid });
    this.broadcastScoreboard();
    this.broadcastSolo();
    await this.scheduleAlarm();
  }

  // -- helpers -----------------------------------------------------------------
  nextSpawn() {
    const s = SPAWNS[this.room.spawnIdx % SPAWNS.length];
    this.room.spawnIdx += 1;
    return [...s];
  }

  snapshot() {
    return [...this.players.values()].map((p) => ({
      id: p.id, username: p.username, loadout: p.loadout,
      p: p.p, ry: p.ry, hp: p.hp, alive: p.alive,
      kills: p.kills, deaths: p.deaths,
    }));
  }

  sendRaw(ws, type, data = {}) {
    try {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type, ...data }));
    } catch { /* closed socket */ }
  }

  sendTo(player, type, data = {}) {
    const ws = (player && player.ws) || this.sockets.get(player && player.id);
    if (ws) this.sendRaw(ws, type, data);
  }

  broadcast(type, data = {}, exceptId = null) {
    for (const p of this.players.values()) {
      if (p.id !== exceptId) this.sendTo(p, type, data);
    }
  }

  broadcastScoreboard() {
    this.broadcast('scoreboard', {
      players: [...this.players.values()].map((p) => ({
        id: p.id, username: p.username, kills: p.kills, deaths: p.deaths,
      })),
    });
  }

  broadcastSolo() {
    // Solo practice mode when exactly one player is in the room.
    this.broadcast('solo', { value: this.players.size === 1 });
  }

  checkRateLimit(player) {
    const now = Date.now();
    player.msgTimes = player.msgTimes.filter((t) => now - t < 1000);
    player.msgTimes.push(now);
    return player.msgTimes.length <= RATE_LIMIT_PER_SEC;
  }

  async persist() {
    if (!this.room) return;
    const players = [...this.players.values()].map((p) => ({
      id: p.id, username: p.username, loadout: p.loadout,
      p: p.p, ry: p.ry, hp: p.hp, alive: p.alive,
      kills: p.kills, deaths: p.deaths, respawnAt: p.respawnAt || 0,
    }));
    await this.state.storage.put({ room: this.room, players });
    this.lastRosterPersist = Date.now();
  }

  maybePersistPositions() {
    // Positions change at ~20Hz; persisting every tick would be wasteful.
    // One roster write per 5s bounds staleness after an eviction, and the
    // client's next state message self-heals positions immediately anyway.
    if (Date.now() - this.lastRosterPersist > POS_PERSIST_MS) {
      this.state.waitUntil(this.persist().catch(() => {}));
    }
  }

  async scheduleAlarm() {
    // Single durable alarm for the earliest due event: a respawn, or the
    // empty-room sweep. setTimeout would not survive isolate eviction.
    const now = Date.now();
    let at = 0;
    for (const p of this.players.values()) {
      if (!p.alive && p.respawnAt > now && (at === 0 || p.respawnAt < at)) at = p.respawnAt;
    }
    if (this.players.size === 0 && this.room) {
      const cleanupAt = this.room.lastActive + ROOM_TTL_MS;
      if (at === 0 || cleanupAt < at) at = cleanupAt;
    }
    if (at > 0) await this.state.storage.setAlarm(at);
    else {
      try { await this.state.storage.deleteAlarm(); } catch { /* no alarm set */ }
    }
  }

  report() {
    // Best-effort player-count report to the registry DO (powers /health).
    try {
      const stub = this.env.ROOM_REGISTRY.get(this.env.ROOM_REGISTRY.idFromName('registry'));
      this.state.waitUntil(
        stub.fetch('https://registry/report', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: this.code, players: this.players.size }),
        }).catch(() => {})
      );
    } catch { /* registry unreachable: /health degrades to zeros */ }
  }
}

function pidFromTags(tags) {
  const t = (tags || []).find((x) => typeof x === 'string' && x.startsWith('pid:'));
  return t ? t.slice(4) : null;
}

function revLookup(map, ws) {
  for (const [k, v] of map) if (v === ws) return k;
  return null;
}

// ---------------------------------------------------------------------------
// RoomRegistry — singleton DO behind GET /health.
// Tracks per-room player counts reported by GameRoom instances. Entries are
// persisted and pruned when stale, so the numbers are honest best-effort.
// ---------------------------------------------------------------------------
const REGISTRY_STALE_MS = 10 * 60 * 1000;

export class RoomRegistry {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/report' && request.method === 'POST') {
      let body = null;
      try { body = await request.json(); } catch { /* ignore */ }
      if (body && typeof body.code === 'string' && Number.isFinite(body.players)) {
        await this.state.storage.put('room:' + body.code, {
          players: Math.max(0, Math.floor(body.players)),
          updatedAt: Date.now(),
        });
      }
      return new Response('ok');
    }
    if (url.pathname === '/stats' && request.method === 'GET') {
      const entries = await this.state.storage.list({ prefix: 'room:' });
      const now = Date.now();
      let rooms = 0, players = 0;
      const stale = [];
      for (const [key, v] of entries) {
        if (!v || now - v.updatedAt > REGISTRY_STALE_MS) { stale.push(key); continue; }
        rooms += 1;
        players += v.players;
      }
      if (stale.length) await this.state.storage.delete(stale);
      return Response.json({ rooms, players });
    }
    return new Response('not found', { status: 404 });
  }
}

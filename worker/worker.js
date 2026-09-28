// worker/worker.js — Blaze Cloudflare Worker entry point.
//
// - Serves the static client from public/ via Workers Static Assets.
// - Routes WebSocket upgrades at /ws?room=CODE to the GameRoom Durable
//   Object for that room (empty room= → a fresh 6-char code is generated).
// - GET /health → { ok, uptimeSeconds, rooms, players } (counts come from
//   the RoomRegistry singleton DO; uptime is per worker isolate).
//
// The Durable Object classes must be re-exported from the entrypoint for
// wrangler to register them.

import { GameRoom, RoomRegistry } from './room.js';

export { GameRoom, RoomRegistry };

const ROOM_CODE_RE = /^[A-Z0-9]{6}$/;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous I/1/O/0

// NOTE: workerd evaluates the module with a zeroed clock, so Date.now()
// at module scope is 0 — startedAt is captured lazily on the first request.
let startedAt = 0;

function makeRoomCode() {
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      if (startedAt === 0) startedAt = Date.now();
      let rooms = 0;
      let players = 0;
      try {
        const reg = env.ROOM_REGISTRY.get(env.ROOM_REGISTRY.idFromName('registry'));
        const res = await reg.fetch('https://registry/stats');
        if (res.ok) ({ rooms, players } = await res.json());
      } catch {
        // Registry unreachable: degrade gracefully, still report liveness.
      }
      return Response.json({
        ok: true,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        rooms,
        players,
      });
    }

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }
      let code = (url.searchParams.get('room') || '').toUpperCase();
      if (!code) code = makeRoomCode(); // create: mint the code, then route by it
      if (!ROOM_CODE_RE.test(code)) return new Response('Bad room code', { status: 400 });
      const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(code));
      // Forward to the room's DO, telling it which code it owns.
      const doUrl = new URL(request.url);
      doUrl.searchParams.set('room', code);
      return stub.fetch(new Request(doUrl, request));
    }

    // Everything else: the static game client.
    return env.ASSETS.fetch(request);
  },
};

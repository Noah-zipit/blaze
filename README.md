# 🔥 Blaze

A fast, mobile-first **2–3 player browser FPS**. Create a room, share the 6-character
code, pick a loadout, and fight in an industrial arena. No downloads, no accounts.

- **Server:** Node.js + Express + `ws` (authoritative: player list, health, kills, respawns)
- **Client:** Three.js (pinned CDN), 100% synthesized Web Audio SFX, touch + desktop controls
- **Modes:** 2–3 player rooms · solo practice mode with target dummies when alone

## Run locally

```bash
npm install
node server.js        # or: PORT=4000 node server.js
```

Open http://localhost:3000 — create a room on one device, join with the code on another
(same Wi-Fi: use your machine's LAN IP instead of `localhost`).

`GET /health` → `{ ok, uptimeSeconds, rooms, players }`.

## Deploy on Render (free)

1. Push this repo to GitHub.
2. Render Dashboard → **New +** → **Web Service** → select the repo
   (or **New from Blueprint** — `render.yaml` is included).
3. Settings: Runtime `Node`, Build Command `npm install`, Start Command `node server.js`.
4. Deploy — the service gets a public `https://…onrender.com` URL. Share it; no domain
   purchase needed.

> Note: Render's free tier now requires a credit card on file (a $1 temporary
> authorization) before it will deploy anything — even on the $0 plan. If you
> don't have a card, use the Cloudflare option below instead.

## Deploy on Cloudflare (free, no card, never sleeps) — recommended

The game also runs on Cloudflare Workers + Durable Objects: one `GameRoom` DO
per room code, WebSocket hibernation so idle rooms cost nothing, and the
player roster persisted to the DO's SQLite storage so rooms survive isolate
eviction. Workers never sleep, so **no keep-warm ping is needed**. The JSON
protocol is identical to the Node server, and the client auto-connects to
`/ws` on the same host — no client changes needed between backends.

```bash
npm install -g wrangler   # or: npx wrangler
wrangler login            # opens Cloudflare in your browser (free account, no card)
npx wrangler deploy       # deploys worker + DOs, prints your URL
```

You get a free `https://blaze.<your-account>.workers.dev` URL. Verify it:

```bash
curl https://blaze.<your-account>.workers.dev/health
# {"ok":true,"uptimeSeconds":12,"rooms":0,"players":0}
```

Local dev mirrors production (DOs, hibernation, static assets):

```bash
npx wrangler dev --port 8787
```

What lives where: `worker/worker.js` routes `/ws?room=CODE` to the room's DO
(minting a fresh 6-char code when `room` is empty) and serves `public/` as
static assets; `worker/room.js` holds the `GameRoom` DO (full server.js game
logic: player list, health, kills/deaths, 3s respawns via durable alarms,
3-player cap, rate limiting, hit validation, solo mode) plus a tiny
`RoomRegistry` DO that powers the `rooms`/`players` counts on `/health`.
`wrangler.toml` wires it together (`[assets]` → `public`).

## Game protocol (WebSocket, JSON)

Client → server:

| type    | payload                              |
| ------- | ------------------------------------ |
| `join`  | `{ room, username, loadout }` (`room: ""` creates) |
| `state` | `{ p: [x,y,z], ry, hp }` (~20Hz)     |
| `shoot` | `{}`                                 |
| `hit`   | `{ targetId, damage }`               |
| `leave` | `{}`                                 |

Server → client: `joined`, `players`, `player-joined`, `player-left`,
`player-state`, `shot`, `killed`, `respawn`, `scoreboard`, `solo`, `error`.

Server-side guards: 3 players max per room, usernames `1–16` chars `[A-Za-z0-9_]`,
positions clamped to ±28, ~40 msgs/sec per-socket rate limit, 4KB payload cap,
hits validated (target alive, ≤60 units away), empty rooms expire after 5 minutes.

## Project layout

```
server.js            authoritative game server + static file host
public/
  index.html         menus, HUD, overlays (Blaze logo is inline SVG)
  css/style.css      mobile-first ember-on-black theme
  js/
    main.js          game orchestration, input, shooting, match flow
    net.js           WebSocket client
    world.js         arena, soldiers, dummies
    audio.js         synthesized SFX (Web Audio, no files)
render.yaml          Render blueprint (free web service — needs a card on file)
wrangler.toml        Cloudflare Workers config (free, no card): worker + DOs + static assets
worker/
  worker.js          Cloudflare Worker entry: /health, /ws routing, static assets
  room.js            GameRoom Durable Object (full game logic) + RoomRegistry DO
.env.example         PORT only
```

## License

MIT

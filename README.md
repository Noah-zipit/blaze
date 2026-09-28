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

> Note: Render's free tier sleeps after inactivity — the first load of the day takes
> ~30s to wake up. The client shows a "Connecting…" state meanwhile.

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
render.yaml          Render blueprint (free web service)
.env.example         PORT only
```

## License

MIT

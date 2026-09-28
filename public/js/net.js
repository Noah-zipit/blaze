// Blaze Net — thin WebSocket client wrapping the server game protocol.
// All messages are JSON: { type, ...payload }.

export class Net {
  constructor() {
    this.ws = null;
    this.handlers = new Map(); // type -> Set<fn>
    this.connected = false;
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.handlers.get(type).delete(fn);
  }

  emit(type, data) {
    const set = this.handlers.get(type);
    if (set) for (const fn of set) { try { fn(data); } catch (e) { console.error('[net] handler error', e); } }
  }

  connect() {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${location.host}`);
      const timeout = setTimeout(() => { ws.close(); reject(new Error('connect timeout')); }, 8000);
      ws.onopen = () => { clearTimeout(timeout); this.connected = true; resolve(); };
      ws.onerror = () => { clearTimeout(timeout); reject(new Error('websocket error')); };
      ws.onclose = () => { this.connected = false; this.emit('__close', {}); };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg && typeof msg.type === 'string') this.emit(msg.type, msg);
      };
      this.ws = ws;
    });
  }

  send(type, data = {}) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, ...data }));
    }
  }

  join(room, username, loadout) { this.send('join', { room, username, loadout }); }
  state(p, ry, hp) { this.send('state', { p, ry, hp }); }
  shoot() { this.send('shoot', {}); }
  hit(targetId, damage) { this.send('hit', { targetId, damage }); }
  leave() { this.send('leave', {}); }

  close() {
    try { this.leave(); } catch { /* noop */ }
    if (this.ws) { try { this.ws.close(); } catch { /* noop */ } }
    this.ws = null;
    this.connected = false;
  }
}

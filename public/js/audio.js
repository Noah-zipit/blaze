/* Blaze audio — 100% synthesized SFX (ported verbatim from the approved demo). */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const AudioSynth = {
  ctx: null, master: null, muted: false, volume: 0.9,
  ensure() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.9 * this.volume;
    this.master.connect(this.ctx.destination);
    this.ambience();
  },
  setMuted(m) { this.muted = m; if (this.master) this.master.gain.value = m ? 0 : 0.9 * this.volume; },
  setVolume(v) { this.volume = clamp(v, 0, 1); if (this.master && !this.muted) this.master.gain.value = 0.9 * this.volume; },
  now() { return this.ctx.currentTime; },
  noiseBurst({ dur = 0.12, freq = 1500, gain = 0.5, type = 'lowpass', q = 0.8, at = 0 }) {
    if (!this.ctx || this.muted) return;
    const t = this.now() + at;
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource(); src.buffer = buf;
    const f = this.ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t); src.stop(t + dur + 0.02);
  },
  sweep({ from = 200, to = 60, dur = 0.1, gain = 0.4, type = 'square', at = 0 }) {
    if (!this.ctx || this.muted) return;
    const t = this.now() + at;
    const o = this.ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(from, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  },
  blip({ freq = 1000, dur = 0.05, gain = 0.25, type = 'sine', at = 0 }) {
    if (!this.ctx || this.muted) return;
    const t = this.now() + at;
    const o = this.ctx.createOscillator(); o.type = type; o.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  },
  shot(w) {
    if (w === 'rifle') { this.noiseBurst({ dur: 0.13, freq: 1700, gain: 0.5 }); this.sweep({ from: 240, to: 55, dur: 0.1, gain: 0.38 }); }
    else if (w === 'smg') { this.noiseBurst({ dur: 0.08, freq: 2600, gain: 0.4 }); this.sweep({ from: 330, to: 90, dur: 0.07, gain: 0.28 }); }
    else { this.noiseBurst({ dur: 0.32, freq: 750, gain: 0.65 }); this.sweep({ from: 140, to: 32, dur: 0.3, gain: 0.5 }); this.noiseBurst({ dur: 0.1, freq: 4200, gain: 0.22, type: 'highpass', at: 0.01 }); }
  },
  botShot(dist) { this.noiseBurst({ dur: 0.14, freq: 700, gain: clamp(0.3 - dist * 0.006, 0.05, 0.3) }); },
  hitmarker() { this.blip({ freq: 2200, dur: 0.045, gain: 0.2 }); },
  kill() { this.blip({ freq: 660, dur: 0.09, gain: 0.28 }); this.blip({ freq: 990, dur: 0.14, gain: 0.28, at: 0.09 }); },
  death() { this.sweep({ from: 300, to: 70, dur: 0.5, gain: 0.38, type: 'sawtooth' }); this.noiseBurst({ dur: 0.25, freq: 500, gain: 0.28, at: 0.05 }); },
  reload() { this.noiseBurst({ dur: 0.05, freq: 3000, gain: 0.22, type: 'bandpass', q: 2 }); this.noiseBurst({ dur: 0.05, freq: 2000, gain: 0.28, type: 'bandpass', q: 2, at: 0.16 }); },
  emptyClick() { this.blip({ freq: 1400, dur: 0.03, gain: 0.14, type: 'square' }); },
  uiClick() { this.blip({ freq: 900, dur: 0.04, gain: 0.16 }); },
  deny() { this.blip({ freq: 220, dur: 0.12, gain: 0.2, type: 'square' }); },
  hurt() { this.noiseBurst({ dur: 0.08, freq: 900, gain: 0.28 }); },
  jump() { this.sweep({ from: 180, to: 320, dur: 0.12, gain: 0.12, type: 'sine' }); },
  slideSnd() { this.noiseBurst({ dur: 0.4, freq: 600, gain: 0.2, type: 'bandpass', q: 1.2 }); },
  // doll's laser elimination zap
  zap() {
    this.sweep({ from: 2400, to: 110, dur: 0.35, gain: 0.42, type: 'sawtooth' });
    this.noiseBurst({ dur: 0.22, freq: 5200, gain: 0.3, type: 'highpass' });
    this.blip({ freq: 90, dur: 0.4, gain: 0.3, type: 'sine', at: 0.05 });
  },
  // music-box chant for red-light-green-light (synthesized arpeggio, ~2s)
  chant() {
    const notes = [659.25, 783.99, 880.0, 783.99, 659.25, 587.33, 523.25, 659.25];
    notes.forEach((f, i) => {
      this.blip({ freq: f, dur: 0.3, gain: 0.2, type: 'sine', at: i * 0.23 });
      this.blip({ freq: f * 2, dur: 0.18, gain: 0.06, type: 'sine', at: i * 0.23 });
    });
  },
  ambience() {
    if (!this.ctx) return;
    const len = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0); let last = 0;
    for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; d[i] = last * 3.2; }
    const src = this.ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 400;
    const g = this.ctx.createGain(); g.gain.value = 0.04;
    src.connect(f); f.connect(g); g.connect(this.master); src.start();
  },
};

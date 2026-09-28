// Blaze audio — 100% synthesized with Web Audio API. No external files.
// Lazily created on first user gesture (mobile autoplay policy).

export class AudioSynth {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.ambienceNodes = null;
  }

  /** Must be called from a user gesture at least once. */
  ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(this.ctx.destination);
    this.startAmbience();
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.9;
  }

  now() { return this.ctx.currentTime; }

  /** Short filtered noise burst — the body of every gunshot. */
  noiseBurst({ dur = 0.12, freq = 1500, gain = 0.5, type = 'lowpass', q = 0.8, at = 0 }) {
    if (!this.ctx || this.muted) return;
    const t = this.now() + at;
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t); src.stop(t + dur + 0.02);
  }

  /** Pitch-swept oscillator — thump/crack layer of gunshots and stings. */
  sweep({ from = 200, to = 60, dur = 0.1, gain = 0.4, type = 'square', at = 0 }) {
    if (!this.ctx || this.muted) return;
    const t = this.now() + at;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(from, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  blip({ freq = 1000, dur = 0.05, gain = 0.25, type = 'sine', at = 0 }) {
    if (!this.ctx || this.muted) return;
    const t = this.now() + at;
    const o = this.ctx.createOscillator();
    o.type = type; o.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  shot(weapon) {
    if (weapon === 'rifle') {
      this.noiseBurst({ dur: 0.13, freq: 1700, gain: 0.55 });
      this.sweep({ from: 240, to: 55, dur: 0.1, gain: 0.4 });
    } else if (weapon === 'smg') {
      this.noiseBurst({ dur: 0.08, freq: 2600, gain: 0.42 });
      this.sweep({ from: 330, to: 90, dur: 0.07, gain: 0.3 });
    } else if (weapon === 'sniper') {
      this.noiseBurst({ dur: 0.32, freq: 750, gain: 0.7 });
      this.sweep({ from: 140, to: 32, dur: 0.3, gain: 0.55 });
      this.noiseBurst({ dur: 0.1, freq: 4200, gain: 0.25, type: 'highpass', at: 0.01 });
    }
  }

  /** Distant shot from another player — quieter, lowpassed. */
  distantShot() {
    this.noiseBurst({ dur: 0.14, freq: 700, gain: 0.18 });
  }

  hitmarker() { this.blip({ freq: 2200, dur: 0.045, gain: 0.22 }); }
  kill() {
    this.blip({ freq: 660, dur: 0.09, gain: 0.3 });
    this.blip({ freq: 990, dur: 0.14, gain: 0.3, at: 0.09 });
  }
  death() {
    this.sweep({ from: 300, to: 70, dur: 0.5, gain: 0.4, type: 'sawtooth' });
    this.noiseBurst({ dur: 0.25, freq: 500, gain: 0.3, at: 0.05 });
  }
  reload() {
    this.noiseBurst({ dur: 0.05, freq: 3000, gain: 0.25, type: 'bandpass', q: 2 });
    this.noiseBurst({ dur: 0.05, freq: 2000, gain: 0.3, type: 'bandpass', q: 2, at: 0.16 });
  }
  emptyClick() { this.blip({ freq: 1400, dur: 0.03, gain: 0.15, type: 'square' }); }
  uiClick() { this.blip({ freq: 900, dur: 0.04, gain: 0.18 }); }
  hurt() { this.noiseBurst({ dur: 0.08, freq: 900, gain: 0.3 }); }

  /** Subtle looping wind — filtered noise with a slow swell LFO. */
  startAmbience() {
    if (!this.ctx || this.ambienceNodes) return;
    const len = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { // pinkish noise
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.2;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 420;
    const g = this.ctx.createGain();
    g.gain.value = 0.045;
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.09;
    const lfoG = this.ctx.createGain();
    lfoG.gain.value = 0.02;
    lfo.connect(lfoG); lfoG.connect(g.gain);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(); lfo.start();
    this.ambienceNodes = { src, lfo };
  }
}

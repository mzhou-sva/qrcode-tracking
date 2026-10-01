// Snack rhythm audio engine.
//
// Everything runs on ONE AudioContext clock. The three loops (120 BPM, 4 s =
// 2 bars of 4/4) are all started together at t0 and keep running muted; a
// snack "enters" by fading its gain up at a bar line and "leaves" by fading it
// down. That keeps every loop phase-locked to the same beat grid, and the
// animation reads the very same clock (see SnackAudio.beatAt).
(function (global) {
  const BPM = 120;
  const BEAT = 60 / BPM;          // 0.5 s
  const BEATS_PER_BAR = 4;
  const BAR = BEAT * BEATS_PER_BAR; // 2 s
  const LOOP = BAR * 2;           // 4 s
  const FADE_IN = 0.3;            // s, starts exactly on the bar line
  const FADE_OUT = 0.35;          // s, starts as soon as the snack is gone
  const MASTER_GAIN = 0.75;
  const START_LEAD = 0.12;        // s between "everything decoded" and t0
  const MIN_LEAD = 0.03;          // never schedule a bar line closer than this

  async function fetchArrayBuffer(url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`${url}: HTTP ${response.status}`);
    }
    return response.arrayBuffer();
  }

  class SnackAudio {
    // options.loadBuffer(name) -> Promise<ArrayBuffer>; defaults to sounds/<name>.wav
    constructor(options = {}) {
      this.loadBuffer = options.loadBuffer || ((name) => fetchArrayBuffer(`sounds/${name}.wav`));
      this.ctx = null;
      this.t0 = 0;
      this.tracks = {};
    }

    // Must run synchronously inside the tap handler (iOS/Safari autoplay rule).
    createContext() {
      const AC = global.AudioContext || global.webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.ctx.resume();
      return this.ctx;
    }

    async loadAll(names) {
      const ctx = this.ctx;
      const buffers = await Promise.all(names.map(async (name) => {
        const data = await this.loadBuffer(name);
        const buffer = await new Promise((resolve, reject) => ctx.decodeAudioData(data, resolve, reject));
        if (Math.abs(buffer.duration - LOOP) > 0.01) {
          console.warn(`${name}: loop is ${buffer.duration.toFixed(3)} s, expected ${LOOP} s`);
        }
        return buffer;
      }));
      await ctx.resume();

      const limiter = ctx.createDynamicsCompressor();
      const master = ctx.createGain();
      master.gain.value = MASTER_GAIN;
      master.connect(limiter);
      limiter.connect(ctx.destination);

      this.t0 = ctx.currentTime + START_LEAD;
      names.forEach((name, i) => {
        const source = ctx.createBufferSource();
        source.buffer = buffers[i];
        source.loop = true;
        source.loopStart = 0;
        source.loopEnd = buffers[i].duration;
        const gain = ctx.createGain();
        gain.gain.value = 0;
        source.connect(gain);
        gain.connect(master);
        source.start(this.t0);
        this.tracks[name] = { gain, points: [{ t: 0, v: 0 }] };
      });
    }

    // ---- clock -----------------------------------------------------------

    // Audio time that matches what the listener hears right now.
    heardTime() {
      const c = this.ctx;
      return c.currentTime - (c.outputLatency || c.baseLatency || 0);
    }

    // Continuous beat count since t0 (0.0 = first downbeat).
    beatAt(t) {
      return (t - this.t0) / BEAT;
    }

    // First bar line after time t (at least MIN_LEAD away).
    nextBarTime(t = this.ctx.currentTime) {
      const k = Math.max(0, Math.floor((t - this.t0) / BAR) + 1);
      let at = this.t0 + k * BAR;
      if (at - t < MIN_LEAD) {
        at += BAR;
      }
      return at;
    }

    // ---- gain envelopes ----------------------------------------------------
    // Every automation we schedule is also recorded as piecewise-linear points,
    // so the level at any time is known without reading the AudioParam.

    levelAt(name, t) {
      const pts = this.tracks[name].points;
      if (t <= pts[0].t) return pts[0].v;
      for (let i = 1; i < pts.length; i++) {
        if (t <= pts[i].t) {
          const a = pts[i - 1];
          const b = pts[i];
          return b.t === a.t ? b.v : a.v + (b.v - a.v) * (t - a.t) / (b.t - a.t);
        }
      }
      return pts[pts.length - 1].v;
    }

    // Fade the snack in at the next bar line. Returns that bar time.
    fadeIn(name) {
      const track = this.tracks[name];
      const g = track.gain.gain;
      const now = this.ctx.currentTime;
      const cur = this.levelAt(name, now);
      const last = track.points[track.points.length - 1];

      g.cancelScheduledValues(now);
      g.setValueAtTime(cur, now);
      const points = [{ t: now, v: cur }];

      // A fade-out still running: let it finish first, then wait for a bar line.
      let settleAt = now;
      if (last.v === 0 && last.t > now && cur > 0) {
        g.linearRampToValueAtTime(0, last.t);
        points.push({ t: last.t, v: 0 });
        settleAt = last.t;
      }

      const at = this.nextBarTime(settleAt);
      g.setValueAtTime(0, at);
      g.linearRampToValueAtTime(1, at + FADE_IN);
      points.push({ t: at, v: 0 }, { t: at + FADE_IN, v: 1 });
      track.points = points;
      return at;
    }

    // Fade out right now (also cancels a fade-in that is still waiting for its bar).
    fadeOut(name) {
      const track = this.tracks[name];
      const g = track.gain.gain;
      const now = this.ctx.currentTime;
      const cur = this.levelAt(name, now);

      g.cancelScheduledValues(now);
      g.setValueAtTime(cur, now);
      g.linearRampToValueAtTime(0, now + FADE_OUT);
      track.points = [{ t: now, v: cur }, { t: now + FADE_OUT, v: 0 }];
    }
  }

  const api = { SnackAudio, CLOCK: { BPM, BEAT, BEATS_PER_BAR, BAR, LOOP, FADE_IN, FADE_OUT } };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.SnackAudio = SnackAudio;
    global.SNACK_CLOCK = api.CLOCK;
  }
})(typeof window !== 'undefined' ? window : globalThis);

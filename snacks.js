// Snack machine: turns "which QR codes are in view" into sound + visuals, and
// lets the person point at an item by object or by sound.
//
//   water  -> blue ripples that breathe with the beat
//   candy  -> coloured dots, one per 16th note
//   cookie -> a row of brown squares that jump every two beats
//
// A code that appears waits for the next bar line, then fades in. A code that
// has not been seen for 400 ms counts as taken away and fades out. Visuals are
// computed from the audio clock (never from frame counts), so they stay on the
// beat even when the camera loop runs slowly.
(function (global) {
  const TAU = Math.PI * 2;
  const REMOVE_AFTER_MS = 400;
  const GHOST_MS = 1800;            // how long the "Stopped" tag lingers

  const ITEMS = {
    water: { label: 'Water', sound: 'Gulp', color: '#4aa8ff', info: 'Water: the sound of drinking water' },
    candy: { label: 'Candy', sound: 'Crackle', color: '#ff6fb5', info: 'Candy: the sound of crackling hard candy' },
    cookie: { label: 'Cookie', sound: 'Crunch', color: '#b9783f', info: 'Cookie: the sound of biting a crunchy cookie' },
  };
  const ORDER = ['water', 'candy', 'cookie'];

  // QR payload on the printed code sheet -> item. Every other code on the sheet
  // (bottle, object-c, notebook, ...) just gets a box: no label, no sound.
  const CODE_TO_ITEM = {
    'phone': 'water',
    'object-a': 'candy',
    'object-b': 'cookie',
  };

  const HIGHLIGHT_YELLOW = '#ffd84a';
  const CANDY_COLORS = ['#ff5d73', '#ffb347', '#ffe66d', '#7ae582', '#4cc9f0', '#7b6cff', '#ff6fd8', '#5eead4'];
  const COOKIE_COLORS = ['#6f3f1f', '#8a5226', '#a2652f', '#b87a42', '#7d4a23'];
  const CANDY_ACCENT = [1.0, 0.42, 0.68, 0.42];

  const STATUS_TEXT = { playing: 'Playing', waiting: 'Starts next bar', stopped: 'Stopped' };

  // 1 on each beat, 0 halfway between beats.
  function pulse(beat) {
    const p = beat - Math.floor(beat);
    return Math.pow(0.5 + 0.5 * Math.cos(TAU * p), 1.5);
  }

  function hash(n) {
    const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return s - Math.floor(s);
  }

  function rgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  }

  function itemOf(data) {
    return CODE_TO_ITEM[String(data).trim().toLowerCase()] || null;
  }

  function centerOf(loc) {
    return {
      x: (loc.topLeftCorner.x + loc.bottomRightCorner.x) / 2,
      y: (loc.topLeftCorner.y + loc.bottomRightCorner.y) / 2,
    };
  }

  function sideOf(loc) {
    const edges = [
      [loc.topLeftCorner, loc.topRightCorner],
      [loc.topRightCorner, loc.bottomRightCorner],
      [loc.bottomRightCorner, loc.bottomLeftCorner],
      [loc.bottomLeftCorner, loc.topLeftCorner],
    ];
    return edges.reduce((s, [a, b]) => s + Math.hypot(b.x - a.x, b.y - a.y), 0) / 4;
  }

  // ---- visuals -------------------------------------------------------------
  // x, y: centre of the code; u: side length of the code in canvas pixels.

  function drawWater(ctx, x, y, u, level, beat) {
    const rgb = '74,168,255';
    const phase = beat - Math.floor(beat);

    const glowR = u * 1.6 * (1 + 0.12 * pulse(beat));
    const glow = ctx.createRadialGradient(x, y, u * 0.2, x, y, glowR);
    glow.addColorStop(0, `rgba(${rgb},${0.24 * level})`);
    glow.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, glowR, 0, TAU);
    ctx.fill();

    // three ripples that grow and shrink with the beat, each a little later
    for (let i = 0; i < 3; i++) {
      const r = u * (0.62 + 0.27 * i) * (1 + 0.17 * pulse(beat - i * 0.14));
      ctx.lineWidth = Math.max(1.5, u * (0.045 - 0.01 * i));
      ctx.strokeStyle = `rgba(${rgb},${(0.95 - 0.22 * i) * level})`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.stroke();
    }

    // one ripple leaves the code on every beat
    const rr = u * (0.75 + 1.5 * phase);
    ctx.lineWidth = Math.max(1, u * 0.03 * (1 - phase));
    ctx.strokeStyle = `rgba(150,215,255,${0.65 * (1 - phase) * level})`;
    ctx.beginPath();
    ctx.arc(x, y, rr, 0, TAU);
    ctx.stroke();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawCookie(ctx, x, y, u, level, beat) {
    const event = Math.floor(beat / 2);            // one jump every two beats
    const accent = event % 2 === 0;                // beats 1 and 5 hit hardest
    const sinceJump = beat - event * 2;
    const size = u * 0.3;
    const gap = u * 0.42;
    const count = 5;
    const baseY = y + u * 0.45;

    for (let i = 0; i < count; i++) {
      const bx = x + (i - (count - 1) / 2) * gap;
      const s = (sinceJump - i * 0.07) / 0.8;      // 0..1 while in the air
      let lift = 0;
      let rot = 0;
      let squash = 1;
      if (s >= 0 && s < 1) {
        lift = 4 * s * (1 - s) * u * (accent ? 0.95 : 0.55) * (0.88 + 0.12 * Math.sin(i * 2.1));
        rot = (s - 0.5) * 0.7 * (i % 2 ? 1 : -1);
      } else if (s >= 1 && s < 1.3) {
        squash = 1 - 0.2 * Math.sin(((s - 1) / 0.3) * Math.PI);
      }

      ctx.fillStyle = `rgba(0,0,0,${0.35 * level})`;
      ctx.beginPath();
      ctx.ellipse(bx, baseY + size * 0.08, size * 0.5 * (1 - lift / (u * 2)), size * 0.12, 0, 0, TAU);
      ctx.fill();

      ctx.save();
      ctx.translate(bx, baseY - lift - (size * squash) / 2);
      ctx.rotate(rot);
      ctx.globalAlpha = level;
      ctx.fillStyle = COOKIE_COLORS[i % COOKIE_COLORS.length];
      roundRect(ctx, -size / 2, -(size * squash) / 2, size, size * squash, size * 0.14);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,225,180,0.28)';
      roundRect(ctx, -size / 2 + 2, -(size * squash) / 2 + 2, size - 4, size * 0.16, size * 0.07);
      ctx.fill();
      ctx.restore();
    }
  }

  function drawCandy(ctx, x, y, u, level, beat) {
    const n = beat * 4;                            // 16th notes since the start
    const current = Math.floor(n);
    const life = 3.5;                              // 16ths a dot stays alive

    ctx.globalCompositeOperation = 'lighter';
    for (let k = 0; k < 12; k++) {
      const idx = current - k;
      const age = n - idx;
      if (idx < 0 || age >= life) continue;
      const t = age / life;
      const angle = hash(idx * 7 + 1) * TAU;
      const dist = u * (0.45 + 0.75 * hash(idx * 13 + 5)) * (0.7 + 0.5 * t);
      const accent = CANDY_ACCENT[idx % 4];
      const pop = Math.min(1, t * 4);
      const eased = 1 - Math.pow(1 - pop, 3);
      const radius = u * (0.07 + 0.1 * accent) * (0.4 + 0.6 * eased) * (1 - 0.35 * t);
      const px = x + Math.cos(angle) * dist;
      const py = y + Math.sin(angle) * dist - t * u * 0.15;
      const color = CANDY_COLORS[Math.floor(hash(idx * 17 + 9) * CANDY_COLORS.length)];
      const alpha = level * (1 - t) * (0.5 + 0.5 * accent);

      const halo = ctx.createRadialGradient(px, py, 0, px, py, radius * 2.4);
      halo.addColorStop(0, rgba(color, 0.55 * alpha));
      halo.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(px, py, radius * 2.4, 0, TAU);
      ctx.fill();

      ctx.fillStyle = rgba(color, alpha);
      ctx.beginPath();
      ctx.arc(px, py, radius, 0, TAU);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  const DRAWERS = { water: drawWater, candy: drawCandy, cookie: drawCookie };

  // ---- selection highlight -------------------------------------------------
  // Black edge + two yellow outlines: visible on white paper (black) and on the
  // dark scene (yellow). Drawn around the code's own quad, pushed outwards.

  function expandQuad(loc, pad) {
    const corners = [loc.topLeftCorner, loc.topRightCorner, loc.bottomRightCorner, loc.bottomLeftCorner];
    const c = centerOf(loc);
    return corners.map((p) => {
      const dx = p.x - c.x;
      const dy = p.y - c.y;
      const len = Math.hypot(dx, dy) || 1;
      return { x: p.x + (dx / len) * pad, y: p.y + (dy / len) * pad };
    });
  }

  function strokeQuad(ctx, pts, width, color) {
    ctx.lineJoin = 'round';
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.stroke();
  }

  function drawHighlight(ctx, location, now) {
    const k = ctx.getTransform ? ctx.getTransform().a || 1 : 1;
    const u = Math.max(2, (ctx.canvas.width / k) * 0.004);      // line unit, scales with the canvas
    const breathe = 0.82 + 0.18 * Math.sin(now / 260);

    ctx.save();
    [u * 2.2, u * 6.4].forEach((pad, ring) => {
      const pts = expandQuad(location, pad);
      ctx.globalAlpha = ring === 0 ? 1 : breathe;
      strokeQuad(ctx, pts, u * 3.6, '#000');                      // black edge
      strokeQuad(ctx, pts, u * 1.8, HIGHLIGHT_YELLOW);            // yellow line on top
    });
    ctx.restore();
  }

  // ---- machine -------------------------------------------------------------

  class SnackMachine {
    // hud: optional DOM element holding .snack[data-name] pills and .bar dots
    constructor(audio, hud, options = {}) {
      this.audio = audio;
      this.hud = hud || null;
      this.now = options.now || (() => performance.now());
      this.snacks = {};
      ORDER.forEach((name) => {
        this.snacks[name] = {
          phase: 'stopped', lastSeen: 0, stoppedAt: -1e9, anchor: null, location: null, barAt: 0, hudPhase: null,
        };
      });
      this.hudBeat = -1;
      this.selection = null;            // { item, by: 'object' | 'sound' }
      this.controls = null;
      this.shownInfo = null;
    }

    // codes: [{ data, location }] in the coordinates the visuals are drawn in.
    update(codes) {
      const now = this.now();
      const seen = new Set();

      for (const code of codes) {
        const name = itemOf(code.data);
        if (!name) continue;
        const snack = this.snacks[name];
        seen.add(name);
        snack.lastSeen = now;
        snack.location = code.location;

        const c = centerOf(code.location);
        const side = sideOf(code.location);
        snack.anchor = snack.anchor
          ? {
            x: snack.anchor.x + (c.x - snack.anchor.x) * 0.4,
            y: snack.anchor.y + (c.y - snack.anchor.y) * 0.4,
            side: snack.anchor.side + (side - snack.anchor.side) * 0.4,
          }
          : { x: c.x, y: c.y, side };

        if (snack.phase === 'stopped') {
          snack.phase = 'waiting';
          snack.barAt = this.audio.fadeIn(name);
        }
      }

      for (const name of ORDER) {
        const snack = this.snacks[name];
        if (seen.has(name) || snack.phase === 'stopped') continue;
        if (now - snack.lastSeen > REMOVE_AFTER_MS) {
          this.audio.fadeOut(name);
          snack.phase = 'stopped';
          snack.stoppedAt = now;
        }
      }

      const t = this.audio.ctx.currentTime;
      for (const name of ORDER) {
        const snack = this.snacks[name];
        if (snack.phase === 'waiting' && t >= snack.barAt) snack.phase = 'playing';
      }
    }

    // Label for a detected code, or null for codes that only get a box.
    describe(data) {
      const name = itemOf(data);
      if (!name) return null;
      return { color: ITEMS[name].color, text: `${ITEMS[name].label} · ${STATUS_TEXT[this.snacks[name].phase]}` };
    }

    // ---- pointing at an item (by object / by sound) ---------------------

    isOnTable(item) {
      return this.snacks[item].phase !== 'stopped';
    }

    // Click on a button: select it, or cancel when it is already the selection.
    select(item, by) {
      const same = this.selection && this.selection.item === item && this.selection.by === by;
      this.selection = same ? null : { item, by };
      this.refreshControls();
    }

    infoText() {
      if (!this.selection) return '';
      const { item, by } = this.selection;
      if (!this.isOnTable(item)) return `${ITEMS[item].label} is not on the table.`;
      return by === 'sound' ? ITEMS[item].info : '';
    }

    // root: element containing buttons [data-by][data-item] and an .info line.
    bindControls(root) {
      this.controls = root;
      root.querySelectorAll('button[data-item]').forEach((button) => {
        button.addEventListener('click', () => this.select(button.dataset.item, button.dataset.by));
      });
      this.refreshControls();
    }

    refreshControls() {
      const root = this.controls;
      if (!root) return;
      root.querySelectorAll('button[data-item]').forEach((button) => {
        const on = !!this.selection && this.selection.item === button.dataset.item && this.selection.by === button.dataset.by;
        button.setAttribute('aria-pressed', on ? 'true' : 'false');
        button.classList.toggle('active', on);
      });
      const info = root.querySelector('.info');
      const text = this.infoText();
      if (info && text !== this.shownInfo) {
        this.shownInfo = text;
        info.textContent = text;
        info.classList.toggle('shown', !!text);
        info.classList.toggle('warn', !!text && text.endsWith('table.'));
      }
    }

    // Draw visuals, the selection highlight and the lingering "Stopped" tags.
    // Returns 0..1 beat energy.
    draw(ctx) {
      const audio = this.audio;
      const t = audio.heardTime();
      const beat = audio.beatAt(t);
      const now = this.now();
      let energy = 0;

      if (beat >= 0) {
        for (const name of ORDER) {
          const snack = this.snacks[name];
          if (!snack.anchor) continue;
          const level = audio.levelAt(name, t);
          if (level < 0.01) continue;
          ctx.save();
          DRAWERS[name](ctx, snack.anchor.x, snack.anchor.y, snack.anchor.side, level, beat);
          ctx.restore();
          energy = Math.max(energy, level * (0.35 + 0.65 * pulse(beat)));
        }
      }

      for (const name of ORDER) {
        const snack = this.snacks[name];
        if (snack.phase !== 'stopped' || !snack.anchor) continue;
        const age = now - snack.stoppedAt;
        if (age > GHOST_MS) continue;
        this._drawTag(ctx, snack.anchor, `${ITEMS[name].label} · ${STATUS_TEXT.stopped}`, ITEMS[name].color, 1 - age / GHOST_MS);
      }

      if (this.selection && this.isOnTable(this.selection.item) && this.snacks[this.selection.item].location) {
        drawHighlight(ctx, this.snacks[this.selection.item].location, now);
      }

      this.refreshControls();
      this._updateHud(beat);
      return energy;
    }

    _drawTag(ctx, anchor, text, color, alpha) {
      const k = ctx.getTransform ? ctx.getTransform().a || 1 : 1;   // device pixels per drawing unit
      const w = ctx.canvas.width / k;
      const fontSize = Math.max(16, w * 0.02);
      const pad = fontSize * 0.25;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.font = `${fontSize}px "Helvetica Neue","Noto Sans CJK SC",Arial,sans-serif`;
      ctx.textBaseline = 'top';
      const x = anchor.x - anchor.side / 2;
      const y = anchor.y + anchor.side / 2 + pad;
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(x - pad, y - pad, tw + pad * 2, fontSize + pad * 2);
      ctx.fillStyle = color;
      ctx.fillText(text, x, y);
      ctx.restore();
    }

    _updateHud(beat) {
      if (!this.hud) return;
      for (const name of ORDER) {
        const snack = this.snacks[name];
        if (snack.hudPhase === snack.phase) continue;
        snack.hudPhase = snack.phase;
        const row = this.hud.querySelector(`.snack[data-name="${name}"]`);
        if (!row) continue;
        row.dataset.phase = snack.phase;
        row.querySelector('em').textContent = STATUS_TEXT[snack.phase];
      }
      const beatInBar = beat >= 0 ? Math.floor(beat) % 4 : -1;
      if (beatInBar !== this.hudBeat) {
        this.hudBeat = beatInBar;
        this.hud.querySelectorAll('.bar i').forEach((dot, i) => dot.classList.toggle('on', i === beatInBar));
      }
    }
  }

  const api = {
    SnackMachine, ITEMS, ORDER, CODE_TO_ITEM, pulse, REMOVE_AFTER_MS, STATUS_TEXT,
    drawWater, drawCookie, drawCandy, drawHighlight, expandQuad,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.SnackMachine = SnackMachine;
    global.SNACK_ITEMS = ITEMS;
    global.SNACK_ORDER = ORDER;
    global.SnackVisuals = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);

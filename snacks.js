// Snack machine: turns "which QR codes are in view" into sound + visuals, and
// lets the person point at an item by object or by sound.
//
//   water  -> blue ripples that breathe with the beat
//   candy  -> coloured dots, one per 16th note
//   cookie -> a row of brown squares that jump every two beats
//
// A code that appears waits for the next bar line, then fades in. A code that
// has not been seen for 400 ms, or for three recent frame intervals when that is
// longer, counts as taken away and fades out. Visuals are
// computed from the audio clock (never from frame counts), so they stay on the
// beat even when the camera loop runs slowly.
(function (global) {
  const TAU = Math.PI * 2;
  const REMOVE_AFTER_MS = 400;
  const FRAME_INTERVAL_FACTOR = 3;
  const FRAME_INTERVAL_SMOOTHING = 0.2;
  const FRAME_INTERVAL_CAP_MS = 2000;
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
  const RHYTHM_TEXT = ['every beat', 'every 2 beats', 'every 4 beats'];
  const TIER_EDGES = [100 / 3, 200 / 3];
  const TIER_MARGIN = 3;
  const RING_LIFE = 0.25;
  const NARROW_WIDTH = 700;
  const CANDY_COLORS = ['#ff5d73', '#ffb347', '#ffe66d', '#7ae582', '#4cc9f0', '#7b6cff', '#ff6fd8', '#5eead4'];
  const COOKIE_COLORS = ['#6f3f1f', '#8a5226', '#a2652f', '#b87a42', '#7d4a23'];
  const CANDY_ACCENT = [1.0, 0.42, 0.68, 0.42];

  const STATUS_TEXT = { playing: 'Playing', waiting: 'Starts next bar', stopped: 'Stopped' };

  const ZONE_NAMES = [
    ['Upper left', 'Upper middle', 'Upper right'],
    ['Middle left', 'Center', 'Middle right'],
    ['Lower left', 'Lower middle', 'Lower right'],
  ];
  const POSITION_SMOOTHING = 0.3;
  const ROW_NAMES = ['Top row', 'Middle row', 'Bottom row'];
  const COLUMN_NAMES = ['Left column', 'Middle column', 'Right column'];
  const VERTICAL_WORDS = new Map([['top', 0], ['upper', 0], ['up', 0], ['above', 0], ['bottom', 2], ['lower', 2], ['down', 2], ['below', 2]]);
  const HORIZONTAL_WORDS = new Map([['left', 0], ['right', 2]]);
  const MIDDLE_WORDS = new Set(['middle', 'center', 'centre']);
  const FILLER_WORDS = new Set(['the', 'a', 'an', 'and', 'in', 'at', 'on', 'to', 'of', 'side', 'area', 'corner', 'part', 'region', 'zone', 'section', 'portion', 'half', 'screen', 'frame', 'picture', 'image']);
  const REFERENCES = { corner: 'Top-left corner', center: 'Center' };
  const REFERENCE_PHRASE = { corner: 'the top-left corner', center: 'the center' };
  const HIGHLIGHT_PADS = [2.2, 6.4];
  const HIGHLIGHT_STROKE = 3.6;
  const FONT_FAMILY = '"Helvetica Neue","Noto Sans CJK SC",Arial,sans-serif';

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

  function averageOfCorners(loc) {
    const points = [loc.topLeftCorner, loc.topRightCorner, loc.bottomRightCorner, loc.bottomLeftCorner];
    return {
      x: points.reduce((sum, p) => sum + p.x, 0) / 4,
      y: points.reduce((sum, p) => sum + p.y, 0) / 4,
    };
  }

  function clampPercent(value) {
    return Math.min(100, Math.max(0, value));
  }

  function toPercent(point, frame) {
    return {
      x: clampPercent((point.x / frame.width) * 100),
      y: clampPercent((point.y / frame.height) * 100),
    };
  }

  function zoneOf(xPercent, yPercent) {
    const col = Math.min(2, Math.floor(xPercent / (100 / 3)));
    const row = Math.min(2, Math.floor(yPercent / (100 / 3)));
    return ZONE_NAMES[row][col];
  }

  function signed(value) {
    if (value > 0) return `+${value}`;
    if (value < 0) return `\u2212${Math.abs(value)}`;
    return '0';
  }

  function displayNumbers(pos, reference) {
    if (reference === 'center') {
      const x = Math.round(pos.x - 50);
      const y = Math.round(50 - pos.y);
      return { x: signed(x), y: signed(y) };
    }
    return { x: String(Math.round(pos.x)), y: String(Math.round(pos.y)) };
  }

  function positionLine(pos, reference = 'corner') {
    const n = displayNumbers(pos, reference);
    return `${zoneOf(pos.x, pos.y)} · x ${n.x}% y ${n.y}%`;
  }

  function cellBounds(row, col) {
    const cell = 100 / 3;
    return { x0: col * cell, x1: (col + 1) * cell, y0: row * cell, y1: (row + 1) * cell };
  }

  function rangeText(axis, lo, hi, reference) {
    const format = reference === 'center' ? signed : String;
    return `${axis} ${format(lo)}\u2013${format(hi)}%`;
  }

  function boundsRange(b, reference = 'corner') {
    if (reference === 'center') {
      return `${rangeText('x', Math.round(b.x0 - 50), Math.round(b.x1 - 50), reference)}, ${rangeText('y', Math.round(50 - b.y1), Math.round(50 - b.y0), reference)}`;
    }
    return `${rangeText('x', Math.round(b.x0), Math.round(b.x1), reference)}, ${rangeText('y', Math.round(b.y0), Math.round(b.y1), reference)}`;
  }

  function zoneRange(row, col, reference = 'corner') {
    return boundsRange(cellBounds(row, col), reference);
  }

  function regionBounds(region) {
    return {
      x0: cellBounds(0, region.cols[0]).x0,
      x1: cellBounds(0, region.cols[1]).x1,
      y0: cellBounds(region.rows[0], 0).y0,
      y1: cellBounds(region.rows[1], 0).y1,
    };
  }

  function regionName(region) {
    const { rows, cols } = region;
    const singleRow = rows[0] === rows[1];
    const singleCol = cols[0] === cols[1];
    if (singleRow && singleCol) return ZONE_NAMES[rows[0]][cols[0]];
    return singleRow ? ROW_NAMES[rows[0]] : COLUMN_NAMES[cols[0]];
  }

  function parseDescription(text) {
    const words = String(text).toLowerCase().replace(/-/g, ' ').split(/[\s,.;:!?/()]+/).filter(Boolean);
    let vertical = null;
    let horizontal = null;
    let middle = false;
    let row = false;
    let column = false;
    for (const word of words) {
      if (word === 'row') {
        row = true;
      } else if (word === 'column') {
        column = true;
      } else if (VERTICAL_WORDS.has(word)) {
        const value = VERTICAL_WORDS.get(word);
        if (vertical !== null && vertical !== value) return { ok: false };
        vertical = value;
      } else if (HORIZONTAL_WORDS.has(word)) {
        const value = HORIZONTAL_WORDS.get(word);
        if (horizontal !== null && horizontal !== value) return { ok: false };
        horizontal = value;
      } else if (MIDDLE_WORDS.has(word)) {
        middle = true;
      } else if (!FILLER_WORDS.has(word)) {
        return { ok: false };
      }
    }
    if (row || column) {
      if (row && column) return { ok: false };
      const wrong = row ? horizontal : vertical;
      let index = row ? vertical : horizontal;
      if (wrong !== null) return { ok: false };
      if (index === null && middle) index = 1;
      if (index === null) return { ok: false };
      const region = row ? { rows: [index, index], cols: [0, 2] } : { rows: [0, 2], cols: [index, index] };
      return { ok: true, region, name: regionName(region) };
    }
    if (vertical === null && horizontal === null && !middle) return { ok: false };
    if (middle) {
      if (vertical === null && horizontal === null) {
        vertical = 1;
        horizontal = 1;
      } else if (vertical === null) {
        vertical = 1;
      } else if (horizontal === null) {
        horizontal = 1;
      }
    }
    const region = {
      rows: vertical === null ? [0, 2] : [vertical, vertical],
      cols: horizontal === null ? [0, 2] : [horizontal, horizontal],
    };
    return { ok: true, region, name: regionName(region) };
  }

  function joinNames(names) {
    if (names.length === 1) return names[0];
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  }

  function zoneSentence(row, col, reference, names) {
    const tail = names.length === 0 ? 'empty.' : `${joinNames(names)} ${names.length === 1 ? 'is' : 'are'} here.`;
    return `${ZONE_NAMES[row][col]} (${zoneRange(row, col, reference)}): ${tail}`;
  }

  function regionSentence(name, region, reference, pixel, names) {
    const b = regionBounds(region);
    const center = displayNumbers({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 }, reference);
    const onScreen = pixel ? `, about ${Math.round(pixel.x)} px, ${Math.round(pixel.y)} px on screen` : '';
    const tail = names.length === 0 ? 'Empty.' : `${joinNames(names)} ${names.length === 1 ? 'is' : 'are'} here.`;
    return `${name}: ${boundsRange(b, reference)}, center point (${center.x}%, ${center.y}%)${onScreen}. ${tail}`;
  }

  function tierFromY(y) {
    if (y < TIER_EDGES[0]) return 0;
    return y < TIER_EDGES[1] ? 1 : 2;
  }

  function nextTier(current, y) {
    let tier = current;
    while (tier < 2 && y >= TIER_EDGES[tier] + TIER_MARGIN) tier++;
    while (tier > 0 && y <= TIER_EDGES[tier - 1] - TIER_MARGIN) tier--;
    return tier;
  }

  function drawBeatRing(ctx, anchor, color, age, level) {
    const progress = Math.min(1, age / RING_LIFE);
    const eased = 1 - Math.pow(1 - progress, 3);
    ctx.save();
    ctx.lineWidth = Math.max(2, anchor.side * 0.05);
    ctx.strokeStyle = rgba(color, 0.95 * (1 - progress) * level);
    ctx.beginPath();
    ctx.arc(anchor.x, anchor.y, (anchor.side * (0.5 + 0.5 * eased)) / 2, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  function panHint(x) {
    if (x >= 45 && x <= 55) return 'Center';
    return `${x < 50 ? 'L' : 'R'} ${Math.round(Math.abs(x - 50) * 2)}%`;
  }

  function positionSentence(label, pos, reference = 'corner') {
    const n = displayNumbers(pos, reference);
    const zone = zoneOf(pos.x, pos.y).toLowerCase();
    return `${label} is in the ${zone}: x ${n.x}%, y ${n.y}% (from ${REFERENCE_PHRASE[reference]}).`;
  }

  function percentToScreen(xPercent, yPercent, frame, viewport) {
    const fit = Math.min(viewport.width / frame.width, viewport.height / frame.height);
    const left = (viewport.width - frame.width * fit) / 2;
    const top = (viewport.height - frame.height * fit) / 2;
    return {
      x: left + (xPercent / 100) * frame.width * fit,
      y: top + (yPercent / 100) * frame.height * fit,
    };
  }

  function clientToFrame(point, rect, frame) {
    const fit = Math.min(rect.width / frame.width, rect.height / frame.height);
    const left = (rect.width - frame.width * fit) / 2;
    const top = (rect.height - frame.height * fit) / 2;
    return { x: (point.x - rect.left - left) / fit, y: (point.y - rect.top - top) / fit };
  }

  function boxOf(points) {
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
  }

  function layoutLabel(box, avoid, size, frame, gap, obstacle) {
    const x = Math.max(0, Math.min(box.left, frame.width - size.width));
    const blocked = !!obstacle && x < obstacle.right && x + size.width > obstacle.left;
    const limit = blocked ? Math.min(frame.height, obstacle.top - gap) : frame.height;
    let y = avoid.bottom + gap;
    if (y + size.height > limit) {
      const above = avoid.top - gap - size.height;
      y = above >= 0 ? above : Math.max(0, limit - size.height);
    }
    return { x, y };
  }

  function rectsOverlap(a, b) {
    return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  }

  function placeLabel(rect, placed, frame, spacing, obstacle, obstacleGap) {
    const blocked = !!obstacle && rect.x < obstacle.right && rect.x + rect.width > obstacle.left;
    const limit = blocked ? Math.min(frame.height, obstacle.top - obstacleGap) : frame.height;
    const hits = (y) => placed.filter((other) => rectsOverlap({ ...rect, y }, other));
    let down = rect.y;
    for (let i = 0; i <= placed.length; i++) {
      const found = hits(down);
      if (!found.length) break;
      down = Math.max(...found.map((other) => other.y + other.height)) + spacing;
    }
    if (!hits(down).length && down + rect.height <= limit) return { x: rect.x, y: down };
    let up = rect.y;
    for (let i = 0; i <= placed.length; i++) {
      const found = hits(up);
      if (!found.length) break;
      up = Math.min(...found.map((other) => other.y)) - spacing - rect.height;
    }
    if (!hits(up).length && up >= 0) return { x: rect.x, y: up };
    return { x: rect.x, y: Math.max(0, Math.min(rect.y, limit - rect.height)) };
  }

  function canvasSize(ctx) {
    const k = ctx.getTransform ? ctx.getTransform().a || 1 : 1;   // device pixels per drawing unit
    return { width: ctx.canvas.width / k, height: ctx.canvas.height / k };
  }

  function drawGrid(ctx) {
    const { width, height } = canvasSize(ctx);
    const line = Math.max(1, width / 1100);
    const fontSize = Math.max(11, width * 0.0105);
    const inset = fontSize * 0.5;

    ctx.save();
    ctx.lineWidth = line;
    [['rgba(0,0,0,0.16)', -line], ['rgba(255,255,255,0.26)', 0]].forEach(([color, shift]) => {
      ctx.strokeStyle = color;
      ctx.beginPath();
      for (let i = 1; i < 3; i++) {
        ctx.moveTo((width * i) / 3 + shift, 0);
        ctx.lineTo((width * i) / 3 + shift, height);
        ctx.moveTo(0, (height * i) / 3 + shift);
        ctx.lineTo(width, (height * i) / 3 + shift);
      }
      ctx.stroke();
    });

    ctx.font = `${fontSize}px ${FONT_FAMILY}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.lineJoin = 'round';
    ctx.lineWidth = fontSize * 0.28;
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.fillStyle = 'rgba(255,255,255,0.72)';
    ZONE_NAMES.forEach((names, row) => {
      names.forEach((name, col) => {
        const x = (width * (col + 1)) / 3 - inset;
        const y = (height * (row + 1)) / 3 - inset;
        ctx.strokeText(name, x, y);
        ctx.fillText(name, x, y);
      });
    });
    ctx.restore();
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

  function highlightUnit(ctx) {
    return Math.max(2, canvasSize(ctx).width * 0.004);
  }

  function highlightExtent(location, u) {
    const ys = expandQuad(location, u * HIGHLIGHT_PADS[1]).map((p) => p.y);
    const half = (u * HIGHLIGHT_STROKE) / 2;
    return { top: Math.min(...ys) - half, bottom: Math.max(...ys) + half };
  }

  function drawHighlight(ctx, location, now) {
    const u = highlightUnit(ctx);      // line unit, scales with the canvas
    const breathe = 0.82 + 0.18 * Math.sin(now / 260);

    ctx.save();
    HIGHLIGHT_PADS.map((pad) => u * pad).forEach((pad, ring) => {
      const pts = expandQuad(location, pad);
      ctx.globalAlpha = ring === 0 ? 1 : breathe;
      strokeQuad(ctx, pts, u * HIGHLIGHT_STROKE, '#000');                      // black edge
      strokeQuad(ctx, pts, (u * HIGHLIGHT_STROKE) / 2, HIGHLIGHT_YELLOW);      // yellow line on top
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
          phase: 'stopped', lastSeen: 0, stoppedAt: -1e9, anchor: null, location: null, pos: null, tier: null, barAt: 0, hudPhase: null, hudText: null,
        };
      });
      this.frame = null;
      this.lastUpdate = null;
      this.interval = null;
      this.reference = 'corner';
      this.hudBeat = -1;
      this.selection = null;            // { item, by: 'object' | 'sound' }
      this.zoneSelection = null;
      this.textSelection = null;
      this.controlsCollapsed = false;
      this.userToggled = false;
      this.controlsMax = null;
      this.input = null;
      this.zoneElement = null;
      this.surface = null;
      this.controls = null;
      this.shownInfo = null;
    }

    // codes: [{ data, location }] in the coordinates the visuals are drawn in.
    update(codes, frame) {
      const now = this.now();
      this._tickInterval(now);
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

        if (frame) {
          this._track(snack, code.location, frame);
          this.audio.setPan(name, snack.pos.x, snack.phase === 'stopped');
          this._rhythm(name, snack);
        }

        if (snack.phase === 'stopped') {
          snack.phase = 'waiting';
          snack.barAt = this.audio.fadeIn(name);
          this.audio.startGate(name, snack.tier, snack.barAt);
        }
      }

      for (const name of ORDER) {
        const snack = this.snacks[name];
        if (seen.has(name) || snack.phase === 'stopped') continue;
        if (now - snack.lastSeen > this.removeAfter()) {
          this.audio.fadeOut(name);
          this.audio.stopGate(name);
          snack.tier = null;
          snack.phase = 'stopped';
          snack.stoppedAt = now;
        }
      }

      const t = this.audio.ctx.currentTime;
      for (const name of ORDER) {
        const snack = this.snacks[name];
        if (snack.phase === 'waiting' && t >= snack.barAt) snack.phase = 'playing';
      }

      for (const name of ORDER) {
        if (this.snacks[name].phase !== 'stopped') this.audio.scheduleGates(name);
      }
    }

    _tickInterval(now) {
      if (this.lastUpdate !== null) {
        const gap = Math.min(now - this.lastUpdate, FRAME_INTERVAL_CAP_MS);
        this.interval = this.interval === null ? gap : this.interval + (gap - this.interval) * FRAME_INTERVAL_SMOOTHING;
      }
      this.lastUpdate = now;
    }

    removeAfter() {
      return Math.max(REMOVE_AFTER_MS, FRAME_INTERVAL_FACTOR * (this.interval || 0));
    }

    _rhythm(name, snack) {
      const y = snack.pos.y;
      if (snack.phase === 'stopped') {
        snack.tier = tierFromY(y);
        return;
      }
      if (snack.tier === null) {
        snack.tier = tierFromY(y);
        this.audio.startGate(name, snack.tier, snack.barAt);
        return;
      }
      const tier = nextTier(snack.tier, y);
      if (tier !== snack.tier) {
        snack.tier = tier;
        this.audio.changeTier(name, tier);
      }
    }

    _track(snack, location, frame) {
      const raw = toPercent(averageOfCorners(location), frame);
      const fresh = !snack.pos || snack.phase === 'stopped';
      snack.pos = fresh
        ? raw
        : {
          x: snack.pos.x + (raw.x - snack.pos.x) * POSITION_SMOOTHING,
          y: snack.pos.y + (raw.y - snack.pos.y) * POSITION_SMOOTHING,
        };
      this.frame = frame;
    }

    positions(viewport) {
      const out = {};
      for (const name of ORDER) {
        const snack = this.snacks[name];
        if (!snack.pos || snack.phase === 'stopped' || !this.frame) continue;
        out[name] = {
          zone: zoneOf(snack.pos.x, snack.pos.y),
          xPercent: Math.round(snack.pos.x * 10) / 10,
          yPercent: Math.round(snack.pos.y * 10) / 10,
          screen: percentToScreen(snack.pos.x, snack.pos.y, this.frame, viewport),
        };
      }
      return out;
    }

    drawGrid(ctx) {
      drawGrid(ctx);
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
      this.zoneSelection = null;
      this.clearDescription();
      this.refreshControls();
    }

    clearDescription() {
      this.textSelection = null;
      if (this.input) this.input.value = '';
    }

    itemsInRegion(region) {
      const zones = new Set();
      for (let row = region.rows[0]; row <= region.rows[1]; row++) {
        for (let col = region.cols[0]; col <= region.cols[1]; col++) zones.add(ZONE_NAMES[row][col]);
      }
      return ORDER.filter((name) => {
        const snack = this.snacks[name];
        return !!snack.pos && this.isOnTable(name) && zones.has(zoneOf(snack.pos.x, snack.pos.y));
      });
    }

    activeRegion() {
      if (this.zoneSelection) {
        const { row, col } = this.zoneSelection;
        return { rows: [row, row], cols: [col, col] };
      }
      return this.textSelection && this.textSelection.region ? this.textSelection.region : null;
    }

    regionCenterOnScreen(region) {
      if (!this.surface) return null;
      const rect = this.surface.canvas.getBoundingClientRect();
      const b = regionBounds(region);
      const point = percentToScreen((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, this.surface.frame, { width: rect.width, height: rect.height });
      return { x: rect.left + point.x, y: rect.top + point.y };
    }

    submitDescription(text) {
      const raw = String(text).trim();
      if (!raw) {
        this.clearDescription();
        this.refreshControls();
        return;
      }
      const parsed = parseDescription(raw);
      this.selection = null;
      this.zoneSelection = null;
      this.textSelection = parsed.ok ? { raw, region: parsed.region, name: parsed.name } : { raw, failed: true };
      this.refreshControls();
    }

    itemsInZone(row, col) {
      const zone = ZONE_NAMES[row][col];
      return ORDER.filter((name) => {
        const snack = this.snacks[name];
        return !!snack.pos && this.isOnTable(name) && zoneOf(snack.pos.x, snack.pos.y) === zone;
      });
    }

    selectZone(row, col) {
      const current = this.zoneSelection;
      const same = !!current && current.row === row && current.col === col;
      this.zoneSelection = same ? null : { row, col };
      this.selection = null;
      this.clearDescription();
      this.refreshControls();
    }

    layoutZone() {
      const element = this.zoneElement;
      if (!element) return;
      const region = this.activeRegion();
      if (!region || !this.surface) {
        element.hidden = true;
        return;
      }
      const rect = this.surface.canvas.getBoundingClientRect();
      const viewport = { width: rect.width, height: rect.height };
      const b = regionBounds(region);
      const topLeft = percentToScreen(b.x0, b.y0, this.surface.frame, viewport);
      const bottomRight = percentToScreen(b.x1, b.y1, this.surface.frame, viewport);
      element.style.left = `${rect.left + topLeft.x}px`;
      element.style.top = `${rect.top + topLeft.y}px`;
      element.style.width = `${bottomRight.x - topLeft.x}px`;
      element.style.height = `${bottomRight.y - topLeft.y}px`;
      element.hidden = false;
    }

    infoText() {
      const described = this.textSelection;
      if (described) {
        if (described.failed) return `I did not understand '${described.raw}'. Try: left, upper right, bottom, center.`;
        const names = this.itemsInRegion(described.region).map((name) => ITEMS[name].label);
        return regionSentence(described.name, described.region, this.reference, this.regionCenterOnScreen(described.region), names);
      }
      if (this.zoneSelection) {
        const { row, col } = this.zoneSelection;
        return zoneSentence(row, col, this.reference, this.itemsInZone(row, col).map((name) => ITEMS[name].label));
      }
      if (!this.selection) return '';
      const { item, by } = this.selection;
      if (!this.isOnTable(item)) return `${ITEMS[item].label} is not on the table.`;
      const pos = this.snacks[item].pos;
      const snack = this.snacks[item];
      const rhythm = by === 'object' && pos && snack.tier !== null ? ` It plays ${RHYTHM_TEXT[snack.tier]}.` : '';
      const where = pos ? positionSentence(ITEMS[item].label, pos, this.reference) + rhythm : '';
      return by === 'sound' ? [ITEMS[item].info, where].filter(Boolean).join('\n') : where;
    }

    setReference(reference) {
      if (!REFERENCES[reference]) return;
      this.reference = reference;
      this.refreshControls();
    }

    // root: element containing buttons [data-by][data-item] and an .info line.
    bindControls(root) {
      this.controls = root;
      root.querySelectorAll('button[data-item]').forEach((button) => {
        button.addEventListener('click', () => this.select(button.dataset.item, button.dataset.by));
      });
      root.querySelectorAll('button[data-ref]').forEach((button) => {
        button.addEventListener('click', () => this.setReference(button.dataset.ref));
      });
      root.querySelectorAll('button[data-row]').forEach((button) => {
        const row = Number(button.dataset.row);
        const col = Number(button.dataset.col);
        button.title = ZONE_NAMES[row][col];
        button.setAttribute('aria-label', ZONE_NAMES[row][col]);
        button.addEventListener('click', () => this.selectZone(row, col));
      });
      this.input = root.querySelector('input');
      if (this.input) {
        this.input.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' || event.isComposing) return;
          event.preventDefault();
          this.submitDescription(this.input.value);
        });
      }
      const doc = root.ownerDocument;
      this.zoneElement = doc ? doc.getElementById('zone') : null;
      if (doc && doc.defaultView) {
        doc.defaultView.addEventListener('resize', () => this.layoutZone());
      }
      const toggle = root.querySelector('.controls-toggle');
      if (toggle) {
        this.setControlsCollapsed(this.defaultCollapsed(), false);
        toggle.addEventListener('click', () => this.setControlsCollapsed(!this.controlsCollapsed, true));
        if (doc && doc.defaultView) {
          doc.defaultView.addEventListener('resize', () => {
            if (!this.userToggled) this.setControlsCollapsed(this.defaultCollapsed(), false);
            this.layoutControls();
          });
        }
      }
      this.refreshControls();
    }

    defaultCollapsed() {
      const doc = this.controls && this.controls.ownerDocument;
      const view = doc && doc.defaultView;
      return !!view && view.innerWidth < NARROW_WIDTH;
    }

    setControlsCollapsed(collapsed, byUser) {
      this.controlsCollapsed = collapsed;
      if (byUser) this.userToggled = true;
      const root = this.controls;
      if (!root) return;
      root.classList.toggle('collapsed', collapsed);
      const toggle = root.querySelector('.controls-toggle');
      if (toggle) toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      this.layoutControls();
    }

    layoutControls() {
      const root = this.controls;
      if (!root || this.controlsCollapsed) return;
      const body = root.querySelector('.controls-body');
      if (!body) return;
      const doc = root.ownerDocument;
      const pills = doc && doc.querySelector('.snacks');
      if (!pills) return;
      const room = pills.getBoundingClientRect().top - body.getBoundingClientRect().top - 12;
      const value = `${Math.max(120, Math.round(room))}px`;
      if (value !== this.controlsMax) {
        this.controlsMax = value;
        body.style.maxHeight = value;
      }
    }

    refreshControls() {
      const root = this.controls;
      if (!root) return;
      root.querySelectorAll('button[data-item]').forEach((button) => {
        const on = !!this.selection && this.selection.item === button.dataset.item && this.selection.by === button.dataset.by;
        button.setAttribute('aria-pressed', on ? 'true' : 'false');
        button.classList.toggle('active', on);
      });
      root.querySelectorAll('button[data-ref]').forEach((button) => {
        const on = button.dataset.ref === this.reference;
        button.setAttribute('aria-pressed', on ? 'true' : 'false');
        button.classList.toggle('active', on);
      });
      root.querySelectorAll('button[data-row]').forEach((button) => {
        const zone = this.zoneSelection;
        const on = !!zone && zone.row === Number(button.dataset.row) && zone.col === Number(button.dataset.col);
        button.setAttribute('aria-pressed', on ? 'true' : 'false');
        button.classList.toggle('active', on);
      });
      this.layoutZone();
      this.layoutControls();
      const info = root.querySelector('.info');
      const text = this.infoText();
      if (info && text !== this.shownInfo) {
        this.shownInfo = text;
        info.textContent = text;
        info.classList.toggle('shown', !!text);
        info.classList.toggle('warn', !!text && (text.endsWith('table.') || text.startsWith('I did not understand')));
      }
    }

    // Draw visuals, the selection highlight and the lingering "Stopped" tags.
    // Returns 0..1 beat energy.
    draw(ctx) {
      this.surface = { canvas: ctx.canvas, frame: canvasSize(ctx) };
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
        if (!snack.anchor) continue;
        const level = audio.levelAt(name, t);
        if (level < 0.01) continue;
        for (const age of audio.hitAges(name, t)) drawBeatRing(ctx, snack.anchor, ITEMS[name].color, age, level);
      }

      if (this.selection && this.isOnTable(this.selection.item) && this.snacks[this.selection.item].location) {
        drawHighlight(ctx, this.snacks[this.selection.item].location, now);
      }

      this.refreshControls();
      this._updateHud(beat);
      return energy;
    }

    pillsObstacle(ctx, frame) {
      const element = this.hud && this.hud.querySelector('.snacks');
      if (!element || !ctx.canvas.getBoundingClientRect) return null;
      const pills = element.getBoundingClientRect();
      if (!pills.width || !pills.height) return null;
      const rect = ctx.canvas.getBoundingClientRect();
      const topLeft = clientToFrame({ x: pills.left, y: pills.top }, rect, frame);
      const bottomRight = clientToFrame({ x: pills.right, y: pills.bottom }, rect, frame);
      return { left: topLeft.x, right: bottomRight.x, top: topLeft.y };
    }

    drawLabels(ctx) {
      const frame = canvasSize(ctx);
      const obstacle = this.pillsObstacle(ctx, frame);
      const now = this.now();
      const fontSize = Math.max(13, frame.width * 0.0155);
      const detailSize = fontSize * 0.84;
      const pad = fontSize * 0.45;
      const titleHeight = fontSize * 1.25;
      const detailHeight = detailSize * 1.25;
      const unit = highlightUnit(ctx);
      const selected = this.selection && this.isOnTable(this.selection.item) ? this.selection.item : null;
      const placed = [];

      for (const name of ORDER) {
        const snack = this.snacks[name];
        if (!snack.pos || !snack.anchor) continue;

        let alpha = 1;
        let title = ITEMS[name].label;
        let box;
        if (snack.phase === 'stopped') {
          const age = now - snack.stoppedAt;
          if (age > GHOST_MS) continue;
          alpha = 1 - age / GHOST_MS;
          title = `${title} · ${STATUS_TEXT.stopped}`;
          const half = snack.anchor.side / 2;
          box = { left: snack.anchor.x - half, right: snack.anchor.x + half, top: snack.anchor.y - half, bottom: snack.anchor.y + half };
        } else {
          const { topLeftCorner, topRightCorner, bottomRightCorner, bottomLeftCorner } = snack.location;
          box = boxOf([topLeftCorner, topRightCorner, bottomRightCorner, bottomLeftCorner]);
        }

        const avoid = name === selected ? highlightExtent(snack.location, unit) : box;
        const detail = positionLine(snack.pos, this.reference);

        ctx.save();
        ctx.font = `600 ${fontSize}px ${FONT_FAMILY}`;
        const titleWidth = ctx.measureText(title).width;
        ctx.font = `${detailSize}px ${FONT_FAMILY}`;
        const detailWidth = ctx.measureText(detail).width;
        const size = { width: Math.max(titleWidth, detailWidth) + pad * 2, height: titleHeight + detailHeight + pad * 2 };
        const first = layoutLabel(box, avoid, size, frame, fontSize * 0.5, obstacle);
        const { x, y } = placeLabel({ x: first.x, y: first.y, width: size.width, height: size.height }, placed, frame, fontSize * 0.15, obstacle, fontSize * 0.5);
        placed.push({ x, y, width: size.width, height: size.height });

        ctx.globalAlpha = alpha;
        ctx.fillStyle = 'rgba(0,0,0,0.74)';
        roundRect(ctx, x, y, size.width, size.height, fontSize * 0.3);
        ctx.fill();
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.font = `600 ${fontSize}px ${FONT_FAMILY}`;
        ctx.fillStyle = ITEMS[name].color;
        ctx.fillText(title, x + pad, y + pad);
        ctx.font = `${detailSize}px ${FONT_FAMILY}`;
        ctx.fillStyle = 'rgba(240,248,247,0.94)';
        ctx.fillText(detail, x + pad, y + pad + titleHeight);
        ctx.restore();
      }
    }

    hudText(snack) {
      const status = STATUS_TEXT[snack.phase];
      if (snack.phase !== 'playing' || !snack.pos) return status;
      const rhythm = snack.tier === null ? '' : ` · ${RHYTHM_TEXT[snack.tier]}`;
      return `${status} · ${panHint(snack.pos.x)}${rhythm}`;
    }

    _updateHud(beat) {
      if (!this.hud) return;
      for (const name of ORDER) {
        const snack = this.snacks[name];
        const text = this.hudText(snack);
        if (snack.hudPhase === snack.phase && snack.hudText === text) continue;
        snack.hudPhase = snack.phase;
        snack.hudText = text;
        const row = this.hud.querySelector(`.snack[data-name="${name}"]`);
        if (!row) continue;
        row.dataset.phase = snack.phase;
        row.querySelector('em').textContent = text;
      }
      const beatInBar = beat >= 0 ? Math.floor(beat) % 4 : -1;
      if (beatInBar !== this.hudBeat) {
        this.hudBeat = beatInBar;
        this.hud.querySelectorAll('.bar i').forEach((dot, i) => dot.classList.toggle('on', i === beatInBar));
      }
    }
  }

  const api = {
    SnackMachine, ITEMS, ORDER, CODE_TO_ITEM, pulse, REMOVE_AFTER_MS, FRAME_INTERVAL_FACTOR, FRAME_INTERVAL_SMOOTHING, FRAME_INTERVAL_CAP_MS, STATUS_TEXT,
    drawWater, drawCookie, drawCandy, drawHighlight, expandQuad,
    ZONE_NAMES, POSITION_SMOOTHING, zoneOf, toPercent, averageOfCorners, percentToScreen, positionLine,
    layoutLabel, highlightExtent, drawGrid, placeLabel, rectsOverlap, REFERENCES, positionSentence, clientToFrame,
    zoneRange, zoneSentence, cellBounds, parseDescription, regionSentence, regionBounds, regionName, boundsRange, panHint, tierFromY, nextTier, drawBeatRing, RHYTHM_TEXT,
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

// Dark particle scene: a thin dense band of teal/white specks across the
// middle, two faint arcs near the top and bottom, drifting dust and large soft
// bokeh spheres. `setEnergy(0..1)` makes the whole thing breathe with the beat.
(function (global) {
  const TAU = Math.PI * 2;

  const COLORS = {
    teal: '64,214,204',
    white: '208,246,240',
    blue: '66,118,236',
  };
  const ALPHAS = [0.34, 0.66, 0.97];

  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function gauss(rand) {
    return (rand() + rand() + rand() + rand() - 2) / 0.58;   // ~N(0,1)
  }

  function pick(rand, weights) {
    let r = rand() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r <= 0) return i;
    }
    return weights.length - 1;
  }

  function createBackground(canvas, options = {}) {
    const ctx = canvas.getContext('2d');
    const rand = mulberry32(20260930);
    const density = options.density || 1;

    // particle: kind, color index, alpha bucket, size and kind-specific params
    const particles = [];
    const colorNames = Object.keys(COLORS);

    function add(kind, p) {
      particles.push(Object.assign({ kind, color: 0, bucket: 1, size: 1 }, p));
    }

    // dense core band, seen almost edge-on: orbits slowly along x
    for (let i = 0; i < 2600 * density; i++) {
      const color = pick(rand, [60, 25, 15]) === 0 ? 'teal' : (rand() < 0.62 ? 'white' : 'blue');
      add('band', {
        theta: rand() * TAU,
        radius: 0.12 + Math.pow(rand(), 0.75) * 0.62,       // of width
        spread: gauss(rand) * (0.004 + 0.012 * rand()),       // of height, vertical scatter
        speed: 0.018 + 0.03 * rand(),
        color: colorNames.indexOf(color),
        bucket: rand() < 0.35 ? 2 : (rand() < 0.6 ? 1 : 0),
        size: rand() < 0.12 ? 2.4 : (rand() < 0.5 ? 1.6 : 1.1),
      });
    }

    // bright thin core line inside the band
    for (let i = 0; i < 700 * density; i++) {
      add('band', {
        theta: rand() * TAU,
        radius: 0.1 + Math.pow(rand(), 0.8) * 0.64,
        spread: gauss(rand) * 0.0035,
        speed: 0.03 + 0.04 * rand(),
        color: rand() < 0.55 ? colorNames.indexOf('white') : colorNames.indexOf('teal'),
        bucket: 2,
        size: rand() < 0.2 ? 2.4 : 1.5,
      });
    }

    // two faint arcs near the top and the bottom
    for (let arc = 0; arc < 2; arc++) {
      const sign = arc === 0 ? -1 : 1;
      for (let i = 0; i < 1300 * density; i++) {
        const color = arc === 0 ? (rand() < 0.5 ? 'teal' : 'white') : (rand() < 0.55 ? 'blue' : 'teal');
        add('arc', {
          phi: (sign < 0 ? Math.PI * 1.5 : Math.PI * 0.5) + (rand() - 0.5) * 2.2,
          sign,
          offset: gauss(rand) * 0.032,
          speed: (rand() - 0.5) * 0.02,
          color: colorNames.indexOf(color),
          bucket: rand() < 0.2 ? 2 : (rand() < 0.55 ? 1 : 0),
          size: rand() < 0.1 ? 2.2 : 1.2,
        });
      }
    }

    // drifting dust everywhere, denser around the middle
    for (let i = 0; i < 1500 * density; i++) {
      const color = rand() < 0.45 ? 'teal' : (rand() < 0.7 ? 'blue' : 'white');
      add('dust', {
        x: rand(),
        y: 0.5 + gauss(rand) * 0.26,
        vx: (rand() - 0.5) * 0.006,
        vy: (rand() - 0.5) * 0.004,
        color: colorNames.indexOf(color),
        bucket: rand() < 0.15 ? 2 : (rand() < 0.5 ? 1 : 0),
        size: rand() < 0.08 ? 2.8 : (rand() < 0.4 ? 1.8 : 1.1),
        twinkle: rand() * TAU,
      });
    }

    // crisp round dots, a bit larger than dust
    const orbs = [];
    for (let i = 0; i < 130 * density; i++) {
      orbs.push({
        x: rand(), y: 0.5 + gauss(rand) * 0.3,
        vx: (rand() - 0.5) * 0.004, vy: (rand() - 0.5) * 0.003,
        r: 1.6 + rand() * rand() * 4.2,
        a: 0.45 + rand() * 0.5,
        blue: rand() < 0.3,
      });
    }

    // soft bokeh spheres
    const bokeh = [];
    for (let i = 0; i < 26; i++) {
      const big = rand() < 0.26;
      bokeh.push({
        x: rand(),
        y: 0.5 + gauss(rand) * 0.2,
        r: big ? 0.034 + rand() * 0.04 : 0.008 + rand() * 0.014,   // of min(width,height)
        phase: rand() * TAU,
        speed: 0.12 + rand() * 0.25,
        amp: 0.006 + rand() * 0.02,
        alpha: 0.6 + rand() * 0.4,
        sparks: big ? 4 : (rand() < 0.3 ? 2 : 0),
        seed: rand(),
      });
    }

    // buckets of particle indices per (color, alpha), so fillStyle changes rarely
    const buckets = [];
    colorNames.forEach((c, ci) => ALPHAS.forEach((a, bi) => buckets.push({ ci, bi, items: [] })));
    particles.forEach((p) => buckets[p.color * ALPHAS.length + p.bucket].items.push(p));

    let W = 0;
    let H = 0;
    let dpr = 1;
    let energy = 0;
    let smoothEnergy = 0;
    let raf = 0;
    const t0 = performance.now();

    function resize() {
      dpr = Math.min(2, global.devicePixelRatio || 1);
      W = canvas.clientWidth || global.innerWidth;
      H = canvas.clientHeight || global.innerHeight;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function position(p, t) {
      const cx = W / 2;
      const cy = H * 0.52;
      if (p.kind === 'band') {
        const a = p.theta + t * p.speed;
        const r = p.radius * W;
        // slight perspective: the near side of the disc is a touch lower and larger
        return [cx + Math.cos(a) * r * 1.5, cy + Math.sin(a) * r * 0.035 + p.spread * H];
      }
      if (p.kind === 'arc') {
        const phi = p.phi + t * p.speed;
        const rx = W * 0.95 + p.offset * W;
        const ry = H * 0.46 + p.offset * H * 0.6;
        return [cx + Math.cos(phi) * rx, cy + Math.sin(phi) * ry];
      }
      let x = (p.x + p.vx * t) % 1;
      let y = (p.y + p.vy * t) % 1;
      if (x < 0) x += 1;
      if (y < 0) y += 1;
      return [x * W, y * H];
    }

    function drawHairlines() {
      ctx.fillStyle = 'rgba(190,230,225,0.07)';
      ctx.fillRect(0, H * 0.28, W * 0.3, 1);
      ctx.fillRect(0, H * 0.335, W * 0.42, 1);
      ctx.fillRect(0, H * 0.645, W * 0.36, 1);
    }

    function drawBokeh(t) {
      const m = Math.min(W, H);
      ctx.globalCompositeOperation = 'lighter';
      for (const b of bokeh) {
        const r = b.r * m * (1 + 0.1 * smoothEnergy);
        const x = b.x * W + Math.sin(t * b.speed * 0.6 + b.phase) * W * 0.01;
        const y = b.y * H + Math.sin(t * b.speed + b.phase) * H * b.amp;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, `rgba(222,250,246,${0.95 * b.alpha})`);
        g.addColorStop(0.62, `rgba(176,236,230,${0.78 * b.alpha})`);
        g.addColorStop(0.9, `rgba(120,214,208,${0.34 * b.alpha})`);
        g.addColorStop(1, 'rgba(110,210,205,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.fill();
        for (let s = 0; s < b.sparks; s++) {
          const ang = (b.seed * 97 + s * 2.4) % TAU;
          const d = r * (0.15 + 0.45 * ((b.seed * 31 + s * 0.37) % 1));
          ctx.fillStyle = 'rgba(255,255,255,0.85)';
          ctx.fillRect(x + Math.cos(ang) * d, y + Math.sin(ang) * d, 1.6, 1.6);
        }
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    function frame(now) {
      const t = (now - t0) / 1000;
      smoothEnergy += (energy - smoothEnergy) * 0.15;

      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#02050a';
      ctx.fillRect(0, 0, W, H);

      // faint vertical colour wash: teal haze at the top, blue at the bottom
      // soft teal glow behind the core band
      const glow = ctx.createLinearGradient(0, H * 0.4, 0, H * 0.64);
      glow.addColorStop(0, 'rgba(60,200,190,0)');
      glow.addColorStop(0.5, `rgba(60,200,190,${0.10 + 0.08 * smoothEnergy})`);
      glow.addColorStop(1, 'rgba(60,200,190,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, H * 0.4, W, H * 0.24);

      const wash = ctx.createLinearGradient(0, 0, 0, H);
      wash.addColorStop(0, 'rgba(20,70,80,0.18)');
      wash.addColorStop(0.5, 'rgba(0,0,0,0)');
      wash.addColorStop(1, 'rgba(20,45,110,0.20)');
      ctx.fillStyle = wash;
      ctx.fillRect(0, 0, W, H);

      drawHairlines();

      const boost = 1 + 0.55 * smoothEnergy;
      for (const bucket of buckets) {
        if (!bucket.items.length) continue;
        const alpha = Math.min(1, ALPHAS[bucket.bi] * boost);
        ctx.fillStyle = `rgba(${COLORS[colorNames[bucket.ci]]},${alpha})`;
        for (const p of bucket.items) {
          const pos = position(p, t);
          const s = p.size;
          if (pos[0] < -4 || pos[0] > W + 4 || pos[1] < -4 || pos[1] > H + 4) continue;
          if (p.kind === 'dust' && Math.sin(t * 1.3 + p.twinkle) < -0.55) continue;   // twinkle
          ctx.fillRect(pos[0], pos[1], s, s);
        }
      }

      for (const o of orbs) {
        const x = (((o.x + o.vx * t) % 1) + 1) % 1 * W;
        const y = (((o.y + o.vy * t) % 1) + 1) % 1 * H;
        ctx.fillStyle = o.blue ? `rgba(70,130,240,${o.a * 0.8})` : `rgba(70,215,205,${o.a})`;
        ctx.beginPath();
        ctx.arc(x, y, o.r * (1 + 0.15 * smoothEnergy), 0, TAU);
        ctx.fill();
      }

      drawBokeh(t);
      raf = global.requestAnimationFrame(frame);
    }

    resize();
    global.addEventListener('resize', resize);

    return {
      start() { if (!raf) raf = global.requestAnimationFrame(frame); },
      stop() { global.cancelAnimationFrame(raf); raf = 0; },
      setEnergy(e) { energy = Math.max(0, Math.min(1, e)); },
      resize,
      renderOnce(ms) { frame(t0 + (ms || 0)); global.cancelAnimationFrame(raf); raf = 0; },
    };
  }

  global.createBackground = createBackground;
})(typeof window !== 'undefined' ? window : globalThis);

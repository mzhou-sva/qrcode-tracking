const MISSING_MS = 400;
const FADE_SECONDS = 0.08;

const SNACKS = {
  water: {
    code: 'phone',
    file: 'sounds/water.m4a',
    color: '80, 170, 255',
    label: 'Water',
    soundLabel: 'Gulp',
    info: 'the sound of drinking water',
  },
  candy: {
    code: 'object-a',
    file: 'sounds/candy.m4a',
    color: '255, 95, 162',
    label: 'Candy',
    soundLabel: 'Crackle',
    info: 'the sound of crunching amber candy',
  },
  cookie: {
    code: 'object-b',
    file: 'sounds/cookie.m4a',
    color: '201, 139, 74',
    label: 'Cookie',
    soundLabel: 'Crunch',
    info: 'the sound of biting a cookie',
  },
};

const startButton = document.getElementById('start');
const infoLine = document.getElementById('info');
const snackState = {};
const snackByCode = {};
for (const [name, snack] of Object.entries(SNACKS)) {
  snackState[name] = { active: false, lastSeen: -Infinity, location: null, gain: null, analyser: null, samples: null, peak: 0.01, level: 0 };
  snackByCode[snack.code] = name;
}

let selectedSnack = null;

let audioCtx = null;
let lastUpdate = 0;
let frameMs = 0;

startButton.addEventListener('click', startSnacks);
buildSelectors();

function buildSelectors() {
  const groups = [
    ['by-object', 'label'],
    ['by-sound', 'soundLabel'],
  ];
  for (const [id, field] of groups) {
    const group = document.getElementById(id);
    for (const [name, snack] of Object.entries(SNACKS)) {
      const button = document.createElement('button');
      button.textContent = snack[field];
      button.dataset.snack = name;
      button.addEventListener('click', () => selectSnack(name));
      group.appendChild(button);
    }
  }
}

function selectSnack(name) {
  selectedSnack = selectedSnack === name ? null : name;
  for (const button of document.querySelectorAll('#controls button[data-snack]')) {
    button.classList.toggle('selected', button.dataset.snack === selectedSnack);
  }
}

function snackLabel(data) {
  const name = snackByCode[data.trim()];
  return name ? SNACKS[name].label : data;
}

function snackLabelGap(data, size) {
  const name = snackByCode[data.trim()];
  return name && name === selectedSnack ? size * 0.24 : 0;
}

function updateInfo() {
  let text = '';
  if (selectedSnack) {
    const snack = SNACKS[selectedSnack];
    text = snackState[selectedSnack].active
      ? `${snack.label}: ${snack.info}`
      : `${snack.label} is not on the table.`;
  }
  if (infoLine.textContent !== text) {
    infoLine.textContent = text;
  }
}

async function startSnacks() {
  startButton.disabled = true;
  startButton.textContent = 'Loading…';

  try {
    audioCtx = new AudioContext();
    const buffers = await Promise.all(
      Object.values(SNACKS).map(async ({ file }) => {
        const response = await fetch(file);
        return audioCtx.decodeAudioData(await response.arrayBuffer());
      })
    );

    await audioCtx.resume();

    Object.keys(SNACKS).forEach((name, i) => {
      const source = audioCtx.createBufferSource();
      source.buffer = buffers[i];
      source.loop = true;
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      const gain = audioCtx.createGain();
      gain.gain.value = 0;
      source.connect(analyser).connect(gain).connect(audioCtx.destination);
      source.start();
      const state = snackState[name];
      state.gain = gain;
      state.analyser = analyser;
      state.samples = new Float32Array(analyser.fftSize);
      if (state.active) {
        setLayer(state, true);
      }
    });

    startButton.hidden = true;
  } catch (error) {
    console.error('Unable to start audio:', error);
    audioCtx = null;
    startButton.disabled = false;
    startButton.textContent = 'Audio failed — tap to retry';
  }
}

function setLayer(state, on) {
  if (!state.gain) {
    return;
  }

  const param = state.gain.gain;
  const now = audioCtx.currentTime;
  param.cancelScheduledValues(now);
  param.setValueAtTime(param.value, now);

  if (on) {
    param.linearRampToValueAtTime(1, now + FADE_SECONDS);
  } else {
    param.linearRampToValueAtTime(0, now + FADE_SECONDS);
  }
}

function updateSnacks(codes) {
  const now = performance.now();
  if (lastUpdate) {
    const elapsed = now - lastUpdate;
    frameMs = frameMs ? frameMs * 0.8 + elapsed * 0.2 : elapsed;
  }
  lastUpdate = now;
  const grace = Math.max(MISSING_MS, frameMs * 3);

  for (const qrCode of codes) {
    const state = snackState[snackByCode[qrCode.data.trim()]];
    if (state) {
      state.lastSeen = now;
      state.location = qrCode.location;
    }
  }

  for (const state of Object.values(snackState)) {
    const present = now - state.lastSeen < grace;
    if (present !== state.active) {
      state.active = present;
      if (audioCtx) {
        setLayer(state, present);
      }
    }
  }
}

function updateLevel(state) {
  if (!state.analyser) {
    return;
  }

  state.analyser.getFloatTimeDomainData(state.samples);
  let sum = 0;
  for (const sample of state.samples) {
    sum += sample * sample;
  }
  const rms = Math.sqrt(sum / state.samples.length);
  state.peak = Math.max(state.peak * 0.995, rms, 0.01);
  state.level = Math.max(rms / state.peak, state.level * 0.8);
}

function drawSnacks(ctx) {
  updateInfo();

  const clock = performance.now() / 1000;

  for (const [name, state] of Object.entries(snackState)) {
    if (!state.active || !state.location) {
      continue;
    }

    updateLevel(state);
    const center = centerOf(state.location);
    const size = codeSize(state.location);
    const color = SNACKS[name].color;

    if (name === 'water') {
      drawRipples(ctx, center, size, clock, state.level, color);
    } else if (name === 'cookie') {
      drawBlocks(ctx, center, size, state.level, color);
    } else {
      drawDots(ctx, center, size, clock, state.level, color);
    }

    if (name === selectedSnack) {
      drawHighlight(ctx, state.location, size);
    }
  }
}

function drawHighlight(ctx, location, size) {
  const { topLeftCorner, topRightCorner, bottomRightCorner, bottomLeftCorner } = location;
  const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 150);
  const grow = size * (0.12 + pulse * 0.06);
  const center = centerOf(location);
  const expand = (point) => {
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    const length = Math.hypot(dx, dy) || 1;
    return { x: point.x + (dx / length) * grow, y: point.y + (dy / length) * grow };
  };

  const corners = [topLeftCorner, topRightCorner, bottomRightCorner, bottomLeftCorner].map(expand);
  ctx.beginPath();
  ctx.moveTo(corners[0].x, corners[0].y);
  for (const corner of corners.slice(1)) {
    ctx.lineTo(corner.x, corner.y);
  }
  ctx.closePath();

  const width = Math.max(6, size * 0.08);
  ctx.strokeStyle = '#000';
  ctx.lineWidth = width * 1.8;
  ctx.stroke();
  ctx.strokeStyle = `rgba(255, 230, 0, ${0.7 + pulse * 0.3})`;
  ctx.lineWidth = width;
  ctx.stroke();
}

function drawRipples(ctx, center, size, clock, level, color) {
  ctx.lineWidth = Math.max(4, size * (0.03 + level * 0.06));
  for (let ring = 0; ring < 2; ring++) {
    const p = (clock * 0.8 + ring * 0.5) % 1;
    ctx.strokeStyle = `rgba(${color}, ${(1 - p) * (0.3 + level * 0.7)})`;
    ctx.beginPath();
    ctx.arc(center.x, center.y, size * (0.8 + p * 1.6), 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawBlocks(ctx, center, size, hit, color) {
  const block = size * 0.3 * (1 + hit * 0.5);
  const reach = size * (1.1 + hit * 0.5);
  ctx.fillStyle = `rgba(${color}, ${0.55 + hit * 0.45})`;
  for (let i = 0; i < 4; i++) {
    const angle = Math.PI / 4 + (i * Math.PI) / 2;
    const x = center.x + Math.cos(angle) * reach;
    const y = center.y + Math.sin(angle) * reach - hit * size * 0.25;
    ctx.fillRect(x - block / 2, y - block / 2, block, block);
  }
}

function drawDots(ctx, center, size, clock, bounce, color) {
  const count = 8;
  const radius = size * 0.13;
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + clock * 0.8;
    const reach = size * (0.85 + bounce * 0.3);
    const x = center.x + Math.cos(angle) * reach;
    const y = center.y + Math.sin(angle) * reach;
    ctx.fillStyle = `hsla(${(i * 360) / count + clock * 30}, 90%, 62%, 0.9)`;
    ctx.beginPath();
    ctx.arc(x, y, radius * (0.7 + bounce * 0.6), 0, Math.PI * 2);
    ctx.fill();
  }
}

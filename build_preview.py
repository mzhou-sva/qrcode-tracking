"""Build preview.html: one self-contained page that shows the UI with the real audio and
drawing code, without a camera.  Click a pill at the bottom to put a code on the table or
take it away; the By object / By sound buttons in the corner work exactly like the real page.
Usage: python3 build_preview.py"""
import base64, os
here = os.path.dirname(os.path.abspath(__file__))
read = lambda p: open(os.path.join(here, p), encoding='utf-8').read()
css = read('style.css')
js = '\n'.join(read(f) for f in ('audio.js', 'background.js', 'snacks.js'))
wav = {n: base64.b64encode(open(os.path.join(here, 'sounds', f'{n}.wav'), 'rb').read()).decode() for n in ('water', 'candy', 'cookie')}

driver = r'''
const WAV = %s;
const overlay = document.getElementById('overlay');
const octx = overlay.getContext('2d');
const background = createBackground(document.getElementById('bg'));
background.start();
let audio = null, machine = null, dpr = 1;
// payloads as printed on the code sheet: phone = Water, object-a = Candy, object-b = Cookie, bottle = unused
const PAYLOAD = { water: 'phone', candy: 'object-a', cookie: 'object-b', bottle: 'bottle' };
const placed = { water: false, candy: false, cookie: false, bottle: false };
const SLOT = { water: 0.16, candy: 0.38, cookie: 0.6, bottle: 0.82 };
const startButton = document.getElementById('startButton');
const startMessage = document.getElementById('startMessage');

function resize() {
  dpr = Math.min(2, window.devicePixelRatio || 1);
  overlay.width = Math.round(innerWidth * dpr);
  overlay.height = Math.round(innerHeight * dpr);
}
addEventListener('resize', resize); resize();

function b64ToBuffer(b64) {
  const bin = atob(b64), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

startButton.addEventListener('click', async () => {
  startButton.disabled = true;
  audio = new SnackAudio({ loadBuffer: async (name) => b64ToBuffer(WAV[name]) });
  audio.createContext();
  startMessage.textContent = 'loading sounds…';
  await audio.loadAll(SNACK_ORDER);
  machine = new SnackMachine(audio, document.getElementById('hud'));
  machine.bindControls(document.getElementById('controls'));
  document.body.classList.add('live');
  document.getElementById('start').classList.add('hidden');
  requestAnimationFrame(tick);
});

document.querySelectorAll('.snack, #unused').forEach((el) => {
  el.addEventListener('click', () => {
    const name = el.dataset.name || 'bottle';
    placed[name] = !placed[name];
    el.classList.toggle('placed', placed[name]);
  });
});

// a stand-in QR code: finder squares + a few modules, boxed like the real page does
function drawFakeCode(cx, cy, side, boxColor, label, labelColor) {
  octx.save();
  octx.fillStyle = 'rgba(255,255,255,0.10)';
  octx.fillRect(cx - side / 2, cy - side / 2, side, side);
  const n = 21, m = side / n, x0 = cx - side / 2, y0 = cy - side / 2;
  octx.fillStyle = 'rgba(235,250,248,0.55)';
  const finder = (fx, fy) => { octx.fillRect(x0 + fx * m, y0 + fy * m, 7 * m, 7 * m); octx.clearRect(x0 + (fx + 1) * m, y0 + (fy + 1) * m, 5 * m, 5 * m); octx.fillRect(x0 + (fx + 2) * m, y0 + (fy + 2) * m, 3 * m, 3 * m); };
  finder(0, 0); finder(14, 0); finder(0, 14);
  let seed = Math.round(cx) * 31;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if ((x < 8 && y < 8) || (x > 12 && y < 8) || (x < 8 && y > 12)) continue;
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    if (seed %% 5 < 2) octx.fillRect(x0 + x * m, y0 + y * m, m, m);
  }
  octx.strokeStyle = boxColor; octx.lineWidth = 2;
  octx.strokeRect(x0, y0, side, side);
  if (label) {
    const fs = Math.max(11, Math.min(side * 0.17, 17));
    octx.font = fs + 'px "Helvetica Neue","Noto Sans CJK SC",Arial,sans-serif'; octx.textBaseline = 'top';
    const tw = octx.measureText(label).width, p = fs * 0.25;
    octx.fillStyle = 'rgba(0,0,0,0.6)'; octx.fillRect(x0 - p, y0 + side + p, tw + 2 * p, fs + 2 * p);
    octx.fillStyle = labelColor; octx.fillText(label, x0, y0 + side + 2 * p);
  }
  octx.restore();
}

function tick() {
  const W = overlay.width / dpr, H = overlay.height / dpr;
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  octx.clearRect(0, 0, W, H);
  const side = Math.min(W / 5.2, H * 0.2), cy = H * 0.46;
  const codes = Object.keys(placed).filter((n) => placed[n]).map((n) => {
    const cx = W * SLOT[n];
    return { data: PAYLOAD[n], location: { topLeftCorner: { x: cx - side / 2, y: cy - side / 2 }, topRightCorner: { x: cx + side / 2, y: cy - side / 2 },
      bottomRightCorner: { x: cx + side / 2, y: cy + side / 2 }, bottomLeftCorner: { x: cx - side / 2, y: cy + side / 2 } } };
  });
  machine.update(codes);
  background.setEnergy(machine.draw(octx));
  for (const c of codes) {
    const d = machine.describe(c.data);
    const cx = (c.location.topLeftCorner.x + c.location.bottomRightCorner.x) / 2;
    drawFakeCode(cx, cy, side, d ? d.color : '#7ff0e4', d ? d.text : '', d ? d.color : '');
  }
  requestAnimationFrame(tick);
}
''' % ('{' + ','.join(f'"{k}":"{v}"' for k, v in wav.items()) + '}')

html = f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Snack beat machine - UI preview</title>
<style>
{css}
/* preview only: the pills at the bottom put a code on the table / take it away */
.snacks, .snack {{ pointer-events: auto; cursor: pointer; }}
.snack.placed {{ border-color: rgba(255,255,255,0.45); }}
#unused {{ position: fixed; z-index: 3; left: 18px; top: calc(env(safe-area-inset-top, 0px) + 16px); font: 400 12px var(--serif); letter-spacing: 0.14em;
  color: var(--ink-dim); background: rgba(2,8,14,0.45); border: 1px dashed rgba(255,255,255,0.22); border-radius: 999px; padding: 0.6em 1.2em; cursor: pointer; opacity: 0; transition: opacity 1s ease 0.6s; }}
.live #unused {{ opacity: 1; }}
#unused.placed {{ color: #7ff0e4; border-color: #7ff0e4; }}
.hint {{ position: fixed; left: 50%; bottom: calc(env(safe-area-inset-bottom, 0px) + 84px); transform: translateX(-50%); z-index: 3; width: min(90vw, 560px);
  font-size: clamp(11px, 1.35vw, 14px); letter-spacing: 0.16em; color: var(--ink-dim); opacity: 0; transition: opacity 1s ease 0.8s; text-align: center; pointer-events: none; line-height: 1.8; }}
.live .hint {{ opacity: 1; }}
@media (max-width: 640px) {{ .hint {{ bottom: calc(env(safe-area-inset-bottom, 0px) + 168px); }} #unused {{ left: 10px; top: calc(env(safe-area-inset-top, 0px) + 12px); padding: 0.4em 0.9em; font-size: 11px; }} }}
#webcam {{ display: none; }}
</style>
</head>
<body>
<canvas id="bg"></canvas>
<video id="webcam"></video>
<canvas id="overlay"></canvas>
<div id="hud">
  <div class="whisper"><p>S N A C K &nbsp;·&nbsp; B E A T &nbsp;·&nbsp; M A C H I N E</p><p>Put a snack on the table to start playing.</p></div>
  <div class="bar" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
  <ul class="snacks">
    <li class="snack" data-name="water" data-phase="stopped"><i class="dot"></i><b>Water</b><em>Stopped</em></li>
    <li class="snack" data-name="candy" data-phase="stopped"><i class="dot"></i><b>Candy</b><em>Stopped</em></li>
    <li class="snack" data-name="cookie" data-phase="stopped"><i class="dot"></i><b>Cookie</b><em>Stopped</em></li>
  </ul>
</div>
<div id="controls" class="controls">
  <div class="row"><span class="row-label">By object</span>
    <button type="button" data-by="object" data-item="water" aria-pressed="false">Water</button>
    <button type="button" data-by="object" data-item="candy" aria-pressed="false">Candy</button>
    <button type="button" data-by="object" data-item="cookie" aria-pressed="false">Cookie</button></div>
  <div class="row"><span class="row-label">By sound</span>
    <button type="button" data-by="sound" data-item="water" aria-pressed="false">Gulp</button>
    <button type="button" data-by="sound" data-item="candy" aria-pressed="false">Crackle</button>
    <button type="button" data-by="sound" data-item="cookie" aria-pressed="false">Crunch</button></div>
  <p class="info" role="status" aria-live="polite"></p>
</div>
<button id="unused" type="button">+ unused code (box only)</button>
<p class="hint">Preview only: click Water / Candy / Cookie at the bottom to put a code on the table or take it away. The real page uses the camera.</p>
<div id="start"><button id="startButton" type="button">[ Tap to start ]</button><p id="startMessage"></p></div>
<script>
{js}
{driver}
</script>
</body>
</html>
'''
open(os.path.join(here, 'preview.html'), 'w', encoding='utf-8').write(html)
print('preview.html', round(len(html) / 1e6, 2), 'MB')

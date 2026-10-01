const video = document.getElementById('webcam');
const overlay = document.getElementById('overlay');
const overlayCtx = overlay.getContext('2d');

let sampleCanvas;
let sampleCtx;
// Scan-canvas pixels per original-frame pixel (frame is shrunk to SCAN_WIDTH).
let scale = 1;
// Measured side length of one QR code, in scan-canvas pixels. null = unknown.
let codeSide = null;

const VIDEO_CONSTRAINTS = {
  video: {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
  },
  audio: false,
};

// The frame is shrunk to this width before scanning; boxes are drawn back
// onto the original-size overlay by dividing coordinates by `scale`.
const SCAN_WIDTH = 960;
// Once one code has been decoded and measured, all codes are assumed to be
// the same size: the frame is cut into windows of 1.5x the side, stepping by
// 0.4x the side, and every window is scanned.
const WINDOW_RATIO = 1.5;
const STEP_RATIO = 0.4;
// Two detections whose centers are closer than this (times the side) are the
// same code.
const SAME_CODE_RATIO = 0.6;
// Window sizes used only to find the first code when the size is unknown.
const SEARCH_WINDOW_SIZES = [320, 480, 640];
// Safety cap on decode-whiteout-rescan cycles within a single window.
const MAX_DECODES_PER_WINDOW = 12;

const LABEL_FONT = '"Helvetica Neue","Noto Sans CJK SC",Arial,sans-serif';

// Snack rhythm machine (audio.js, snacks.js, background.js).
const background = createBackground(document.getElementById('bg'));
background.start();
let audio = null;
let machine = null;

const startScreen = document.getElementById('start');
const startButton = document.getElementById('startButton');
const startMessage = document.getElementById('startMessage');

startButton.addEventListener('click', async () => {
  startButton.disabled = true;
  startMessage.textContent = '';

  try {
    if (!audio) {
      audio = new SnackAudio();
      audio.createContext();          // must happen inside the tap
      startMessage.textContent = 'loading sounds…';
      await audio.loadAll(SNACK_ORDER);
      machine = new SnackMachine(audio, document.getElementById('hud'));
      machine.bindControls(document.getElementById('controls'));
    }
  } catch (error) {
    console.error('Unable to load sounds:', error);
    audio = null;
    startMessage.textContent = 'Could not load the sounds. Open this page through http://localhost and check that sounds/ has water.wav, candy.wav and cookie.wav.';
    startButton.disabled = false;
    return;
  }

  try {
    startMessage.textContent = 'opening camera…';
    await startCamera();
  } catch (error) {
    console.error('Unable to access webcam:', error);
    startMessage.textContent = 'Could not open the camera. Allow camera access, then tap again.';
    startButton.disabled = false;
    return;
  }

  document.body.classList.add('live');
  startScreen.classList.add('hidden');
});

// The camera and the audio are only started from the "Tap to start" handler.
function startCamera() {
  return navigator.mediaDevices.getUserMedia(VIDEO_CONSTRAINTS).then((stream) => {
    video.srcObject = stream;
  });
}

video.addEventListener('loadedmetadata', () => {
  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;

  scale = Math.min(1, SCAN_WIDTH / video.videoWidth);
  sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = Math.round(video.videoWidth * scale);
  sampleCanvas.height = Math.round(video.videoHeight * scale);
  sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });

  requestAnimationFrame(tick);
});

function tick() {
  if (video.readyState === video.HAVE_ENOUGH_DATA) {
    sampleCtx.drawImage(video, 0, 0, sampleCanvas.width, sampleCanvas.height);

    overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
    const qrCodes = scanForQRCodes();
    if (machine) {
      machine.update(qrCodes);
      background.setEnergy(machine.draw(overlayCtx));
    }
    for (const qrCode of qrCodes) {
      const snack = machine && machine.describe(qrCode.data);
      drawBox(qrCode.location, snack ? snack.color : undefined);
      if (snack) {
        drawLabel(qrCode.location, snack.text, snack.color);
      }
    }
    drawCount(qrCodes.length);
  }

  requestAnimationFrame(tick);
}

// Returns detections with locations in original-frame coordinates.
function scanForQRCodes() {
  if (codeSide === null) {
    codeSide = measureCodeSide();
  }
  if (codeSide === null) {
    return [];
  }

  const size = Math.round(codeSide * WINDOW_RATIO);
  const step = codeSide * STEP_RATIO;
  const xs = getTilePositions(sampleCanvas.width, size, step);
  const ys = getTilePositions(sampleCanvas.height, size, step);
  const detections = [];

  for (const y of ys) {
    for (const x of xs) {
      scanWindow(x, y, size, detections);
    }
  }

  const unique = dedupeDetections(detections, codeSide);
  if (unique.length === 0) {
    // Nothing found: the measured size may be stale, so measure again next frame.
    codeSide = null;
  }

  return unique.map(toOriginalCoordinates);
}

// Find any one code with a few coarse window sizes and return its side length
// (scan-canvas pixels), or null if none can be decoded.
function measureCodeSide() {
  for (const size of SEARCH_WINDOW_SIZES) {
    const xs = getTilePositions(sampleCanvas.width, size, size / 2);
    const ys = getTilePositions(sampleCanvas.height, size, size / 2);

    for (const y of ys) {
      for (const x of xs) {
        const qrCode = decodeWindow(x, y, size);
        if (qrCode) {
          return sideOf(qrCode.location);
        }
      }
    }
  }

  return null;
}

function decodeWindow(x, y, size) {
  const width = Math.min(size, sampleCanvas.width - x);
  const height = Math.min(size, sampleCanvas.height - y);
  const tile = sampleCtx.getImageData(x, y, width, height);
  const qrCode = jsQR(tile.data, width, height);
  return qrCode ? offsetQRCode(qrCode, x, y) : null;
}

// Decode one window. jsQR returns a single code per call, so after each
// successful decode the code is painted white on the sample canvas and the
// same window is scanned again until nothing more is found. The painting
// persists for the rest of the frame.
function scanWindow(x, y, size, detections) {
  for (let i = 0; i < MAX_DECODES_PER_WINDOW; i++) {
    const found = decodeWindow(x, y, size);
    if (!found) {
      return;
    }

    detections.push(found);
    whiteOut(found.location);
  }
}

function whiteOut(location) {
  const corners = [
    location.topLeftCorner,
    location.topRightCorner,
    location.bottomRightCorner,
    location.bottomLeftCorner,
  ];
  const cx = corners.reduce((sum, p) => sum + p.x, 0) / 4;
  const cy = corners.reduce((sum, p) => sum + p.y, 0) / 4;

  // Grow the polygon a little so the code's edge modules are fully covered.
  const GROW = 1.08;
  sampleCtx.fillStyle = '#ffffff';
  sampleCtx.beginPath();
  corners.forEach((p, index) => {
    const x = cx + (p.x - cx) * GROW;
    const y = cy + (p.y - cy) * GROW;
    if (index === 0) {
      sampleCtx.moveTo(x, y);
    } else {
      sampleCtx.lineTo(x, y);
    }
  });
  sampleCtx.closePath();
  sampleCtx.fill();
}

// Start offsets for windows of `size` covering `dimension`, advancing by
// `step`, with a final window flush against the far edge so the whole frame
// is covered even when it doesn't divide evenly by the step.
function getTilePositions(dimension, size, step) {
  if (dimension <= size) {
    return [0];
  }

  const positions = [];
  for (let pos = 0; pos + size <= dimension; pos += step) {
    positions.push(Math.round(pos));
  }

  const lastPosition = dimension - size;
  if (positions[positions.length - 1] !== lastPosition) {
    positions.push(lastPosition);
  }

  return positions;
}

function offsetQRCode(qrCode, offsetX, offsetY) {
  const shift = (point) => ({ x: point.x + offsetX, y: point.y + offsetY });
  const { topLeftCorner, topRightCorner, bottomRightCorner, bottomLeftCorner } = qrCode.location;

  return {
    data: qrCode.data,
    location: {
      topLeftCorner: shift(topLeftCorner),
      topRightCorner: shift(topRightCorner),
      bottomRightCorner: shift(bottomRightCorner),
      bottomLeftCorner: shift(bottomLeftCorner),
    },
  };
}

function toOriginalCoordinates(detection) {
  const grow = (point) => ({ x: point.x / scale, y: point.y / scale });
  const { topLeftCorner, topRightCorner, bottomRightCorner, bottomLeftCorner } = detection.location;

  return {
    data: detection.data,
    location: {
      topLeftCorner: grow(topLeftCorner),
      topRightCorner: grow(topRightCorner),
      bottomRightCorner: grow(bottomRightCorner),
      bottomLeftCorner: grow(bottomLeftCorner),
    },
  };
}

// Side length of a code: the mean of its four edge lengths.
function sideOf({ topLeftCorner, topRightCorner, bottomRightCorner, bottomLeftCorner }) {
  const edges = [
    [topLeftCorner, topRightCorner],
    [topRightCorner, bottomRightCorner],
    [bottomRightCorner, bottomLeftCorner],
    [bottomLeftCorner, topLeftCorner],
  ];
  const total = edges.reduce((sum, [a, b]) => sum + Math.hypot(b.x - a.x, b.y - a.y), 0);
  return total / 4;
}

function dedupeDetections(detections, side) {
  const unique = [];

  for (const detection of detections) {
    const center = centerOf(detection.location);
    const isDuplicate = unique.some((existing) => {
      const existingCenter = centerOf(existing.location);
      const distance = Math.hypot(center.x - existingCenter.x, center.y - existingCenter.y);
      return distance < side * SAME_CODE_RATIO;
    });

    if (!isDuplicate) {
      unique.push(detection);
    }
  }

  return unique;
}

function centerOf(location) {
  const { topLeftCorner, bottomRightCorner } = location;
  return {
    x: (topLeftCorner.x + bottomRightCorner.x) / 2,
    y: (topLeftCorner.y + bottomRightCorner.y) / 2,
  };
}

function drawBox(location, color = '#7ff0e4') {
  const { topLeftCorner, topRightCorner, bottomRightCorner, bottomLeftCorner } = location;

  overlayCtx.strokeStyle = color;
  overlayCtx.lineWidth = Math.max(2, overlay.width * 0.0025);
  overlayCtx.beginPath();
  overlayCtx.moveTo(topLeftCorner.x, topLeftCorner.y);
  overlayCtx.lineTo(topRightCorner.x, topRightCorner.y);
  overlayCtx.lineTo(bottomRightCorner.x, bottomRightCorner.y);
  overlayCtx.lineTo(bottomLeftCorner.x, bottomLeftCorner.y);
  overlayCtx.closePath();
  overlayCtx.stroke();
}

function drawLabel(location, text, color = '#7ff0e4') {
  const { bottomLeftCorner, bottomRightCorner } = location;

  const fontSize = Math.max(16, overlay.width * 0.02);
  const padding = fontSize * 0.25;
  const x = Math.min(bottomLeftCorner.x, bottomRightCorner.x);
  const y = Math.max(bottomLeftCorner.y, bottomRightCorner.y) + padding;

  overlayCtx.font = `${fontSize}px ${LABEL_FONT}`;
  overlayCtx.textBaseline = 'top';
  const textWidth = overlayCtx.measureText(text).width;

  overlayCtx.fillStyle = 'rgba(0, 0, 0, 0.6)';
  overlayCtx.fillRect(x - padding, y - padding, textWidth + padding * 2, fontSize + padding * 2);

  overlayCtx.fillStyle = color;
  overlayCtx.fillText(text, x, y);
}

function drawCount(count) {
  const fontSize = Math.max(20, overlay.width * 0.025);
  const padding = fontSize * 0.3;
  const text = `QR codes: ${count}`;

  overlayCtx.font = `${fontSize}px monospace`;
  overlayCtx.textBaseline = 'top';
  const textWidth = overlayCtx.measureText(text).width;

  overlayCtx.fillStyle = 'rgba(0, 0, 0, 0.6)';
  overlayCtx.fillRect(padding, padding, textWidth + padding * 2, fontSize + padding * 2);

  overlayCtx.fillStyle = '#7ff0e4';
  overlayCtx.fillText(text, padding * 2, padding * 2);
}

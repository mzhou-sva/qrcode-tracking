const video = document.getElementById('webcam');
const overlay = document.getElementById('overlay');
const overlayCtx = overlay.getContext('2d');

let sampleCanvas;
let sampleCtx;

const VIDEO_CONSTRAINTS = {
  video: {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
  },
  audio: false,
};

// jsQR misses a code when the window is the wrong size or the code sits on
// the edge. The codes on one sheet are the same size, so find any one,
// measure it, and cut the rest of the frame to match.
const COARSE_WINDOWS = [160, 240, 340, 460];
const MAX_CODES_PER_WINDOW = 4;
let fittedWindow = null;

navigator.mediaDevices.getUserMedia(VIDEO_CONSTRAINTS)
  .then((stream) => {
    video.srcObject = stream;
  })
  .catch((error) => {
    console.error('Unable to access webcam:', error);
  });

video.addEventListener('loadedmetadata', () => {
  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;

  // Scan a smaller copy. The boxes are scaled back up to the video.
  const scanScale = Math.min(1, 960 / video.videoWidth);
  sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = Math.round(video.videoWidth * scanScale);
  sampleCanvas.height = Math.round(video.videoHeight * scanScale);
  sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });

  requestAnimationFrame(tick);
});

function tick() {
  if (video.readyState === video.HAVE_ENOUGH_DATA) {
    sampleCtx.drawImage(video, 0, 0, sampleCanvas.width, sampleCanvas.height);

    overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
    const codes = scanForQRCodes();
    for (const qrCode of codes) {
      drawBox(qrCode.location);
      drawLabel(qrCode.location, qrCode.data);
    }
    drawCount(codes.length);
  }

  requestAnimationFrame(tick);
}

function scanForQRCodes() {
  const { width, height } = sampleCanvas;
  const frame = sampleCtx.getImageData(0, 0, width, height);

  if (!fittedWindow) {
    fittedWindow = findFittedWindow(frame.data, width, height);
  }
  if (!fittedWindow) {
    return [];
  }

  const detections = [];
  scanTiles(frame.data, width, height, fittedWindow.tile, fittedWindow.step, detections);
  const unique = dedupeDetections(detections, fittedWindow.code * 0.6);

  if (unique.length === 0) {
    fittedWindow = null;
  }

  const scaleX = overlay.width / width;
  const scaleY = overlay.height / height;
  return unique.map((detection) => scaleDetection(detection, scaleX, scaleY));
}

// Look with a few window sizes until one code shows up, then copy its size.
function findFittedWindow(frame, width, height) {
  for (const tile of COARSE_WINDOWS) {
    const step = Math.round(tile * 0.5);
    const tileW = Math.min(tile, width);
    const tileH = Math.min(tile, height);
    for (const y of getTilePositions(height, tileH, step)) {
      for (const x of getTilePositions(width, tileW, step)) {
        const hit = readWindow(frame, width, x, y, tileW, tileH)[0];
        if (hit) {
          const code = codeSize(hit.location);
          return {
            code,
            tile: Math.round(Math.min(width, height, code * 1.5)),
            step: Math.max(12, Math.round(code * 0.4)),
          };
        }
      }
    }
  }

  return null;
}

function scanTiles(frame, width, height, tile, step, detections) {
  const tileW = Math.min(tile, width);
  const tileH = Math.min(tile, height);
  for (const y of getTilePositions(height, tileH, step)) {
    for (const x of getTilePositions(width, tileW, step)) {
      detections.push(...readWindow(frame, width, x, y, tileW, tileH));
    }
  }
}

function readWindow(frame, frameWidth, originX, originY, tileW, tileH) {
  const tile = new Uint8ClampedArray(tileW * tileH * 4);
  for (let row = 0; row < tileH; row++) {
    const src = ((originY + row) * frameWidth + originX) * 4;
    tile.set(frame.subarray(src, src + tileW * 4), row * tileW * 4);
  }

  const found = [];
  for (let n = 0; n < MAX_CODES_PER_WINDOW; n++) {
    const qrCode = jsQR(tile, tileW, tileH, { inversionAttempts: 'dontInvert' });
    if (!qrCode) {
      break;
    }
    found.push(offsetQRCode(qrCode, originX, originY));
    blankSymbol(tile, tileW, tileH, qrCode.location);
  }
  return found;
}

function codeSize(location) {
  const { topLeftCorner, topRightCorner } = location;
  const dx = topLeftCorner.x - topRightCorner.x;
  const dy = topLeftCorner.y - topRightCorner.y;
  return Math.hypot(dx, dy);
}

function scaleDetection(detection, scaleX, scaleY) {
  const scale = (point) => ({ x: point.x * scaleX, y: point.y * scaleY });
  const { topLeftCorner, topRightCorner, bottomRightCorner, bottomLeftCorner } = detection.location;
  return {
    data: detection.data,
    location: {
      topLeftCorner: scale(topLeftCorner),
      topRightCorner: scale(topRightCorner),
      bottomRightCorner: scale(bottomRightCorner),
      bottomLeftCorner: scale(bottomLeftCorner),
    },
  };
}

function getTilePositions(dimension, tile, step) {
  if (dimension <= tile) {
    return [0];
  }

  const positions = [];
  for (let pos = 0; pos + tile <= dimension; pos += step) {
    positions.push(pos);
  }

  const lastPosition = dimension - tile;
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

function dedupeDetections(detections, minDistance) {
  const unique = [];

  for (const detection of detections) {
    const center = centerOf(detection.location);
    const isDuplicate = unique.some((existing) => {
      const existingCenter = centerOf(existing.location);
      const dx = center.x - existingCenter.x;
      const dy = center.y - existingCenter.y;
      return Math.sqrt(dx * dx + dy * dy) < minDistance;
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

function blankSymbol(data, width, height, location) {
  const corners = [
    location.topLeftCorner,
    location.topRightCorner,
    location.bottomRightCorner,
    location.bottomLeftCorner,
  ];
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  for (const corner of corners) {
    minX = Math.min(minX, corner.x);
    minY = Math.min(minY, corner.y);
    maxX = Math.max(maxX, corner.x);
    maxY = Math.max(maxY, corner.y);
  }

  const pad = 8;
  const x0 = Math.max(0, Math.floor(minX) - pad);
  const y0 = Math.max(0, Math.floor(minY) - pad);
  const x1 = Math.min(width - 1, Math.ceil(maxX) + pad);
  const y1 = Math.min(height - 1, Math.ceil(maxY) + pad);

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const offset = (y * width + x) * 4;
      data[offset] = 255;
      data[offset + 1] = 255;
      data[offset + 2] = 255;
    }
  }
}

function drawCount(count) {
  const pad = Math.max(12, overlay.width * 0.012);
  const fontSize = Math.max(18, overlay.width * 0.022);
  overlayCtx.font = `bold ${fontSize}px monospace`;
  overlayCtx.textBaseline = 'top';
  const line = `QR codes: ${count}`;
  const w = overlayCtx.measureText(line).width;
  overlayCtx.fillStyle = 'rgba(0, 0, 0, 0.65)';
  overlayCtx.fillRect(pad, pad, w + pad * 2, fontSize + pad * 1.4);
  overlayCtx.fillStyle = '#00ff00';
  overlayCtx.fillText(line, pad * 1.5, pad * 1.1);
}

function drawBox(location) {
  const { topLeftCorner, topRightCorner, bottomRightCorner, bottomLeftCorner } = location;

  overlayCtx.strokeStyle = '#00ff00';
  overlayCtx.lineWidth = Math.max(4, overlay.width * 0.006);
  overlayCtx.beginPath();
  overlayCtx.moveTo(topLeftCorner.x, topLeftCorner.y);
  overlayCtx.lineTo(topRightCorner.x, topRightCorner.y);
  overlayCtx.lineTo(bottomRightCorner.x, bottomRightCorner.y);
  overlayCtx.lineTo(bottomLeftCorner.x, bottomLeftCorner.y);
  overlayCtx.closePath();
  overlayCtx.stroke();
}

function drawLabel(location, text) {
  const { bottomLeftCorner, bottomRightCorner } = location;

  const fontSize = Math.max(16, overlay.width * 0.02);
  const padding = fontSize * 0.25;
  const x = Math.min(bottomLeftCorner.x, bottomRightCorner.x);
  const y = Math.max(bottomLeftCorner.y, bottomRightCorner.y) + padding;

  overlayCtx.font = `${fontSize}px monospace`;
  overlayCtx.textBaseline = 'top';
  const textWidth = overlayCtx.measureText(text).width;

  overlayCtx.fillStyle = 'rgba(0, 0, 0, 0.6)';
  overlayCtx.fillRect(x - padding, y - padding, textWidth + padding * 2, fontSize + padding * 2);

  overlayCtx.fillStyle = '#00ff00';
  overlayCtx.fillText(text, x, y);
}

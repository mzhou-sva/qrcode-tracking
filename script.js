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

// A top-down sheet of printed codes is larger in the frame than the old
// fixed 300px window, so a code can straddle every tile. Scan a few window
// sizes. jsQR returns one symbol per call, so blank each hit and scan that
// window again before moving on.
const WINDOW_SIZES = [320, 480, 640];
const MAX_CODES_PER_WINDOW = 4;

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

  sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = video.videoWidth;
  sampleCanvas.height = video.videoHeight;
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
  const detections = [];

  for (const tile of WINDOW_SIZES) {
    const step = Math.round(tile * 0.45);
    const tileW = Math.min(tile, width);
    const tileH = Math.min(tile, height);
    for (const y of getTilePositions(height, tileH, step)) {
      for (const x of getTilePositions(width, tileW, step)) {
        scanWindow(frame.data, width, x, y, tileW, tileH, detections);
      }
    }
  }

  return dedupeDetections(detections);
}

function scanWindow(frame, frameWidth, originX, originY, tileW, tileH, detections) {
  const tile = new Uint8ClampedArray(tileW * tileH * 4);
  for (let row = 0; row < tileH; row++) {
    const src = ((originY + row) * frameWidth + originX) * 4;
    tile.set(frame.subarray(src, src + tileW * 4), row * tileW * 4);
  }

  for (let n = 0; n < MAX_CODES_PER_WINDOW; n++) {
    const qrCode = jsQR(tile, tileW, tileH, { inversionAttempts: 'dontInvert' });
    if (!qrCode) {
      break;
    }
    detections.push(offsetQRCode(qrCode, originX, originY));
    blankSymbol(tile, tileW, tileH, qrCode.location);
  }
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

function dedupeDetections(detections) {
  const unique = [];

  for (const detection of detections) {
    const center = centerOf(detection.location);
    const isDuplicate = unique.some((existing) => {
      const existingCenter = centerOf(existing.location);
      const dx = center.x - existingCenter.x;
      const dy = center.y - existingCenter.y;
      return Math.sqrt(dx * dx + dy * dy) < 80;
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

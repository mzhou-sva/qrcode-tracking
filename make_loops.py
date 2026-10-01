"""Cut the three recordings in sounds/source/ into seamless 4-second loops.

    sounds/source/water.m4a  ->  sounds/water.wav
    sounds/source/candy.m4a  ->  sounds/candy.wav
    sounds/source/cookie.m4a ->  sounds/cookie.wav

Every loop is 120 BPM x 8 beats = exactly 4.000 s (176400 samples, 44.1 kHz, stereo).

How a loop is made
  1. Window: the 4 s window of the recording whose hits sit closest to the 120 BPM
     grid (16th-note grid, extra weight on beats 1 and 5) is chosen, skipping quiet
     parts and windows with a lot of sound right at the seam.
  2. Seam: the last 0.25 s of the loop is an equal-power crossfade from the
     recording into the 0.25 s that came *before* the loop start, so the wrap from
     the last sample to the first one continues smoothly. The start of the loop
     (the downbeat) is left untouched.
  3. Level: all three loops get the same RMS and are kept under -1 dBFS.

Usage:  python3 make_loops.py        (needs ffmpeg, numpy, librosa, soundfile)
"""
import os
import subprocess
import tempfile

import librosa
import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'sounds', 'source')
OUT = os.path.join(HERE, 'sounds')

SR, BPM, BEATS = 44100, 120, 8
BEAT = 60 / BPM
L = int(round(SR * BEAT * BEATS))         # 176400 samples = 4.000 s
XF = int(0.25 * SR)                       # crossfade length
TARGET_RMS = 0.07
PEAK_MAX = 0.89                           # about -1 dBFS
HOP = 128

NAMES = ('water', 'candy', 'cookie')


def load_stereo(path):
    tmp = tempfile.mktemp(suffix='.wav')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', path, '-ac', '2', '-ar', str(SR), tmp], check=True)
    y, _ = sf.read(tmp, always_2d=True)
    os.remove(tmp)
    return y.T.astype(np.float64)         # (2, n)


def find_window(y):
    """Return (loop_start_sample, stats) for the best-aligned window."""
    mono = y.mean(axis=0)
    env = librosa.onset.onset_strength(y=mono, sr=SR, hop_length=HOP)
    env = env / (env.max() + 1e-9)
    rms = librosa.feature.rms(y=mono, frame_length=2048, hop_length=HOP)[0]
    n_loop = L // HOP
    n_xf = XF // HOP
    near = int(0.025 * SR / HOP)           # +-25 ms counts as "on the grid"

    grid = np.arange(0, L, int(BEAT / 4 * SR))      # 16th notes
    accent = {0, 8 * int(BEAT * SR)}                # beats 1 and 5 weigh more
    csum = np.concatenate([[0], np.cumsum(env)])
    csq = np.concatenate([[0], np.cumsum(rms)])

    best = None
    last_start = len(mono) - (L + XF)
    # a loop starts at source sample p; the crossfade pulls from [p-XF, p)
    for p in range(XF, last_start + 1, HOP * 2):
        f0 = p // HOP
        total = csum[f0 + n_loop] - csum[f0]
        if total <= 1e-6:
            continue
        mean_rms = (csq[f0 + n_loop] - csq[f0]) / n_loop
        on_grid = 0.0
        for g in grid:
            c = f0 + g // HOP
            w = 2.0 if g in accent else 1.0
            on_grid += w * env[max(c - near, 0):c + near + 1].max()
        seam_energy = csum[f0 + n_loop + n_xf] - csum[f0 + n_loop - n_xf]
        score = on_grid / (total ** 0.5) - 0.6 * seam_energy / (total + 1e-9) * 10
        cand = (score, p, mean_rms, total)
        if best is None or cand[0] > best[0]:
            if mean_rms >= 0.5 * np.median(rms):          # not a quiet gap
                best = cand
    return best


def make_loop(y, p):
    seg = y[:, p - XF:p + L]                  # XF before the loop start, then L samples
    # loop[i] = seg[XF + i]; the final XF samples crossfade into the XF before the start
    loop = seg[:, XF:XF + L].copy()
    t = np.linspace(0, np.pi / 2, XF)
    fade_out, fade_in = np.cos(t), np.sin(t)
    loop[:, L - XF:] = seg[:, XF + L - XF:XF + L] * fade_out + seg[:, :XF] * fade_in
    return loop


def finish(loop):
    loop = loop - loop.mean(axis=1, keepdims=True)
    loop *= TARGET_RMS / np.sqrt(np.mean(loop ** 2))
    peak = np.abs(loop).max()
    if peak > PEAK_MAX:                       # gentle limiter, only if needed
        loop = np.tanh(loop / peak * 1.2) / np.tanh(1.2) * PEAK_MAX
    return loop


if __name__ == '__main__':
    for name in NAMES:
        y = load_stereo(os.path.join(SRC, f'{name}.m4a'))
        score, p, mean_rms, _ = find_window(y)
        loop = finish(make_loop(y, p))
        assert loop.shape[1] == L
        sf.write(os.path.join(OUT, f'{name}.wav'), loop.T, SR, subtype='PCM_16')
        print(f'{name:7s} window starts at {p / SR:6.2f} s in the recording  ->  {name}.wav  '
              f'({loop.shape[1] / SR:.3f} s, peak {np.abs(loop).max():.2f}, rms {np.sqrt(np.mean(loop ** 2)):.3f})')

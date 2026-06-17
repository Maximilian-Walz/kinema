/* decode an audio file once and cache max-amplitude peaks for drawing */

const RESOLUTION = 2000;
const cache = new Map<string, Promise<{ peaks: Float32Array; duration: number }>>();

export function getPeaks(url: string): Promise<{ peaks: Float32Array; duration: number }> {
  let p = cache.get(url);
  if (!p) {
    p = decode(url);
    cache.set(url, p);
  }
  return p;
}

async function decode(url: string): Promise<{ peaks: Float32Array; duration: number }> {
  const buf = await (await fetch(url)).arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, 44100);
  const audio = await ctx.decodeAudioData(buf);
  const data = audio.getChannelData(0);
  const peaks = new Float32Array(RESOLUTION);
  const per = Math.max(1, Math.floor(data.length / RESOLUTION));
  for (let i = 0; i < RESOLUTION; i++) {
    let max = 0;
    const start = i * per;
    const end = Math.min(start + per, data.length);
    for (let j = start; j < end; j++) {
      const v = Math.abs(data[j]);
      if (v > max) max = v;
    }
    peaks[i] = max;
  }
  return { peaks, duration: audio.duration };
}

/** draw peaks into a canvas; the canvas width represents clipLen seconds.
    Renders the slice of the take starting at startSec (the sub-take in-point,
    0 for a whole take), so a picked sub-window shows only its own audio rather
    than the entire recording squeezed to fit. */
export function drawWaveform(
  canvas: HTMLCanvasElement,
  peaks: Float32Array,
  audioLen: number,
  clipLen: number,
  color: string,
  startSec = 0,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width: w, height: h } = canvas;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = color;
  if (clipLen <= 0 || audioLen <= 0) return;
  // fraction of width backed by audio (the slice may be shorter than the clip)
  const audible = Math.max(0, Math.min(audioLen - startSec, clipLen));
  const cols = Math.floor(w * (audible / clipLen));
  for (let x = 0; x < cols; x++) {
    const sec = startSec + (x / w) * clipLen; // take-time at this column
    const i = Math.min(peaks.length - 1, Math.floor((sec / audioLen) * peaks.length));
    const v = Math.max(0.04, peaks[i]);
    const bh = Math.max(1, v * (h - 2));
    ctx.fillRect(x, (h - bh) / 2, 1, bh);
  }
}

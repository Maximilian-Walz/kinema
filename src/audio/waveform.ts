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

/** draw peaks into a canvas; audioLen seconds mapped onto clipLen seconds of width */
export function drawWaveform(
  canvas: HTMLCanvasElement,
  peaks: Float32Array,
  audioLen: number,
  clipLen: number,
  color: string,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width: w, height: h } = canvas;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = color;
  const visible = Math.min(1, audioLen / clipLen); // fraction of width with audio
  const cols = Math.floor(w * visible);
  for (let x = 0; x < cols; x++) {
    const i = Math.floor((x / cols) * peaks.length);
    const v = Math.max(0.04, peaks[i]);
    const bh = Math.max(1, v * (h - 2));
    ctx.fillRect(x, (h - bh) / 2, 1, bh);
  }
}

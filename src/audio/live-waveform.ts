/* Live scrolling waveform driven by an AnalyserNode.
   Draws a ring buffer of recent peak values as a right-to-left scrolling
   waveform, sampled at ~60 Hz via requestAnimationFrame.
   Source-agnostic: the caller creates the AnalyserNode and hands it over.
   Does NOT modify meter.ts or waveform.ts. */

const WAVEFORM_COLOR = '#7ee787';
const BACKGROUND_COLOR = '#161b22';

export interface LiveWaveformOptions {
  /** Canvas width in logical px. Default: 200 */
  width?: number;
  /** Canvas height in logical px. Default: 40 */
  height?: number;
  /** Device-pixel ratio override. Default: window.devicePixelRatio (>=1) */
  dpr?: number;
  /** Number of peak columns stored in the ring buffer. Default: width (1 per px). */
  columns?: number;
}

/** A self-contained live scrolling waveform widget.
 *
 * Usage:
 *   const wf = new LiveWaveform(analyserNode, { width: 200, height: 40 });
 *   container.appendChild(wf.canvas);
 *   wf.start();
 *   // later:
 *   wf.stop();
 */
export class LiveWaveform {
  readonly canvas: HTMLCanvasElement;

  private readonly analyser: AnalyserNode;
  private readonly buf: Float32Array;
  private readonly dpr: number;
  private readonly w: number;
  private readonly h: number;
  private readonly cols: number;

  /* ring buffer of peak values [0..1], one entry per column */
  private readonly ring: Float32Array;
  private ringHead = 0; // index of the next write position

  private rafId = 0;
  private lastSampleTime = 0;
  /* how often to capture a new peak sample (ms) -- ~60 Hz */
  private readonly sampleInterval = 1000 / 60;

  constructor(analyser: AnalyserNode, opts: LiveWaveformOptions = {}) {
    this.analyser = analyser;
    this.dpr = Math.max(1, opts.dpr ?? window.devicePixelRatio ?? 1);
    this.w = opts.width ?? 200;
    this.h = opts.height ?? 40;
    this.cols = opts.columns ?? this.w;

    this.buf = new Float32Array(analyser.fftSize);
    this.ring = new Float32Array(this.cols); // all zeros = silence

    this.canvas = document.createElement('canvas');
    this.canvas.width  = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.canvas.style.width  = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    this.canvas.style.display = 'block';
    this.canvas.style.borderRadius = '2px';
    this.canvas.style.background = BACKGROUND_COLOR;

    this.drawSilent();
  }

  /** Begin the rAF sample + draw loop. Safe to call multiple times. */
  start(): void {
    if (this.rafId !== 0) return;
    this.lastSampleTime = 0;
    this.rafId = requestAnimationFrame(this.frame);
  }

  /** Halt the loop and clear the display. Safe to call multiple times. */
  stop(): void {
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.ring.fill(0);
    this.ringHead = 0;
    this.lastSampleTime = 0;
    this.drawSilent();
  }

  private readonly frame = (now: number): void => {
    /* guard: if the canvas was removed, stop cleanly */
    if (!this.canvas.isConnected) {
      this.rafId = 0;
      return;
    }

    /* throttle sample capture to ~60 Hz, but draw every frame for smoothness */
    if (now - this.lastSampleTime >= this.sampleInterval) {
      this.lastSampleTime = now;
      this.analyser.getFloatTimeDomainData(this.buf);

      /* peak of the current block */
      let peak = 0;
      for (let i = 0; i < this.buf.length; i++) {
        const a = this.buf[i] < 0 ? -this.buf[i] : this.buf[i];
        if (a > peak) peak = a;
      }

      this.ring[this.ringHead] = Math.min(1, peak);
      this.ringHead = (this.ringHead + 1) % this.cols;
    }

    this.draw();
    this.rafId = requestAnimationFrame(this.frame);
  };

  private drawSilent(): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private draw(): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;

    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const mid = ch / 2;

    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = WAVEFORM_COLOR;

    /* the ring buffer maps [oldest...newest] left-to-right.
       ringHead points to the oldest entry (next write position).
       Draw one column per logical pixel, upscaled by dpr. */
    const pxW = Math.round(this.dpr); // width of one column in physical px
    for (let col = 0; col < this.cols; col++) {
      /* oldest entry is at ringHead; newest is at ringHead-1 */
      const idx = (this.ringHead + col) % this.cols;
      const v = this.ring[idx];
      const bh = Math.max(this.dpr, v * (ch - 2 * this.dpr));
      const x = Math.round((col / this.cols) * cw);
      ctx.fillRect(x, mid - bh / 2, pxW, bh);
    }
  }
}

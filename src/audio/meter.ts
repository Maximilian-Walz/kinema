/* dBFS peak + RMS level meter driven by a Web Audio AnalyserNode.
   Source-agnostic: the caller creates the AnalyserNode and wires up the graph.
   All visual styling is self-contained here (no styles.css edits needed). */

/* ── constants ──────────────────────────────────────────────────────────── */

/** Lowest displayable level in dBFS; anything below is treated as silence. */
const FLOOR_DB = -60;

/** Clip threshold: peak >= this linear value triggers the clip indicator. */
const CLIP_THRESHOLD = 0.997; // ≈ -0.03 dBFS

/** How many seconds the peak-hold marker stays before beginning to fall. */
const PEAK_HOLD_S = 1.0;

/** Decay rate for the peak-hold marker once it starts falling (dB/s). */
const PEAK_DECAY_DB_PER_S = 20;

/** How many seconds the clip indicator stays latched after a clip event. */
const CLIP_HOLD_S = 1.0;

/** dBFS threshold above which the bar turns yellow. */
const YELLOW_DB = -12;

/** dBFS threshold above which the bar turns red. */
const RED_DB = -3;

/* ── colour helpers ─────────────────────────────────────────────────────── */

/** Map a dBFS value in [FLOOR_DB, 0] to the bar segment colour. */
function levelColor(db: number): string {
  if (db >= RED_DB) return '#f85149';    // red  (≥ -3 dBFS)
  if (db >= YELLOW_DB) return '#e3b341'; // yellow (≥ -12 dBFS)
  return '#7ee787';                       // green  (studio voice-track colour)
}

/* ── dBFS conversion ────────────────────────────────────────────────────── */

function toDb(linear: number): number {
  if (linear <= 0) return FLOOR_DB;
  return Math.max(FLOOR_DB, 20 * Math.log10(linear));
}

/** Map a dBFS value to a [0, 1] fraction for drawing. */
function dbToFraction(db: number): number {
  return Math.max(0, Math.min(1, (db - FLOOR_DB) / -FLOOR_DB));
}

/* ── public types ───────────────────────────────────────────────────────── */

export type MeterOrientation = 'vertical' | 'horizontal';

export interface MeterOptions {
  /** Default: 'vertical' */
  orientation?: MeterOrientation;
  /** Canvas width in logical px.  Default: vertical→20, horizontal→200 */
  width?: number;
  /** Canvas height in logical px. Default: vertical→120, horizontal→20 */
  height?: number;
  /** Device-pixel ratio override. Default: window.devicePixelRatio (≥1) */
  dpr?: number;
}

/* ── injected stylesheet (once per document) ────────────────────────────── */

const STYLE_ID = 'kinema-meter-style';

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.vs-meter {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  user-select: none;
}
.vs-meter canvas {
  display: block;
  border-radius: 2px;
  background: #161b22;
}
.vs-meter-clip {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #30363d;
  border: 1px solid #484f58;
  transition: background 80ms;
  flex-shrink: 0;
}
.vs-meter-clip.clipped {
  background: #f85149;
  border-color: #ff7b72;
  box-shadow: 0 0 4px #f8514988;
}
.vs-meter.horizontal {
  flex-direction: row;
}
`;
  document.head.appendChild(style);
}

/* ── Meter class ────────────────────────────────────────────────────────── */

/**
 * A self-contained peak + RMS dBFS level meter.
 *
 * Usage:
 *   const meter = new Meter(analyserNode, { orientation: 'vertical' });
 *   document.getElementById('sidebar').appendChild(meter.element);
 *   meter.start();
 *   // later:
 *   meter.stop();
 */
export class Meter {
  /** The root DOM element; append this wherever you need the widget. */
  readonly element: HTMLElement;

  private readonly canvas: HTMLCanvasElement;
  private readonly clipLed: HTMLElement;
  private readonly analyser: AnalyserNode;
  private readonly buf: Float32Array;
  private readonly orientation: MeterOrientation;
  private readonly dpr: number;
  private readonly w: number; // logical px
  private readonly h: number; // logical px

  /* ballistics state */
  private peakDb = FLOOR_DB;
  private peakHoldUntil = 0;    // performance.now() timestamp
  private clipUntil = 0;        // performance.now() timestamp
  private rmsDb = FLOOR_DB;
  private lastFrameTime = 0;    // performance.now() timestamp

  /* rAF handle — non-zero when running */
  private rafId = 0;

  constructor(analyser: AnalyserNode, opts: MeterOptions = {}) {
    this.analyser = analyser;
    this.orientation = opts.orientation ?? 'vertical';
    this.dpr = Math.max(1, opts.dpr ?? window.devicePixelRatio ?? 1);

    const isV = this.orientation === 'vertical';
    this.w = opts.width  ?? (isV ? 20  : 200);
    this.h = opts.height ?? (isV ? 120 : 20);

    this.buf = new Float32Array(analyser.fftSize);

    ensureStyle();

    /* ── DOM ── */
    this.canvas = document.createElement('canvas');
    this.canvas.width  = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.canvas.style.width  = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;

    this.clipLed = document.createElement('div');
    this.clipLed.className = 'vs-meter-clip';
    this.clipLed.title = 'Clip indicator';

    this.element = document.createElement('div');
    this.element.className = `vs-meter${isV ? '' : ' horizontal'}`;

    if (isV) {
      // vertical: LED on top, canvas below
      this.element.appendChild(this.clipLed);
      this.element.appendChild(this.canvas);
    } else {
      // horizontal: canvas left, LED right
      this.element.appendChild(this.canvas);
      this.element.appendChild(this.clipLed);
    }

    /* draw an initial silent frame so the canvas isn't blank */
    this.draw(FLOOR_DB, FLOOR_DB, FLOOR_DB, false);
  }

  /* ── lifecycle ──────────────────────────────────────────────────────── */

  /** Begin the rAF measurement + draw loop. Safe to call multiple times. */
  start(): void {
    if (this.rafId !== 0) return;
    this.lastFrameTime = performance.now();
    this.rafId = requestAnimationFrame(this.frame);
  }

  /** Halt the loop and clear the meter display. Safe to call multiple times. */
  stop(): void {
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    /* reset ballistics */
    this.peakDb = FLOOR_DB;
    this.peakHoldUntil = 0;
    this.clipUntil = 0;
    this.rmsDb = FLOOR_DB;
    this.lastFrameTime = 0;
    this.draw(FLOOR_DB, FLOOR_DB, FLOOR_DB, false);
  }

  /* ── internal rAF callback ──────────────────────────────────────────── */

  private readonly frame = (now: number): void => {
    /* Guard: if the canvas has been removed from the document, bail cleanly. */
    if (!this.canvas.isConnected) {
      this.rafId = 0;
      return;
    }

    const dt = this.lastFrameTime > 0 ? (now - this.lastFrameTime) / 1000 : 0;
    this.lastFrameTime = now;

    /* ── 1. Read from AnalyserNode ── */
    this.analyser.getFloatTimeDomainData(this.buf);

    /* ── 2. Compute peak and RMS over this block ── */
    let peak = 0;
    let sumSq = 0;
    const n = this.buf.length;
    for (let i = 0; i < n; i++) {
      const s = this.buf[i];
      const a = s < 0 ? -s : s; // Math.abs without allocation
      if (a > peak) peak = a;
      sumSq += s * s;
    }
    const rmsLinear = Math.sqrt(sumSq / n);

    const instantPeakDb = toDb(peak);
    const instantRmsDb  = toDb(rmsLinear);

    /* ── 3. Ballistics ── */

    // RMS: direct (no extra smoothing — raw frame-level RMS is already averaged)
    this.rmsDb = instantRmsDb;

    // Peak hold: advance or decay
    if (instantPeakDb >= this.peakDb) {
      // new or equal peak — reset the hold window
      this.peakDb = instantPeakDb;
      this.peakHoldUntil = now + PEAK_HOLD_S * 1000;
    } else if (now < this.peakHoldUntil) {
      // still in hold window — keep current peak
    } else {
      // past hold window — decay at PEAK_DECAY_DB_PER_S
      this.peakDb = Math.max(FLOOR_DB, this.peakDb - PEAK_DECAY_DB_PER_S * dt);
    }

    // Clip latch
    const clipped = peak >= CLIP_THRESHOLD;
    if (clipped) {
      this.clipUntil = now + CLIP_HOLD_S * 1000;
    }
    const showClip = now < this.clipUntil;

    /* ── 4. Draw ── */
    this.draw(this.rmsDb, instantPeakDb, this.peakDb, showClip);

    this.rafId = requestAnimationFrame(this.frame);
  };

  /* ── drawing ────────────────────────────────────────────────────────── */

  /**
   * @param rmsDb       current RMS dBFS (drives the fill bar)
   * @param instantDb   current instantaneous peak dBFS (unused visually, kept for symmetry)
   * @param peakHoldDb  peak-hold dBFS (drives the tick)
   * @param showClip    whether the clip LED should be lit
   */
  private draw(rmsDb: number, _instantDb: number, peakHoldDb: number, showClip: boolean): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;

    const cw = this.canvas.width;
    const ch = this.canvas.height;

    ctx.clearRect(0, 0, cw, ch);

    if (this.orientation === 'vertical') {
      this.drawVertical(ctx, cw, ch, rmsDb, peakHoldDb);
    } else {
      this.drawHorizontal(ctx, cw, ch, rmsDb, peakHoldDb);
    }

    /* clip LED */
    if (showClip) {
      this.clipLed.classList.add('clipped');
    } else {
      this.clipLed.classList.remove('clipped');
    }
  }

  private drawVertical(
    ctx: CanvasRenderingContext2D,
    cw: number, ch: number,
    rmsDb: number,
    peakHoldDb: number,
  ): void {
    const rmsFrac  = dbToFraction(rmsDb);
    const peakFrac = dbToFraction(peakHoldDb);

    /* RMS fill bar — drawn from bottom, segmented with 1-px gaps */
    const barH = Math.round(rmsFrac * ch);
    const segW = cw;

    // split at colour boundaries
    const redY    = Math.round((1 - dbToFraction(RED_DB))    * ch);
    const yellowY = Math.round((1 - dbToFraction(YELLOW_DB)) * ch);

    // green segment (bottom → yellow threshold)
    if (barH > 0) {
      const greenBottom = ch;
      const greenTop    = Math.max(ch - barH, yellowY);
      if (greenBottom > greenTop) {
        ctx.fillStyle = '#7ee787';
        ctx.fillRect(0, greenTop, segW, greenBottom - greenTop);
      }

      // yellow segment
      if (ch - barH < yellowY) {
        const yTop = Math.max(ch - barH, redY);
        if (yellowY > yTop) {
          ctx.fillStyle = '#e3b341';
          ctx.fillRect(0, yTop, segW, yellowY - yTop);
        }
      }

      // red segment (above red threshold)
      if (ch - barH < redY) {
        const rTop = ch - barH;
        if (redY > rTop) {
          ctx.fillStyle = '#f85149';
          ctx.fillRect(0, rTop, segW, redY - rTop);
        }
      }
    }

    /* peak-hold tick — 2-px horizontal line */
    if (peakHoldDb > FLOOR_DB) {
      const tickY = Math.round((1 - peakFrac) * ch);
      const clampedTickY = Math.max(0, Math.min(ch - 2, tickY));
      ctx.fillStyle = levelColor(peakHoldDb);
      ctx.fillRect(0, clampedTickY, cw, 2);
    }
  }

  private drawHorizontal(
    ctx: CanvasRenderingContext2D,
    cw: number, ch: number,
    rmsDb: number,
    peakHoldDb: number,
  ): void {
    const rmsFrac  = dbToFraction(rmsDb);
    const peakFrac = dbToFraction(peakHoldDb);

    const barW = Math.round(rmsFrac * cw);

    // colour-boundary x positions (left = quiet, right = loud)
    const yellowX = Math.round(dbToFraction(YELLOW_DB) * cw);
    const redX    = Math.round(dbToFraction(RED_DB)    * cw);

    if (barW > 0) {
      // green segment
      const greenEnd = Math.min(barW, yellowX);
      if (greenEnd > 0) {
        ctx.fillStyle = '#7ee787';
        ctx.fillRect(0, 0, greenEnd, ch);
      }

      // yellow segment
      if (barW > yellowX) {
        const yEnd = Math.min(barW, redX);
        if (yEnd > yellowX) {
          ctx.fillStyle = '#e3b341';
          ctx.fillRect(yellowX, 0, yEnd - yellowX, ch);
        }
      }

      // red segment
      if (barW > redX) {
        ctx.fillStyle = '#f85149';
        ctx.fillRect(redX, 0, barW - redX, ch);
      }
    }

    /* peak-hold tick — 2-px vertical line */
    if (peakHoldDb > FLOOR_DB) {
      const tickX = Math.round(peakFrac * cw);
      const clampedTickX = Math.max(0, Math.min(cw - 2, tickX));
      ctx.fillStyle = levelColor(peakHoldDb);
      ctx.fillRect(clampedTickX, 0, 2, ch);
    }
  }
}

import * as api from "../api";
import type { Takes } from "./takes";
import { getPeaks } from "./waveform";

/* ============================================================================
   Scrubbable waveform widget for one take. Used by:
   - RECORD mode: thin inline strip under "last takes" rows (T6 -> T3 hook)
   - TUNE mode: full-width row in the take comparator (T4)

   The widget owns its own canvas, draws a peaks-based waveform via the shared
   getPeaks() cache, and renders a playhead that follows the audition position.
   Clicking the canvas seeks audition to that point (via Takes.scrubAudition).

   Lifecycle:
     const strip = new TakeStrip(takes, sceneId, lineId, file, { ... });
     host.appendChild(strip.element);
     // later
     strip.destroy();
============================================================================ */

export interface TakeStripOptions {
    /** Canvas width in logical px. Default: 320 */
    width?: number;
    /** Canvas height in logical px. Default: 40 */
    height?: number;
    /** Bar colour. Default: green voice colour */
    color?: string;
    /** Playhead colour. Default: white */
    cursorColor?: string;
    /** dpr override. Default: window.devicePixelRatio */
    dpr?: number;
    /** Overrun sub-take picker: the fixed length (seconds) of the window that
        plays/exports for this line (= the line's own duration). When set and
        shorter than the take duration, a draggable translucent rectangle is
        drawn over the waveform; drag it to choose which winLen-long slice the
        line uses. Omitted (or >= duration) = no overlay, current behaviour. */
    windowLen?: number;
    /** Initial window start (seconds into the take). Default 0. Clamped to
        [0, duration - windowLen]. */
    inPoint?: number;
    /** Called (debounced) with the new in-point as the window is dragged. */
    onInPointChange?: (inPoint: number) => void;
}

const DEFAULT_COLOR = "#7ee787";
const CURSOR_COLOR = "#ffffff";

export class TakeStrip {
    readonly element: HTMLElement;
    private readonly canvas: HTMLCanvasElement;
    private readonly playhead: HTMLElement;
    private readonly takes: Takes;
    private readonly sceneId: string;
    private readonly lineId: string;
    private readonly file: string;
    private readonly h: number;
    private readonly dpr: number;
    private readonly color: string;
    private duration = 0;
    private peaks: Float32Array | null = null;
    private rafId = 0;
    private destroyed = false;
    private readonly onTakesChange: () => void;
    private readonly resizeObs: ResizeObserver;
    /* overrun sub-take picker (optional) */
    private readonly windowLen: number;
    private inPoint: number;
    private readonly onInPointChange?: (inPoint: number) => void;
    private readonly windowEl: HTMLElement;
    private inPointTimer: number | undefined;

    constructor(
        takes: Takes,
        sceneId: string,
        lineId: string,
        file: string,
        opts: TakeStripOptions = {},
    ) {
        this.takes = takes;
        this.sceneId = sceneId;
        this.lineId = lineId;
        this.file = file;

        this.dpr = Math.max(1, opts.dpr ?? window.devicePixelRatio ?? 1);
        this.h = opts.height ?? 40;
        this.color = opts.color ?? DEFAULT_COLOR;
        this.windowLen = opts.windowLen ?? 0;
        this.inPoint = Math.max(0, opts.inPoint ?? 0);
        this.onInPointChange = opts.onInPointChange;

        /* Canvas backing-store width is sized from the rendered CSS width
           (set up below by ResizeObserver) so the waveform stays crisp on
           HiDPI displays and after the container is resized. Setting the
           backing-store size to a fixed `width` option would only stay sharp
           when the canvas happens to render at exactly that CSS width. */
        this.canvas = document.createElement("canvas");
        this.canvas.style.width = "100%";
        this.canvas.style.height = this.h + "px";
        this.canvas.style.display = "block";
        this.canvas.style.cursor = "pointer";

        this.playhead = document.createElement("div");
        this.playhead.className = "vs-take-cursor";
        this.playhead.style.cssText =
            `position:absolute;top:0;bottom:0;width:1.5px;background:${
                opts.cursorColor ?? CURSOR_COLOR
            };` +
            `pointer-events:none;left:0;display:none;box-shadow:0 0 4px rgba(255,255,255,.6);`;

        /* Overrun window overlay: a translucent draggable rectangle marking the
           winLen-long slice the line uses. Hidden until load() decides the take
           is longer than windowLen. pointer-events:auto so it captures drags;
           the canvas underneath still handles scrub clicks outside the box. */
        this.windowEl = document.createElement("div");
        this.windowEl.className = "vs-take-window";
        this.windowEl.style.cssText =
            "position:absolute;top:0;bottom:0;left:0;width:0;display:none;" +
            "background:rgba(126,231,135,.18);border:1px solid rgba(126,231,135,.85);" +
            "box-sizing:border-box;cursor:grab;touch-action:none;";

        this.element = document.createElement("div");
        this.element.className = "vs-take-strip";
        this.element.style.cssText =
            "position:relative;display:block;width:100%;border-radius:4px;overflow:hidden;background:rgba(63,185,80,.06);";
        this.element.append(this.canvas, this.windowEl, this.playhead);

        /* drag the window box to choose the in-point. Computes the new start
           from the box's left edge under the pointer, clamps to
           [0, duration - windowLen], repositions, scrubs an audition at the
           window start, and debounces the persisting callback (like timeline). */
        if (this.windowLen > 0 && this.onInPointChange) {
            let grabDx = 0; // pointer offset within the box at grab time
            const dragTo = (ev: PointerEvent): void => {
                const usable = this.duration - this.windowLen;
                if (usable <= 0) return;
                const r = this.element.getBoundingClientRect();
                const leftPx = ev.clientX - r.left - grabDx;
                const frac = Math.max(0, Math.min(1, leftPx / r.width));
                const inp = Math.max(0, Math.min(usable, frac * this.duration));
                this.inPoint = inp;
                this.positionWindow();
                this.takes.scrubAudition(
                    this.sceneId,
                    this.lineId,
                    this.file,
                    inp,
                );
                clearTimeout(this.inPointTimer);
                this.inPointTimer = window.setTimeout(() => {
                    this.onInPointChange?.(this.inPoint);
                }, 400);
            };
            this.windowEl.addEventListener("pointerdown", (ev) => {
                if (this.windowEl.style.display === "none") return;
                ev.stopPropagation(); // don't let the canvas scrub-click fire
                const box = this.windowEl.getBoundingClientRect();
                grabDx = ev.clientX - box.left;
                this.windowEl.setPointerCapture(ev.pointerId);
                this.windowEl.style.cursor = "grabbing";
                const onMove = (mv: PointerEvent) => dragTo(mv);
                const onUp = () => {
                    this.windowEl.style.cursor = "grab";
                    this.windowEl.removeEventListener("pointermove", onMove);
                    this.windowEl.removeEventListener("pointerup", onUp);
                };
                this.windowEl.addEventListener("pointermove", onMove);
                this.windowEl.addEventListener("pointerup", onUp);
            });
        }

        /* click/drag to scrub */
        const seekFromEvent = (ev: PointerEvent): void => {
            if (!this.duration) return;
            const r = this.canvas.getBoundingClientRect();
            const x = Math.max(0, Math.min(r.width, ev.clientX - r.left));
            const t = (x / r.width) * this.duration;
            this.takes.scrubAudition(this.sceneId, this.lineId, this.file, t);
            this.paintCursor(t);
        };
        this.canvas.addEventListener("pointerdown", (ev) => {
            seekFromEvent(ev);
            this.canvas.setPointerCapture(ev.pointerId);
            const onMove = (mv: PointerEvent) => seekFromEvent(mv);
            const onUp = () => {
                this.canvas.removeEventListener("pointermove", onMove);
                this.canvas.removeEventListener("pointerup", onUp);
            };
            this.canvas.addEventListener("pointermove", onMove);
            this.canvas.addEventListener("pointerup", onUp);
        });

        /* re-render when audition state changes (start, stop, scrub to another) */
        this.onTakesChange = () => this.tickOnce();
        this.takes.events.on("change", this.onTakesChange);

        /* Track the canvas's rendered width and resize the backing store to
           match (× dpr). Without this, the canvas backing pixels get stretched
           by CSS `width:100%` and the waveform looks blurry. */
        this.resizeObs = new ResizeObserver(() => this.resizeAndDraw());
        this.resizeObs.observe(this.canvas);

        void this.load();
        this.startRaf();
    }

    destroy(): void {
        this.destroyed = true;
        cancelAnimationFrame(this.rafId);
        clearTimeout(this.inPointTimer);
        this.resizeObs.disconnect();
    }

    private async load(): Promise<void> {
        const url = new URL(
            api.takeUrl(this.sceneId, this.lineId, this.file),
            location.href,
        ).href;
        try {
            const { peaks, duration } = await getPeaks(url);
            if (this.destroyed) return;
            this.peaks = peaks;
            this.duration = duration;
            /* now that the duration is known, defensively clamp the in-point in
               case the line was retimed (windowLen) shorter than the stored
               value would allow, then show/position the overlay */
            if (this.windowLen > 0) {
                const usable = this.duration - this.windowLen;
                this.inPoint = Math.max(0, Math.min(Math.max(0, usable), this.inPoint));
            }
            this.positionWindow();
            this.resizeAndDraw();
            this.tickOnce();
        } catch {
            /* decode failed -- leave waveform blank, scrubbing becomes a no-op */
        }
    }

    /** Re-size the canvas backing store to match the current CSS width (× dpr)
        and redraw the waveform. Called on mount, on load, and whenever the
        ResizeObserver fires. */
    private resizeAndDraw(): void {
        if (this.destroyed) return;
        const cssW = Math.max(1, Math.floor(this.canvas.clientWidth));
        const cssH = this.h;
        const bw = Math.round(cssW * this.dpr);
        const bh = Math.round(cssH * this.dpr);
        if (this.canvas.width !== bw) this.canvas.width = bw;
        if (this.canvas.height !== bh) this.canvas.height = bh;
        this.draw();
    }

    private draw(): void {
        const ctx = this.canvas.getContext("2d");
        if (!ctx) return;
        const bw = this.canvas.width;
        const bh = this.canvas.height;
        ctx.clearRect(0, 0, bw, bh);
        if (!this.peaks) return;
        ctx.fillStyle = this.color;
        /* Draw one bar per backing-store pixel column for maximum sharpness on
           HiDPI; bar width is 1 backing px (sub-CSS pixel). */
        for (let x = 0; x < bw; x++) {
            const i = Math.floor((x / bw) * this.peaks.length);
            const v = Math.max(0.04, this.peaks[i]);
            const barH = Math.max(this.dpr, v * (bh - 2 * this.dpr));
            ctx.fillRect(x, (bh - barH) / 2, 1, barH);
        }
    }

    /** position the playhead bar based on `t` seconds into the buffer */
    private paintCursor(t: number): void {
        if (!this.duration) {
            this.playhead.style.display = "none";
            return;
        }
        const frac = Math.max(0, Math.min(1, t / this.duration));
        this.playhead.style.display = "block";
        this.playhead.style.left = `${(frac * 100).toFixed(2)}%`;
    }

    /** Show and position the overrun window box (percent-based, so resize-safe).
        Hidden when no windowLen is set or the take is not longer than the
        window (nothing to pick). */
    private positionWindow(): void {
        if (this.windowLen <= 0 || !this.duration ||
            this.duration <= this.windowLen) {
            this.windowEl.style.display = "none";
            return;
        }
        const leftFrac = Math.max(0, Math.min(1, this.inPoint / this.duration));
        const widthFrac = Math.max(0, Math.min(1, this.windowLen / this.duration));
        this.windowEl.style.display = "block";
        this.windowEl.style.left = `${(leftFrac * 100).toFixed(3)}%`;
        this.windowEl.style.width = `${(widthFrac * 100).toFixed(3)}%`;
    }

    /** read the current audition position and paint the cursor accordingly.
      Hides the cursor when the take is not currently auditioning. */
    private tickOnce(): void {
        if (this.destroyed) return;
        if (this.takes.auditioning !== this.file) {
            this.playhead.style.display = "none";
            return;
        }
        const t = this.takes.auditionPosition();
        if (t < 0) {
            this.playhead.style.display = "none";
            return;
        }
        this.paintCursor(t);
    }

    private startRaf(): void {
        const loop = (): void => {
            if (this.destroyed) return;
            this.tickOnce();
            this.rafId = requestAnimationFrame(loop);
        };
        this.rafId = requestAnimationFrame(loop);
    }
}

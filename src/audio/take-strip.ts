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
    private readonly w: number;
    private readonly h: number;
    private duration = 0;
    private peaks: Float32Array | null = null;
    private rafId = 0;
    private destroyed = false;
    private readonly onTakesChange: () => void;

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

        const dpr = Math.max(1, opts.dpr ?? window.devicePixelRatio ?? 1);
        this.w = opts.width ?? 320;
        this.h = opts.height ?? 40;

        this.canvas = document.createElement("canvas");
        this.canvas.width = this.w * dpr;
        this.canvas.height = this.h * dpr;
        this.canvas.style.width = "100%";
        this.canvas.style.height = this.h + "px";
        this.canvas.style.display = "block";
        this.canvas.style.cursor = "pointer";
        const ctx2d = this.canvas.getContext("2d");
        if (ctx2d) ctx2d.scale(dpr, dpr);

        this.playhead = document.createElement("div");
        this.playhead.className = "vs-take-cursor";
        this.playhead.style.cssText =
            `position:absolute;top:0;bottom:0;width:1.5px;background:${
                opts.cursorColor ?? CURSOR_COLOR
            };` +
            `pointer-events:none;left:0;display:none;box-shadow:0 0 4px rgba(255,255,255,.6);`;

        this.element = document.createElement("div");
        this.element.className = "vs-take-strip";
        this.element.style.cssText =
            "position:relative;display:block;width:100%;border-radius:4px;overflow:hidden;background:rgba(63,185,80,.06);";
        this.element.append(this.canvas, this.playhead);

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

        void this.load(opts.color ?? DEFAULT_COLOR);
        this.startRaf();
    }

    destroy(): void {
        this.destroyed = true;
        cancelAnimationFrame(this.rafId);
    }

    private async load(color: string): Promise<void> {
        const url = new URL(
            api.takeUrl(this.sceneId, this.lineId, this.file),
            location.href,
        ).href;
        try {
            const { peaks, duration } = await getPeaks(url);
            if (this.destroyed) return;
            this.peaks = peaks;
            this.duration = duration;
            this.draw(color);
            this.tickOnce();
        } catch {
            /* decode failed -- leave waveform blank, scrubbing becomes a no-op */
        }
    }

    private draw(color: string): void {
        const ctx = this.canvas.getContext("2d");
        if (!ctx || !this.peaks) return;
        const w = this.w;
        const h = this.h;
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = color;
        for (let x = 0; x < w; x++) {
            const i = Math.floor((x / w) * this.peaks.length);
            const v = Math.max(0.04, this.peaks[i]);
            const bh = Math.max(1, v * (h - 2));
            ctx.fillRect(x, (h - bh) / 2, 1, bh);
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

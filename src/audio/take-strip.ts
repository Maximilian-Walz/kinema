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
    /** Called with the new in-point after the window BODY is dragged (slip:
        which slice plays, length unchanged). */
    onInPointChange?: (inPoint: number) => void;
    /** Called with the new (inPoint, windowLen) after a window EDGE is dragged
        (re-length). When provided, left/right edge grips are enabled on the
        window box; omit to keep the box body-drag-only (slip). */
    onResize?: (inPoint: number, windowLen: number) => void;
    /** Initial sticky playhead (seconds into the take) drawn when not playing.
        The owner (TUNE transport) sets this; clicking the canvas reports a new
        one via onScrub. */
    playheadAt?: number;
    /** Called when the canvas is clicked/scrubbed (seconds into the take). When
        provided, the strip does NOT start audition itself — the owner decides
        what/how to play. Omitted = legacy behaviour (Takes.scrubAudition). */
    onScrub?: (sec: number) => void;
    /** Called on a canvas double-click (reset the sticky playhead). */
    onResetPlayhead?: () => void;
}

const DEFAULT_COLOR = "#7ee787";
const CURSOR_COLOR = "#ffffff";

const clamp = (v: number, lo: number, hi: number): number =>
    Math.max(lo, Math.min(hi, v));

/** px from a window-box edge that counts as grabbing that edge (resize) */
const EDGE_PX = 8;

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
    private windowLen: number;
    private inPoint: number;
    private readonly onInPointChange?: (inPoint: number) => void;
    private readonly onResize?: (inPoint: number, windowLen: number) => void;
    private readonly onScrub?: (sec: number) => void;
    private readonly onResetPlayhead?: () => void;
    private readonly windowEl: HTMLElement;
    /** minimum window length when re-lengthing (seconds) */
    private static readonly MIN_LEN = 0.2;
    /** sticky playhead position (seconds into take) drawn while not auditioning;
        null = hidden */
    private playheadAt: number | null;

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
        this.onResize = opts.onResize;
        this.onScrub = opts.onScrub;
        this.onResetPlayhead = opts.onResetPlayhead;
        this.playheadAt = opts.playheadAt ?? null;

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

        /* Window box interactions (candidate take only; the box appears once the
           take is longer than the slot, or always when re-length is enabled):
             - drag the BODY  -> slip: move inPoint, length unchanged (no ripple)
             - drag an EDGE   -> re-length: change windowLen (+inPoint on the left
               edge), which the owner ripples into later lines; the line's start
               stays pinned.
           Window-level pointer listeners (like StageView.beginFontResize) so the
           drag keeps tracking even as the box moves under the cursor. Audition +
           persist happen once on release, not on every move. */
        if (this.windowLen > 0 && (this.onInPointChange || this.onResize)) {
            /* hover cursor: hint the resize edges vs the slip body */
            if (this.onResize) {
                this.windowEl.addEventListener("pointermove", (ev) => {
                    if (ev.buttons) return; // a drag is in progress; leave cursor as set
                    const box = this.windowEl.getBoundingClientRect();
                    const near = ev.clientX - box.left <= EDGE_PX ||
                        box.right - ev.clientX <= EDGE_PX;
                    this.windowEl.style.cursor = near ? "ew-resize" : "grab";
                });
            }
            this.windowEl.addEventListener("pointerdown", (ev) => {
                if (this.windowEl.style.display === "none" || !this.duration) return;
                ev.preventDefault();
                ev.stopPropagation(); // don't let the canvas scrub-click fire
                const r = this.element.getBoundingClientRect();
                const box = this.windowEl.getBoundingClientRect();
                const secPerPx = r.width > 0 ? this.duration / r.width : 0;
                const nearLeft = ev.clientX - box.left <= EDGE_PX;
                const nearRight = box.right - ev.clientX <= EDGE_PX;
                const dragMode: "left" | "right" | "body" =
                    this.onResize && nearRight ? "right"
                    : this.onResize && nearLeft ? "left"
                    : "body";
                const grabDx = ev.clientX - box.left; // pointer offset within the box
                const winEnd = this.inPoint + this.windowLen; // anchored for left-edge
                const downX = ev.clientX;
                let moved = false;
                this.windowEl.style.cursor = dragMode === "body"
                    ? "grabbing"
                    : "ew-resize";
                const move = (mv: PointerEvent): void => {
                    if (!moved && Math.abs(mv.clientX - downX) <= 3) return;
                    moved = true; // past the click threshold: it's a drag
                    const x = mv.clientX - r.left;
                    if (dragMode === "body") {
                        const usable = this.duration - this.windowLen;
                        if (usable <= 0) return;
                        this.inPoint = clamp(
                            (mv.clientX - r.left - grabDx) * secPerPx,
                            0,
                            usable,
                        );
                    } else if (dragMode === "right") {
                        const end = clamp(
                            x * secPerPx,
                            this.inPoint + TakeStrip.MIN_LEN,
                            this.duration,
                        );
                        this.windowLen = end - this.inPoint;
                    } else { // left edge: move inPoint, keep the end fixed in take-time
                        const start = clamp(
                            x * secPerPx,
                            0,
                            winEnd - TakeStrip.MIN_LEN,
                        );
                        this.inPoint = start;
                        this.windowLen = winEnd - start;
                    }
                    this.positionWindow();
                };
                const up = (): void => {
                    window.removeEventListener("pointermove", move);
                    window.removeEventListener("pointerup", up);
                    this.windowEl.style.cursor = "grab";
                    if (!moved) {
                        /* a click on the box (no drag): treat it like scrubbing
                           the waveform — park the playhead here, don't slip or
                           play. Geometry was never mutated (move() gates on the
                           drag threshold). */
                        if (this.onScrub) {
                            const t = clamp(
                                (downX - r.left) * secPerPx,
                                0,
                                this.duration,
                            );
                            this.playheadAt = t;
                            this.paintCursor(t);
                            this.onScrub(t);
                        }
                        return;
                    }
                    if (dragMode === "body") {
                        /* slip: persist the new in-point. The owner (TUNE)
                           re-renders and replays the window; without an owner we
                           fall back to a direct audition preview. */
                        if (this.onInPointChange) {
                            this.onInPointChange(this.inPoint);
                        } else {
                            this.takes.scrubAudition(
                                this.sceneId,
                                this.lineId,
                                this.file,
                                this.inPoint,
                            );
                        }
                    } else {
                        this.onResize?.(this.inPoint, this.windowLen);
                    }
                };
                window.addEventListener("pointermove", move);
                window.addEventListener("pointerup", up);
            });
        }

        /* click/drag to scrub. With an owner (onScrub) the strip just reports the
           position and lets the owner decide what/how to play (windowed); without
           one it falls back to auditioning the take from that point. */
        const seekFromEvent = (ev: PointerEvent): void => {
            if (!this.duration) return;
            const r = this.canvas.getBoundingClientRect();
            const x = Math.max(0, Math.min(r.width, ev.clientX - r.left));
            const t = (x / r.width) * this.duration;
            if (this.onScrub) {
                this.playheadAt = t;
                this.paintCursor(t);
                this.onScrub(t);
            } else {
                this.takes.scrubAudition(this.sceneId, this.lineId, this.file, t);
                this.paintCursor(t);
            }
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
        if (this.onResetPlayhead) {
            this.canvas.addEventListener(
                "dblclick",
                () => this.onResetPlayhead!(),
            );
        }
        /* when owned by TUNE, a click on the strip is a scrub/playhead action —
           keep it from bubbling to the row's select-on-click handler (which would
           reset the playhead we just set). */
        if (this.onScrub) {
            this.element.addEventListener("click", (e) => e.stopPropagation());
        }

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
        Hidden when no windowLen is set, or the take is not longer than the
        window AND re-length isn't enabled (nothing to pick or trim). When
        re-length is enabled the box is always shown so the line can be made
        shorter even when the take only just fills the slot. */
    private positionWindow(): void {
        const show = this.windowLen > 0 && !!this.duration &&
            (this.onResize != null || this.duration > this.windowLen);
        if (!show) {
            this.windowEl.style.display = "none";
            return;
        }
        const leftFrac = Math.max(0, Math.min(1, this.inPoint / this.duration));
        const widthFrac = Math.max(
            0,
            Math.min(1 - leftFrac, this.windowLen / this.duration),
        );
        this.windowEl.style.display = "block";
        this.windowEl.style.left = `${(leftFrac * 100).toFixed(3)}%`;
        this.windowEl.style.width = `${(widthFrac * 100).toFixed(3)}%`;
    }

    /** Set the sticky playhead (seconds into the take) drawn while not playing,
        or null to hide it. The TUNE transport calls this; playback overrides it
        with the live position. */
    setPlayhead(sec: number | null): void {
        this.playheadAt = sec;
        this.tickOnce();
    }

    /** read the current audition position and paint the cursor accordingly.
      While this take is auditioning the cursor follows the live position; while
      paused/stopped it parks on the sticky playhead (or hides if unset). */
    private tickOnce(): void {
        if (this.destroyed) return;
        if (this.takes.auditioning === this.file) {
            const t = this.takes.auditionPosition();
            if (t >= 0) {
                this.paintCursor(t);
                return;
            }
        }
        if (this.playheadAt != null) this.paintCursor(this.playheadAt);
        else this.playhead.style.display = "none";
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

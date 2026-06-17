import type { Player } from "../engine/player";
import { el } from "./dom";

/* ============================================================================
   A slim global progress / seek bar for the modes without a timeline
   (RECORD, TUNE). It mirrors the global playhead across the whole project and
   seeks on click/drag, giving the global play button positional context.
   Mounted at the bottom edge of the transport bar; CSS shows it only in those
   modes. TIME has the real timeline and SCENE its own dock, so it stays hidden
   there.
============================================================================ */
export class GlobalProgress {
    readonly element: HTMLElement;
    private readonly fill: HTMLElement;
    private readonly player: Player;

    constructor(player: Player) {
        this.player = player;
        this.fill = el("div", { class: "t-progress-fill" });
        this.element = el(
            "div",
            { class: "t-progress", title: "seek the whole project" },
            this.fill,
        );
        this.element.addEventListener("pointerdown", (e) => {
            this.seekFromEvent(e);
            try {
                this.element.setPointerCapture(e.pointerId);
            } catch { /* capture is best-effort */ }
            const move = (mv: PointerEvent) => this.seekFromEvent(mv);
            const up = () => {
                this.element.removeEventListener("pointermove", move);
                this.element.removeEventListener("pointerup", up);
            };
            this.element.addEventListener("pointermove", move);
            this.element.addEventListener("pointerup", up);
        });
        player.events.on("time", () => this.paint());
        player.events.on("timings", () => this.paint());
        this.paint();
    }

    private seekFromEvent(e: PointerEvent): void {
        const r = this.element.getBoundingClientRect();
        if (r.width <= 0 || this.player.total <= 0) return;
        const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
        this.player.seek(frac * this.player.total);
    }

    private paint(): void {
        const total = this.player.total;
        const frac = total > 0 ? this.player.time / total : 0;
        this.fill.style.width = (Math.max(0, Math.min(1, frac)) * 100)
            .toFixed(3) + "%";
    }
}

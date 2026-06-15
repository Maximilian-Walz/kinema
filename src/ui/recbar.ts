import type { MicMonitor } from "../audio/monitor";
import type { Takes } from "../audio/takes";
import type { Player } from "../engine/player";
import { el } from "./dom";

/* ============================================================================
   Top-of-app recording banner. Slides in when a take is being captured and
   pins itself above all mode content (stage, transport, dock) so the user
   never loses the "you are recording" cue when switching modes.

   Layout, centred, compact (~32 px tall):

       [REC pulse] [REC tag]   Scene N - title - line k/n    0:04.7    [stop]

   The big stretched mic-meter that used to live up here is gone:
   - the record-view monitor bar already owns the shared MicMonitor widget
     (single-parent DOM), so mounting it here too would tear it out from
     down there;
   - the full-width meter also looked distorted and pushed the stop button
     to the screen edge in a way that didn't look connected to anything.

   The new banner is purely informational + one panic-stop chip: status,
   what is being recorded right now, and how long the take has been running.
   That is enough to tell "yes I'm recording" + "is this the wrong line?" +
   "should I stop now?" from any mode.

   Lives outside the grid via position:fixed; #app gets a top-padding class
   while the banner is visible so the stage doesn't disappear under it.
============================================================================ */

export class RecBar {
    private readonly element: HTMLElement;
    private readonly takes: Takes;
    private readonly player: Player;

    private readonly contextEl: HTMLElement;
    private readonly timeEl: HTMLElement;

    /** performance.now() captured when the current take started, used to
        display the take's elapsed seconds in the banner. */
    private takeStartMs = 0;
    private tickRaf = 0;

    constructor(takes: Takes, _micMonitor: MicMonitor, player: Player) {
        this.takes = takes;
        this.player = player;

        const dot = el("span", { class: "rb-dot" });
        const tag = el("span", { class: "rb-tag", text: "REC" });
        this.contextEl = el("span", { class: "rb-context" });
        this.timeEl = el("span", { class: "rb-time", text: "0:00.0" });
        const stop = el("button", {
            class: "rb-stop",
            text: "\u25a0",
            title: "stop recording (Esc)",
        });
        stop.onclick = () => takes.stopRecording();

        this.element = el(
            "div",
            { id: "recbar" },
            dot,
            tag,
            this.contextEl,
            this.timeEl,
            stop,
        );
        this.element.style.display = "none";
        document.body.appendChild(this.element);

        takes.events.on("recording", (on) => this.onRecording(on));
    }

    private onRecording(on: boolean): void {
        this.element.style.display = on ? "flex" : "none";
        document.body.classList.toggle("recording", on);
        if (on) {
            this.updateContext();
            this.takeStartMs = performance.now();
            this.timeEl.textContent = "0:00.0";
            this.startTick();
        } else {
            this.stopTick();
        }
    }

    /** Paint the scene title + line position. The line index is taken from
        the take currently being recorded; if Takes hasn't tagged one we
        fall back to the line covering the playhead. */
    private updateContext(): void {
        const scene = this.player.scene;
        const sceneIdx = this.player.sceneIndex;
        const lines = scene.lines;
        let lineIdx = -1;
        if (this.takes.recordingLine) {
            lineIdx = lines.findIndex((l) => l.id === this.takes.recordingLine);
        }
        if (lineIdx < 0) {
            const local = this.player.localTime;
            lineIdx = lines.findIndex((l) => local >= l.from && local < l.to);
        }
        const linePart = lineIdx >= 0 && lines.length
            ? ` \u00b7 line ${lineIdx + 1}/${lines.length}`
            : "";
        this.contextEl.textContent = `Scene ${
            sceneIdx + 1
        } \u00b7 ${scene.title}${linePart}`;
    }

    private startTick(): void {
        const loop = (): void => {
            const elapsed = (performance.now() - this.takeStartMs) / 1000;
            const m = Math.floor(elapsed / 60);
            const s = elapsed - m * 60;
            this.timeEl.textContent = `${m}:${s.toFixed(1).padStart(4, "0")}`;
            /* keep the scene/line context current too -- in chain mode the
               playhead crosses lines mid-take */
            this.updateContext();
            this.tickRaf = requestAnimationFrame(loop);
        };
        this.tickRaf = requestAnimationFrame(loop);
    }

    private stopTick(): void {
        if (this.tickRaf) {
            cancelAnimationFrame(this.tickRaf);
            this.tickRaf = 0;
        }
    }
}

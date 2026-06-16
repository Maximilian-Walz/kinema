import * as api from "../api";
import { TakeStrip } from "../audio/take-strip";
import type { Takes } from "../audio/takes";
import { fmt, type Player } from "../engine/player";
import type { TimedText } from "../types";
import { el } from "./dom";

/* ============================================================================
   TUNE mode bottom workspace.

   Layout (fills the bottom dock in place of the timeline):

     +---------------------------+----------------------------------------+
     |  SECTION NAVIGATOR        |  TAKE COMPARATOR                      |
     |  - line 1   [2 takes]     |  current line text                    |
     |  > line 2   [1 take]      |  --------------------------------     |
     |  - line 3   [-]           |  take 1  [\u25b6] [\u2605] [\u2715]   ~~~waveform~~~  |
     |  - line 4   [3 takes]     |  take 2  [\u25b6] [\u2605] [\u2715]   ~~~waveform~~~  |
     |                           |  (click waveform to scrub)             |
     +---------------------------+----------------------------------------+

   The "selected" section is whichever line the player cursor is on.
   Clicking a section in the navigator seeks to that line's start, so the
   side panel (post chain + playback meter) updates in lock-step.
============================================================================ */

export class TuneView {
    private readonly root: HTMLElement;
    private readonly player: Player;
    private readonly takes: Takes;

    private navEl!: HTMLElement;
    private bodyEl!: HTMLElement;
    private lastLineId: string | null = null;
    private strips: TakeStrip[] = [];

    constructor(root: HTMLElement, player: Player, takes: Takes) {
        this.root = root;
        this.player = player;
        this.takes = takes;

        this.build();

        player.events.on("scene", () => this.render());
        player.events.on("timings", () => this.render());
        player.events.on("time", () => this.maybeReRender());
        takes.events.on("change", () => this.render());

        this.render();
    }

    private build(): void {
        this.root.classList.add("tv");
        this.navEl = el("div", { class: "tv-nav" });
        this.bodyEl = el("div", { class: "tv-body" });
        this.root.append(this.navEl, this.bodyEl);
    }

    /** id of the script line under the cursor, or null if in a gap. */
    private activeLineId(): string | null {
        const local = this.player.localTime;
        for (const ln of this.player.scene.lines) {
            if (local >= ln.from && local < ln.to) return ln.id ?? null;
        }
        return null;
    }

    private maybeReRender(): void {
        const id = this.activeLineId();
        if (id !== this.lastLineId) this.render();
    }

    private render(): void {
        this.destroyStrips();
        this.navEl.replaceChildren();
        this.bodyEl.replaceChildren();
        const scene = this.player.scene;
        const activeId = this.activeLineId();
        this.lastLineId = activeId;

        /* ---- section navigator ---- */
        this.navEl.appendChild(
            el("div", {
                class: "tv-nav-title",
                text: `${scene.title} \u00b7 ${scene.lines.length} lines`,
            }),
        );
        scene.lines.forEach((ln, idx) => {
            const sect = ln.id
                ? this.takes.section(scene.id, ln.id)
                : undefined;
            const has = !!sect?.takes.length;
            const isActive = ln.id === activeId;
            const btn = el("button", {
                class: "tv-nav-row" + (isActive ? " active" : "") +
                    (has ? " has-takes" : ""),
                title: ln.text,
            });
            btn.append(
                el("span", { class: "tv-nav-num", text: `${idx + 1}` }),
                el("span", {
                    class: "tv-nav-text",
                    text: ln.text || "(empty)",
                }),
                el("span", {
                    class: "tv-nav-count",
                    text: sect?.takes.length
                        ? `${sect.takes.length}`
                        : "\u2013",
                }),
            );
            btn.onclick = () =>
                this.player.seek(
                    this.player.offsets[this.player.sceneIndex] + ln.from +
                        0.001,
                );
            this.navEl.appendChild(btn);
        });

        /* ---- take comparator ---- */
        if (!activeId) {
            this.bodyEl.appendChild(
                el("div", {
                    class: "tv-empty",
                    text: "seek to a script line to compare its takes",
                }),
            );
            return;
        }
        const activeLine = scene.lines.find((ln) => ln.id === activeId) as
            | TimedText
            | undefined;
        const sect = this.takes.section(scene.id, activeId);
        const header = el("div", { class: "tv-body-head" });
        header.append(
            el("span", {
                class: "tv-body-time",
                text: activeLine
                    ? `${fmt(activeLine.from)}\u2013${fmt(activeLine.to)}`
                    : "",
            }),
            el("span", { class: "tv-body-text", text: activeLine?.text || "" }),
        );
        this.bodyEl.appendChild(header);

        if (!sect?.takes.length) {
            this.bodyEl.appendChild(
                el("div", {
                    class: "tv-empty",
                    text:
                        "no takes for this line yet \u2014 record in RECORD mode",
                }),
            );
            return;
        }

        /* one wide row per take, most-recent first */
        const list = el("div", { class: "tv-takes" });
        sect.takes.slice().reverse().forEach((tk, i) => {
            const total = sect.takes.length;
            const ord = total - i;
            const row = el("div", {
                class: "tv-take" + (tk.file === sect.candidate ? " cand" : ""),
            });
            const play = el("button", {
                class: "tv-play",
                text: this.takes.auditioning === tk.file ? "\u23f8" : "\u25b6",
                title: "audition this take from the start",
            });
            play.onclick = () =>
                this.takes.toggleAudition(scene.id, activeId, tk.file);
            const name = el("span", {
                class: "tv-take-name",
                text: `take ${ord}`,
                title: tk.file,
            });
            const meta = el("span", {
                class: "tv-take-meta",
                text: new Date(tk.created).toLocaleTimeString(),
            });
            const star = el("button", {
                class: "tv-star",
                text: tk.file === sect.candidate
                    ? "\u2605 pick"
                    : "\u2606 pick",
                title: "set as the take used in preview and export",
            });
            star.onclick = async () => {
                await api.pickTake(scene.id, activeId, tk.file);
                await this.takes.refresh();
            };
            const del = el("button", {
                class: "tv-del",
                text: "\u2715",
                title: "move take to trash",
            });
            del.onclick = async () => {
                if (!confirm("Move this take to trash?")) return;
                await api.deleteTake(scene.id, activeId, tk.file);
                await this.takes.refresh();
            };
            const stripHost = el("div", { class: "tv-strip" });
            /* Overrun sub-take picker: only the picked (candidate) take exports/
               previews, so only it gets the draggable window. windowLen is the
               line's own duration; the strip hides the overlay when the take is
               not longer than that. */
            const isCandidate = tk.file === sect.candidate;
            const windowLen = activeLine ? activeLine.to - activeLine.from : 0;
            const strip = new TakeStrip(
                this.takes,
                scene.id,
                activeId,
                tk.file,
                isCandidate && windowLen > 0
                    ? {
                        height: 56,
                        windowLen,
                        inPoint: sect.inPoint,
                        onInPointChange: async (inPoint: number) => {
                            await api.setTakeInPoint(
                                scene.id,
                                activeId,
                                tk.file,
                                inPoint,
                            );
                            await this.takes.refresh();
                        },
                    }
                    : { height: 56 },
            );
            stripHost.appendChild(strip.element);
            this.strips.push(strip);

            row.append(play, name, star, meta, del, stripHost);
            list.appendChild(row);
        });
        this.bodyEl.appendChild(list);
    }

    private destroyStrips(): void {
        for (const s of this.strips) s.destroy();
        this.strips.length = 0;
    }
}

import * as api from "../api";
import { TakeStrip } from "../audio/take-strip";
import type { Takes } from "../audio/takes";
import { fmt, type Player } from "../engine/player";
import type { History } from "../history";
import type { TimingSync } from "../timings";
import type { TimedText } from "../types";
import { el } from "./dom";
import type { WorkspaceMode } from "./workspace-mode";

/* ============================================================================
   TUNE mode bottom workspace.

   Layout (fills the bottom dock in place of the timeline):

     +---------------------------+----------------------------------------+
     |  SECTION NAVIGATOR        |  TAKE COMPARATOR                      |
     |  - line 1   [2 takes]     |  current line text   [▶ play] [window]  |
     |  > line 2   [1 take]      |  --------------------------------     |
     |  - line 3   [-]           |  > take 1  [★] [✕]   ~~~waveform~~~  |
     |  - line 4   [3 takes]     |    take 2  [★] [✕]   ~~~waveform~~~  |
     +---------------------------+----------------------------------------+

   The "active" section is whichever line the player cursor is on. TUNE is
   take-centric: one take is *selected* (default = the picked one) and the
   transport (Space) plays/pauses THAT take, not the global timeline. By default
   only the picked sub-take window plays; a toggle hears the whole recording.
   A sticky playhead (set by clicking the waveform) is where playback starts and
   replays from until reset, so you can A/B one phrase while tuning the chain.

   The picked (candidate) take also gets draggable window edges to re-length the
   line: dragging an edge ripples later lines (the line's start stays pinned).
============================================================================ */

export class TuneView {
    private readonly root: HTMLElement;
    private readonly player: Player;
    private readonly takes: Takes;
    private readonly sync: TimingSync;
    private readonly history: History;

    private navEl!: HTMLElement;
    private bodyEl!: HTMLElement;
    private lastLineId: string | null = null;
    private strips: TakeStrip[] = [];
    /* refs + signature so a play/pause (which fires takes "change") can update
       just the button glyphs instead of rebuilding the whole comparator — a full
       rebuild re-creates every waveform strip and visibly reflows the row */
    private transportPlayLabel: HTMLElement | null = null;
    private playButtons: { file: string; btn: HTMLElement }[] = [];
    private lastSig = "";

    /** the take the transport controls; defaults to the active line's pick */
    private selectedFile: string | null = null;
    /** sticky playhead: seconds into the selected take that playback starts
        (and replays) from, until reset to the window start */
    private startAt = 0;
    /** play the whole recording instead of just the picked sub-take window */
    private wholeTake = false;
    private static readonly WHOLE_KEY = "tv.whole";

    constructor(
        root: HTMLElement,
        player: Player,
        takes: Takes,
        sync: TimingSync,
        history: History,
        mode: WorkspaceMode,
    ) {
        this.root = root;
        this.player = player;
        this.takes = takes;
        this.sync = sync;
        this.history = history;
        this.wholeTake = localStorage.getItem(TuneView.WHOLE_KEY) === "1";

        this.build();

        player.events.on("scene", () => this.onLineMaybeChanged(true));
        player.events.on("timings", () => this.render());
        player.events.on("time", () => this.onLineMaybeChanged(false));
        takes.events.on("change", () => this.onTakesChange());
        /* leaving TUNE stops any audition so it doesn't bleed into another mode */
        mode.events.on("change", (m) => {
            if (m !== "tune") this.takes.pauseAudition();
        });

        this.onLineMaybeChanged(true);
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

    /** Re-render on a cursor move; when the active LINE changes, reset the
        selection back to that line's pick and park the playhead at its window
        start (`force` skips the change check, e.g. on scene switch). */
    private onLineMaybeChanged(force: boolean): void {
        const id = this.activeLineId();
        if (!force && id === this.lastLineId) return;
        this.takes.pauseAudition();
        this.selectedFile = id ? this.takes.candidate(this.player.scene.id, id) : null;
        this.startAt = this.defaultStartAt(id, this.selectedFile);
        this.render();
    }

    /* --------------------------- window helpers --------------------------- */

    /** The selected take's playback window in take-time: where it starts within
        the recording (the candidate's in-point, else 0) and its length (the
        line's slot duration). */
    private windowOf(
        lineId: string,
        file: string,
    ): { start: number; len: number } {
        const scene = this.player.scene;
        const line = scene.lines.find((l) => l.id === lineId);
        const len = line ? line.to - line.from : 0;
        const sect = this.takes.section(scene.id, lineId);
        const start = sect?.candidate === file ? (sect.inPoint ?? 0) : 0;
        return { start, len };
    }

    /** Where the playhead parks by default: the window start (or take head in
        whole-take mode). */
    private defaultStartAt(lineId: string | null, file: string | null): number {
        if (this.wholeTake || !lineId || !file) return 0;
        return this.windowOf(lineId, file).start;
    }

    /* ------------------------------ transport ----------------------------- */

    /** Space in TUNE: play the selected take from the sticky playhead, or pause
        if it's already playing. Leaves the global player untouched. */
    togglePlay(): void {
        if (!this.selectedFile) return;
        if (this.takes.auditioning === this.selectedFile) {
            this.takes.pauseAudition();
        } else {
            this.play();
        }
    }

    private play(): void {
        const lineId = this.activeLineId();
        if (!lineId || !this.selectedFile) return;
        const { start, len } = this.windowOf(lineId, this.selectedFile);
        const end = this.wholeTake ? Infinity : start + len;
        this.takes.scrubAudition(
            this.player.scene.id,
            lineId,
            this.selectedFile,
            this.startAt,
            end,
        );
    }

    /** Restart the selected take from the window start (⇧R / restart button):
        park the playhead at the start and play. */
    restart(): void {
        const id = this.activeLineId();
        this.startAt = this.defaultStartAt(id, this.selectedFile);
        if (this.selectedFile) this.play();
        else this.render();
    }

    /** Reset the sticky playhead to the window start (double-click the wave). */
    resetPlayhead(): void {
        const id = this.activeLineId();
        this.startAt = this.defaultStartAt(id, this.selectedFile);
        if (this.selectedFile && this.takes.auditioning === this.selectedFile) {
            this.play();
        } else this.render();
    }

    get whole(): boolean {
        return this.wholeTake;
    }

    /** Toggle whole-recording vs picked-window playback (button / `W`). */
    setWhole(on: boolean): void {
        if (this.wholeTake === on) return;
        this.wholeTake = on;
        localStorage.setItem(TuneView.WHOLE_KEY, on ? "1" : "0");
        const playing = this.selectedFile != null &&
            this.takes.auditioning === this.selectedFile;
        this.startAt = this.defaultStartAt(this.activeLineId(), this.selectedFile);
        if (playing) this.play();
        else this.render();
    }

    private selectFile(file: string): void {
        if (this.selectedFile === file) return;
        this.takes.pauseAudition();
        this.selectedFile = file;
        this.startAt = this.defaultStartAt(this.activeLineId(), file);
        this.render();
    }

    /** Click on a take's waveform: select it and park the sticky playhead at the
        clicked position. Does NOT start playback (Space does); but if this take
        is already playing, re-anchor so you hear from the new spot. Re-render is
        deferred so it doesn't tear down the canvas handling this very click. */
    private scrubTo(file: string, sec: number): void {
        const wasPlaying = this.takes.auditioning === file;
        this.selectedFile = file;
        this.startAt = sec;
        if (wasPlaying) this.play();
        else setTimeout(() => this.render(), 0);
    }

    /* ------------------------------ re-length ----------------------------- */

    /** Apply a window-edge re-length: set the line's length to `newLen` (start
        pinned), ripple every later line / schedule entry / caption by the delta,
        and persist. Left-edge drags also move the in-point. Undoable. */
    private async applyRelength(
        lineId: string,
        file: string,
        inPoint: number,
        newLen: number,
    ): Promise<void> {
        const scene = this.player.scene;
        const line = scene.lines.find((l) => l.id === lineId);
        if (!line) return;
        const delta = newLen - (line.to - line.from);
        if (Math.abs(delta) > 1e-4) {
            const anchor = line.to; // old end; content at/after it shifts
            const before = this.history.snapshot(scene);
            line.to = line.from + newLen;
            for (const ln of scene.lines) {
                if (ln === line) continue;
                if (ln.from >= anchor) {
                    ln.from += delta;
                    ln.to += delta;
                }
            }
            for (const s of scene.schedule) {
                if (s.enter >= anchor) s.enter += delta;
                if (s.exit != null && s.exit >= anchor) s.exit += delta;
            }
            for (const c of scene.captions) {
                if (c.from >= anchor) c.from += delta;
                if (c.to >= anchor) c.to += delta;
            }
            scene.len += delta;
            this.history.commit(scene, before);
            this.sync.changed(scene); // refresh engine + debounced putTimings
        }
        const sect = this.takes.section(scene.id, lineId);
        if (Math.abs((sect?.inPoint ?? 0) - inPoint) > 1e-4) {
            await api.setTakeInPoint(scene.id, lineId, file, inPoint);
            await this.takes.refresh();
        } else {
            this.render();
        }
    }

    /* ------------------------------- render ------------------------------- */

    /** A signature of everything the comparator's STRUCTURE depends on. When it
        is unchanged, a takes "change" (e.g. audition start/stop) only needs the
        play-button glyphs refreshed, not a full rebuild. */
    private structureSig(lineId: string | null): string {
        const scene = this.player.scene;
        const sect = lineId ? this.takes.section(scene.id, lineId) : undefined;
        return [
            scene.id,
            lineId ?? "",
            sect?.candidate ?? "",
            sect?.inPoint ?? 0,
            this.selectedFile ?? "",
            this.wholeTake ? 1 : 0,
            (sect?.takes ?? []).map((t) => t.file).join(","),
        ].join("|");
    }

    private onTakesChange(): void {
        const id = this.activeLineId();
        if (id !== this.lastLineId) {
            this.onLineMaybeChanged(true);
            return;
        }
        if (this.structureSig(id) !== this.lastSig) this.render();
        else this.updatePlayButtons();
    }

    /** Cheap in-place refresh of the play/pause affordances (no rebuild). Only
        the label text changes — the keybind chip is a separate child. */
    private updatePlayButtons(): void {
        const aud = this.takes.auditioning;
        if (this.transportPlayLabel) {
            const playing = this.selectedFile != null &&
                aud === this.selectedFile;
            this.transportPlayLabel.textContent = playing ? "⏸" : "▶";
        }
        for (const { file, btn } of this.playButtons) {
            btn.textContent = aud === file ? "⏸" : "▶";
        }
    }

    private render(): void {
        this.destroyStrips();
        this.transportPlayLabel = null;
        this.playButtons = [];
        this.navEl.replaceChildren();
        this.bodyEl.replaceChildren();
        const scene = this.player.scene;
        const activeId = this.activeLineId();
        this.lastLineId = activeId;

        /* ---- section navigator ---- */
        this.navEl.appendChild(
            el("div", {
                class: "tv-nav-title",
                text: `${scene.title} · ${scene.lines.length} lines`,
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
                    text: sect?.takes.length ? `${sect.takes.length}` : "–",
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
            this.lastSig = this.structureSig(activeId);
            return;
        }
        const activeLine = scene.lines.find((ln) => ln.id === activeId) as
            | TimedText
            | undefined;
        const sect = this.takes.section(scene.id, activeId);

        /* validate the selection against the current take list */
        const files = (sect?.takes ?? []).map((t) => t.file);
        if (!this.selectedFile || !files.includes(this.selectedFile)) {
            this.selectedFile = sect?.candidate ?? files[files.length - 1] ?? null;
        }

        const header = el("div", { class: "tv-body-head" });
        header.append(
            el("span", {
                class: "tv-body-time",
                text: activeLine
                    ? `${fmt(activeLine.from)}–${fmt(activeLine.to)}`
                    : "",
            }),
            el("span", { class: "tv-body-text", text: activeLine?.text || "" }),
            this.buildTransport(),
        );
        this.bodyEl.appendChild(header);

        if (!sect?.takes.length) {
            this.bodyEl.appendChild(
                el("div", {
                    class: "tv-empty",
                    text:
                        "no takes for this line yet — record in RECORD mode",
                }),
            );
            this.lastSig = this.structureSig(activeId);
            return;
        }

        /* one wide row per take, most-recent first */
        const list = el("div", { class: "tv-takes" });
        sect.takes.slice().reverse().forEach((tk, i) => {
            const total = sect.takes.length;
            const ord = total - i;
            const isCandidate = tk.file === sect.candidate;
            const isSelected = tk.file === this.selectedFile;
            const row = el("div", {
                class: "tv-take" + (isCandidate ? " cand" : "") +
                    (isSelected ? " selected" : ""),
            });
            /* click anywhere on the row (padding included) selects the take; the
               strip stops its own clicks from bubbling so scrubbing the waveform
               doesn't reset the playhead via this handler. */
            row.onclick = () => this.selectFile(tk.file);
            const play = el("button", {
                class: "tv-play",
                text: this.takes.auditioning === tk.file ? "⏸" : "▶",
                title: "select + play this take (space)",
            });
            play.onclick = () => {
                this.selectFile(tk.file);
                this.togglePlay();
            };
            this.playButtons.push({ file: tk.file, btn: play });
            const name = el("span", {
                class: "tv-take-name",
                text: `take ${ord}`,
                title: tk.file,
            });
            name.onclick = () => this.selectFile(tk.file);
            const meta = el("span", {
                class: "tv-take-meta",
                text: new Date(tk.created).toLocaleTimeString(),
            });
            const star = el("button", {
                class: "tv-star",
                text: isCandidate ? "★ pick" : "☆ pick",
                title: "set as the take used in preview and export",
            });
            star.onclick = async () => {
                await api.pickTake(scene.id, activeId, tk.file);
                await this.takes.refresh();
            };
            const del = el("button", {
                class: "tv-del",
                text: "✕",
                title: "move take to trash",
            });
            del.onclick = async () => {
                if (!confirm("Move this take to trash?")) return;
                await api.deleteTake(scene.id, activeId, tk.file);
                await this.takes.refresh();
            };
            const stripHost = el("div", { class: "tv-strip" });
            const windowLen = activeLine ? activeLine.to - activeLine.from : 0;
            const playheadAt = isSelected ? this.startAt : undefined;
            /* Only the picked (candidate) take exports/previews, so only it gets
               the editable window (slip body + re-length edges). Other takes are
               audition-only: click to scrub, no window edits. */
            const strip = isCandidate && windowLen > 0
                ? new TakeStrip(this.takes, scene.id, activeId, tk.file, {
                    height: 56,
                    windowLen,
                    inPoint: sect?.inPoint ?? 0,
                    playheadAt,
                    onInPointChange: async (inPoint: number) => {
                        /* slip moved the window start; park the playhead there,
                           persist, and replay the new slice */
                        this.selectedFile = tk.file;
                        this.startAt = inPoint;
                        await api.setTakeInPoint(
                            scene.id,
                            activeId,
                            tk.file,
                            inPoint,
                        );
                        await this.takes.refresh();
                        this.play();
                    },
                    onResize: (inPoint: number, len: number) =>
                        void this.applyRelength(activeId, tk.file, inPoint, len),
                    onScrub: (sec: number) => this.scrubTo(tk.file, sec),
                    onResetPlayhead: () => this.resetPlayhead(),
                })
                : new TakeStrip(this.takes, scene.id, activeId, tk.file, {
                    height: 56,
                    playheadAt,
                    onScrub: (sec: number) => this.scrubTo(tk.file, sec),
                    onResetPlayhead: () => this.resetPlayhead(),
                });
            stripHost.appendChild(strip.element);
            this.strips.push(strip);

            row.append(play, name, star, meta, del, stripHost);
            list.appendChild(row);
        });
        this.bodyEl.appendChild(list);
        this.lastSig = this.structureSig(activeId);
    }

    /** play/pause + whole/window + reset transport row. Each button leads with a
        label and trails with its keybind chip (same `.t-kbd` convention as the
        global transport / rec button). */
    private buildTransport(): HTMLElement {
        const wrap = el("div", { class: "tv-transport" });
        const mk = (
            cls: string,
            label: string,
            key: string,
            title: string,
            onclick: () => void,
            icon = false,
        ): { btn: HTMLElement; label: HTMLElement } => {
            const btn = el("button", { class: cls, title });
            /* icon buttons get the shared fixed-width centred glyph span so a
               ▶/⏸ swap never moves the chip; text buttons keep a plain label */
            const lab = el("span", {
                class: icon ? "t-btn-icon" : "tv-tp-label",
                text: label,
            });
            btn.append(lab, el("span", { class: "t-kbd", text: key }));
            btn.onclick = onclick;
            wrap.appendChild(btn);
            return { btn, label: lab };
        };

        const playing = this.selectedFile != null &&
            this.takes.auditioning === this.selectedFile;
        const play = mk(
            "tv-tp-play",
            playing ? "⏸" : "▶",
            "SPACE",
            "play / pause the selected take",
            () => this.togglePlay(),
            true,
        );
        this.transportPlayLabel = play.label;
        mk(
            "tv-tp-scope" + (this.wholeTake ? "" : " on"),
            this.wholeTake ? "whole take" : "window",
            "W",
            "play only the picked sub-take window, or the whole recording",
            () => this.setWhole(!this.wholeTake),
        );
        mk(
            "tv-tp-restart",
            "⟲",
            "⇧R",
            "restart the take from the window start",
            () => this.restart(),
            true,
        );
        return wrap;
    }

    private destroyStrips(): void {
        for (const s of this.strips) s.destroy();
        this.strips.length = 0;
    }
}

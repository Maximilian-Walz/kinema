import * as api from "../api";
import type { MicMonitor } from "../audio/monitor";
import { TakeStrip } from "../audio/take-strip";
import type { Takes } from "../audio/takes";
import { fmt, type Player } from "../engine/player";
import type { History } from "../history";
import { rippleLineLength, type TimingSync } from "../timings";
import type { TimedText } from "../types";
import { el } from "./dom";

/* ============================================================================
   RECORD mode bottom workspace.

   Layout (occupies the bottom dock that the timeline normally holds):

     +----------------------------------------------------------------------+
     | [\u25cf rec] [chain|hold] \u2502 [\u23f5 arm] [meter] [wave] [\u25cf] \u2502 [status \u2026]      |
     +----------------------------------------------------------------------+
     | scene N \u00b7 Title                                                      |
     |                                                                      |
     |   previous line (dim)                                                |
     |                                                                      |
     |   CURRENT LINE -- big, centred                                       |
     |                                                                      |
     |   next line (dim)                                                    |
     |   ...                                                                |
     +----------------------------------------------------------------------+

   The monitor bar mounts MicMonitor (the same singleton the TUNE/TAKES tab
   uses), so arming the mic in any mode keeps the widgets alive.

   The rec button records the line currently under the cursor with a 3-2-1
   count-in; on stop the recording is auto-picked. Whether recording chains
   into the next line at line-end is controlled by the chain/hold toggle.
============================================================================ */

export class RecordView {
    private readonly root: HTMLElement;
    private readonly player: Player;
    private readonly takes: Takes;
    private readonly micMonitor: MicMonitor;

    private monitorMeterHost!: HTMLElement;
    /** Persistent slot inside monitorMeterHost that holds the live waveform
        canvas when armed and is empty (just a styled placeholder) when not.
        Created once at build time so the layout is identical in both states. */
    private waveSlot!: HTMLElement;
    /** Persistent slot for the live level meter widget (with its built-in
        clip LED). Same lifetime / sizing guarantee as waveSlot. */
    private meterSlot!: HTMLElement;
    private armBtn!: HTMLButtonElement;
    private armIconEl!: HTMLElement;
    private armLabelEl!: HTMLElement;
    private recBtn!: HTMLButtonElement;
    private recIconEl!: HTMLElement;
    private recLabelEl!: HTMLElement;
    private statusEl!: HTMLElement;

    private promptHost!: HTMLElement;
    private lineEls: {
        div: HTMLElement;
        from: number;
        to: number;
        line: TimedText;
    }[] = [];
    private lastCurrentId: string | null = null;

    /* post-take review panel (sub-take window + re-length) */
    private readonly sync: TimingSync;
    private readonly history: History;
    private reviewHost!: HTMLElement;
    private reviewStrip: TakeStrip | null = null;
    /** the line whose take we're reviewing (the most recently recorded line) */
    private reviewLineId: string | null = null;
    /** lineId|file currently shown, so we only rebuild when the take changes */
    private reviewKey: string | null = null;

    constructor(
        root: HTMLElement,
        player: Player,
        takes: Takes,
        micMonitor: MicMonitor,
        sync: TimingSync,
        history: History,
    ) {
        this.root = root;
        this.player = player;
        this.takes = takes;
        this.micMonitor = micMonitor;
        this.sync = sync;
        this.history = history;

        this.build();

        player.events.on("scene", () => {
            this.reviewLineId = null; // navigated away -> drop the review
            this.renderReview();
            this.renderPrompter();
        });
        player.events.on("time", () => this.tick());
        player.events.on("timings", () => this.renderPrompter());

        takes.events.on("monitor", () => this.refreshMonitor());
        takes.events.on("recording", (on) => this.onRecording(on));
        takes.events.on("countdown", (n) => this.onCountdown(n));
        takes.events.on("change", () => {
            this.tick();
            this.renderReview();
        });

        this.renderPrompter();
        this.refreshMonitor();
    }

    /* ------------------------------- build --------------------------------- */

    /* Bar layout (left → right):
         [ ● rec ] [ chain | hold ]   │   [ ⏵ arm ] [meter] [waveform] [● clip]   │   [ status … ]
         action group                 monitor group                            messages
       The action group is anchored to the left edge so the primary click /
       R-key target is at a fixed position. The mic group occupies a stable
       width even when the mic is disarmed so toggling arm doesn't reflow
       the rest of the bar. Status text flexes to fill the remainder and
       ellipsizes when long. */
    private build(): void {
        const monitor = el("div", { class: "rv-monitor" });

        /* --- action group: rec + chain/hold ---------------------------- */
        this.recBtn = el("button", {
            class: "rv-rec",
            title: "record the line under the cursor with a 3-2-1 count-in (r)",
        }) as HTMLButtonElement;
        /* Labels use fixed-width slots so the rec/stop swap (and the count-in
           digits) never reflow the bar. We build the button with two spans
           and only swap their textContent; the .rv-rec rule reserves enough
           min-width for the longest state. The .t-kbd chip uses the same
           shared style as the transport-bar buttons. */
        this.recIconEl = el("span", { class: "rv-btn-icon", text: "\u25cf" });
        this.recLabelEl = el("span", { class: "rv-btn-label", text: "rec" });
        this.recBtn.append(
            this.recIconEl,
            this.recLabelEl,
            el("span", { class: "t-kbd", text: "R" }),
        );
        this.recBtn.onclick = async () => {
            if (this.takes.recording || this.takes.counting) {
                this.takes.stopRecording();
                return;
            }
            /* Auto-arm if the user hasn't already. Recording without
               monitoring is flying blind, and startRecordingWithCountIn
               opens the mic anyway -- doing it via startMonitor() here
               means the meter/waveform are live during the count-in too. */
            if (!this.takes.monitoring) {
                const armErr = await this.takes.startMonitor();
                if (armErr) {
                    this.setStatus(armErr);
                    return;
                }
            }
            const lineId = this.currentLineId();
            const err = await this.takes.startRecordingWithCountIn(
                lineId ?? undefined,
            );
            if (err) this.setStatus(err);
        };

        const chain = this.buildChainToggle();
        const actionGroup = el(
            "div",
            { class: "rv-group rv-action" },
            this.recBtn,
            chain,
        );

        /* --- mic group: arm + meter + waveform + clip dot -------------- */
        this.armBtn = el("button", {
            class: "rv-arm",
            title: "open the microphone so you can see input levels",
        }) as HTMLButtonElement;
        /* Same icon+label split as the rec button so the width never jumps
           between the armed ("mute") and disarmed ("arm") states. */
        this.armIconEl = el("span", {
            class: "rv-btn-icon",
            text: "\u23fa",
        });
        this.armLabelEl = el("span", {
            class: "rv-btn-label",
            text: "arm",
        });
        this.armBtn.append(this.armIconEl, this.armLabelEl);
        this.armBtn.onclick = async () => {
            if (this.takes.monitoring) this.takes.stopMonitor();
            else {
                const err = await this.takes.startMonitor();
                if (err) this.setStatus(err);
            }
        };

        /* Two persistent slots that host the MicMonitor widgets. The widgets
           are mounted ONCE during build and stay there forever -- they read
           from a silent router analyser when the mic is disarmed and from
           the live mic when armed. Same DOM nodes, same dimensions, always. */
        this.waveSlot = el("div", { class: "rv-slot rv-wave-slot" });
        this.meterSlot = el("div", { class: "rv-slot rv-meter-slot" });
        const wf = this.micMonitor.waveformEl;
        const meter = this.micMonitor.meterEl;
        if (wf) this.waveSlot.appendChild(wf);
        if (meter) this.meterSlot.appendChild(meter);
        this.micMonitor.start();
        this.monitorMeterHost = el(
            "div",
            { class: "rv-monitor-host" },
            this.waveSlot,
            this.meterSlot,
        );

        const micGroup = el(
            "div",
            { class: "rv-group rv-mic" },
            this.armBtn,
            this.monitorMeterHost,
        );

        /* --- status messages ------------------------------------------ */
        this.statusEl = el("span", { class: "rv-status" });

        monitor.append(
            actionGroup,
            el("span", { class: "rv-sep" }),
            micGroup,
            el("span", { class: "rv-sep" }),
            this.statusEl,
        );

        /* --- prompter --------------------------------------------------
           The text-size zoom widget (A-/A+) is mounted as a sibling of the
           scrollable prompter, inside a positioned wrapper. Putting it INSIDE
           the prompter caused renderPrompter()'s replaceChildren() to wipe it
           on every scene change. As an absolute-positioned overlay sibling it
           survives prompter rebuilds. */
        this.promptHost = el("div", { class: "rv-prompter" });
        const promptWrap = el(
            "div",
            { class: "rv-prompter-wrap" },
            this.promptHost,
            this.buildZoomControl(),
        );
        this.applyPrompterFontSize();

        this.reviewHost = el("div", { class: "rv-review" });
        this.reviewHost.style.display = "none";
        this.root.classList.add("rv");
        this.root.append(monitor, this.reviewHost, promptWrap);
    }

    /* ---------------------------- font-size ------------------------------- */

    /* localStorage key + clamp range for the prompter base font size. The
       size drives --rv-base on .rv-prompter; everything else (current-line
       scale, max-width) scales off it, so wrap points stay aligned. */
    private static readonly FONT_KEY = "rv.fontPx";
    private static readonly FONT_MIN = 11;
    private static readonly FONT_MAX = 28;
    private static readonly FONT_DEFAULT = 15;

    private getPrompterFontSize(): number {
        const raw = Number(localStorage.getItem(RecordView.FONT_KEY));
        if (!Number.isFinite(raw) || raw <= 0) return RecordView.FONT_DEFAULT;
        return Math.max(
            RecordView.FONT_MIN,
            Math.min(RecordView.FONT_MAX, raw),
        );
    }

    private setPrompterFontSize(px: number): void {
        const clamped = Math.max(
            RecordView.FONT_MIN,
            Math.min(RecordView.FONT_MAX, Math.round(px)),
        );
        localStorage.setItem(RecordView.FONT_KEY, String(clamped));
        this.applyPrompterFontSize();
    }

    private applyPrompterFontSize(): void {
        const px = this.getPrompterFontSize();
        this.promptHost.style.setProperty("--rv-base", `${px}px`);
    }

    private buildZoomControl(): HTMLElement {
        const wrap = el("div", {
            class: "rv-zoom",
            title: "prompter text size",
        });
        const minus = el("button", {
            text: "A\u2212",
            title: "smaller prompter text",
        }) as HTMLButtonElement;
        const plus = el("button", {
            text: "A+",
            title: "larger prompter text",
        }) as HTMLButtonElement;
        minus.onclick = () =>
            this.setPrompterFontSize(this.getPrompterFontSize() - 1);
        plus.onclick = () =>
            this.setPrompterFontSize(this.getPrompterFontSize() + 1);
        wrap.append(minus, plus);
        return wrap;
    }

    /* ----------------------------- chain mode ----------------------------- */

    /* localStorage flag that controls what happens when a recording reaches
       the end of its line. Persisted by the UI; Takes just reads the bool. */
    private static readonly CHAIN_KEY = "rv.chainMode";

    private getChainMode(): boolean {
        return localStorage.getItem(RecordView.CHAIN_KEY) === "1";
    }

    private setChainMode(on: boolean, btn: HTMLButtonElement): void {
        localStorage.setItem(RecordView.CHAIN_KEY, on ? "1" : "0");
        this.takes.chainMode = on;
        this.paintChainBtn(btn, on);
    }

    private paintChainBtn(btn: HTMLButtonElement, on: boolean): void {
        btn.classList.toggle("on", on);
        btn.textContent = on ? "\u21a6 chain" : "\u221e free";
        btn.title = on
            ? "chain: auto-record the next line when this one ends (click for free)"
            : "free: stay on this line, record as long as you like, then pick or extend the take (click for chain)";
    }

    private buildChainToggle(): HTMLElement {
        const btn = el("button", { class: "rv-chain" }) as HTMLButtonElement;
        const initial = this.getChainMode();
        this.takes.chainMode = initial;
        this.paintChainBtn(btn, initial);
        btn.onclick = () => this.setChainMode(!this.getChainMode(), btn);
        return btn;
    }

    /* ------------------------------ prompter ------------------------------- */

    private renderPrompter(): void {
        this.promptHost.replaceChildren();
        this.lineEls = [];
        const scene = this.player.scene;
        const idx = this.player.sceneIndex;

        this.promptHost.appendChild(
            el("div", {
                class: "rv-scenetitle",
                text: `${idx + 1} \u00b7 ${scene.title}`,
            }),
        );

        const list = el("div", { class: "rv-lines" });
        if (!scene.lines.length) {
            list.appendChild(
                el("div", {
                    class: "rv-empty",
                    text: "no narration lines in this scene",
                }),
            );
        }
        scene.lines.forEach((ln) => {
            const div = el(
                "div",
                {
                    class: "rv-line",
                    title: `${fmt(ln.from)}\u2013${
                        fmt(ln.to)
                    } \u00b7 click to seek`,
                },
                ln.text || "(empty line)",
            );
            div.onclick = () =>
                this.player.seek(this.player.offsets[idx] + ln.from + 0.001);
            list.appendChild(div);
            this.lineEls.push({ div, from: ln.from, to: ln.to, line: ln });
        });
        this.promptHost.appendChild(list);
        this.lastCurrentId = null;
        this.tick();
    }

    /** Find the line under the cursor (the one with from <= local < to).
      Returns null if the cursor sits in a gap (between lines). */
    private currentLineIndex(): number {
        const local = this.player.localTime;
        for (let i = 0; i < this.lineEls.length; i++) {
            const le = this.lineEls[i];
            if (local >= le.from && local < le.to) return i;
        }
        return -1;
    }

    private currentLineId(): string | null {
        const i = this.currentLineIndex();
        if (i < 0) return null;
        return this.lineEls[i].line.id ?? null;
    }

    /** progress bar shown under the line currently being recorded */
    private lineProgress: HTMLElement | null = null;

    /* highlight + autoscroll the current line, light up the section dot */
    private tick(): void {
        if (!this.lineEls.length) return;
        const local = this.player.localTime;
        let curIdx = this.currentLineIndex();
        /* FREE-mode recording freezes the prompter on the line being recorded:
           the playhead rolls on (so you can overrun), but we don't promote the
           next line -- that auto-advance belongs to chain mode. */
        const recId = this.takes.recording ? this.takes.recordingLine : null;
        if (recId && !this.takes.chainMode) {
            const ri = this.lineEls.findIndex((le) => le.line.id === recId);
            if (ri >= 0) curIdx = ri;
        }
        for (let i = 0; i < this.lineEls.length; i++) {
            const le = this.lineEls[i];
            const cur = i === curIdx;
            le.div.classList.toggle("current", cur);
            le.div.classList.toggle("done", local >= le.to && !cur);
            le.div.classList.toggle("next", i === curIdx + 1);
            le.div.classList.toggle("prev", i === curIdx - 1);
        }
        this.updateLineProgress(recId, local);
        const cur = curIdx >= 0 ? this.lineEls[curIdx] : null;
        const curId = cur ? cur.line.id ?? `__idx${curIdx}` : null;
        if (cur && curId !== this.lastCurrentId) {
            this.scrollLineIntoView(cur.div);
            this.lastCurrentId = curId;
        } else if (!cur) {
            this.lastCurrentId = null;
        }
        /* keep the rec button enabled state in sync; whether a line is under
           the cursor is reflected in the prompter highlight, not the label */
        if (!this.takes.recording && !this.takes.counting) {
            this.recIconEl.textContent = "\u25cf";
            this.recLabelEl.textContent = "rec";
            this.recBtn.disabled = false;
        }
    }

    /** Draw a thin progress bar under the line being recorded: it fills across
        the line's intended duration, then flips to a pulsing "over" colour once
        the take overruns the slot (FREE mode). Hidden when not recording. */
    private updateLineProgress(recId: string | null, local: number): void {
        const le = recId ? this.lineEls.find((l) => l.line.id === recId) : null;
        if (!le) {
            if (this.lineProgress) this.lineProgress.style.display = "none";
            return;
        }
        if (!this.lineProgress) {
            this.lineProgress = el("div", { class: "rv-line-bar" },
                el("div", { class: "rv-line-bar-fill" }));
        }
        if (this.lineProgress.parentElement !== le.div) {
            le.div.appendChild(this.lineProgress);
        }
        const dur = Math.max(0.01, le.to - le.from);
        const prog = (local - le.from) / dur;
        const fill = this.lineProgress.firstElementChild as HTMLElement;
        fill.style.width = Math.max(0, Math.min(1, prog)) * 100 + "%";
        this.lineProgress.classList.toggle("over", prog > 1);
        this.lineProgress.style.display = "block";
    }

    /** Scroll the current line into the upper third of the prompter, without
        triggering any ancestor scroll.

        We compute the desired scrollTop ourselves rather than calling
        Element.scrollIntoView, which in some Chrome configurations also
        nudges document.body even with overflow:hidden -- making the whole
        grid jump up by ~150 px.

        We position the current line roughly one-third down from the top
        rather than centred so the user sees more of what's coming up next
        (their reading horizon) than what they've already read. offsetTop is
        unreliable here -- the prompter has no `position` set, so it would
        measure against a higher ancestor and yield a huge value, clamping
        scrollTo() to the end. Use bounding rects instead. */
    private scrollLineIntoView(line: HTMLElement): void {
        const host = this.promptHost;
        if (host.clientHeight <= 0) return;
        const lr = line.getBoundingClientRect();
        const hr = host.getBoundingClientRect();
        const lineTop = lr.top - hr.top + host.scrollTop;
        /* place the line's *top* ~28% down from the prompter's top edge so
           the next ~70% of the viewport shows upcoming lines */
        const offset = lineTop - host.clientHeight * 0.28;
        host.scrollTo({ top: Math.max(0, offset), behavior: "smooth" });
    }

    /* ----------------------------- monitor --------------------------------- */

    /* Repaints just the arm button + tooltip on arm state changes. The
       MicMonitor widgets are persistent (mounted once in build()) and read
       from a silent router when disarmed, so there is no widget swap and
       therefore no possibility of the host geometry drifting. */
    private refreshMonitor(): void {
        const armed = this.takes.monitoring;
        this.armLabelEl.textContent = armed ? "mute" : "arm";
        this.armBtn.title = armed
            ? "release the microphone"
            : "open the microphone so you can see input levels";
        this.armBtn.classList.toggle("live", armed);
        this.monitorMeterHost.classList.toggle("disarmed", !armed);
    }

    /* --------------------------- record state ------------------------------ */

    private onRecording(on: boolean): void {
        this.recBtn.classList.toggle("live", on);
        this.recIconEl.textContent = on ? "\u25a0" : "\u25cf";
        this.recLabelEl.textContent = on ? "stop" : "rec";
        this.root.classList.toggle("recording", on);
        if (on) {
            /* remember which line we're capturing so we can review its take
               (sub-take window + re-length) inline once recording stops. */
            this.reviewLineId = this.takes.recordingLine;
        } else {
            this.tick();
            this.renderReview();
            /* Overrun: if the take ran past the line's slot, point the user at
               the inline review panel. */
            if (this.takes.overranLastStop) {
                this.takes.overranLastStop = false;
                this.setStatus(
                    "longer take captured \u2014 drag the window below to pick what plays, or its right edge to set the line length",
                );
            }
        }
    }

    /* --------------------------- post-take review -------------------------- */

    /** Show the just-recorded line's candidate take with a draggable sub-take
        window (which slice plays) and a right-edge handle (re-length the line,
        rippling the rest of the scene). Rebuilt only when the line or its
        candidate take changes, so it survives auditions / in-point edits. */
    private renderReview(): void {
        const lineId = this.reviewLineId;
        const scene = lineId
            ? this.player.project.scenes.find((s) =>
                s.lines.some((l) => l.id === lineId))
            : undefined;
        const line = scene?.lines.find((l) => l.id === lineId);
        const file = scene && lineId ? this.takes.candidate(scene.id, lineId) : null;
        if (!scene || !line || !lineId || !file) {
            this.clearReview();
            return;
        }
        const key = lineId + "|" + file;
        if (this.reviewStrip && this.reviewKey === key) return; // already shown
        this.clearReview();
        this.reviewKey = key;
        const strip = new TakeStrip(this.takes, scene.id, lineId, file, {
            height: 54,
            windowLen: Math.max(0.01, line.to - line.from),
            inPoint: this.takes.inPoint(scene.id, lineId),
            onInPointChange: async (inPoint) => {
                await api.setTakeInPoint(scene.id, lineId, file, inPoint);
                await this.takes.refresh();
            },
            onWindowLenChange: (newDur) => {
                const before = this.history.snapshot(scene);
                rippleLineLength(scene, lineId, newDur);
                this.sync.changed(scene); // refresh engine + persist scene.json
                this.history.commit(scene, before);
            },
        });
        this.reviewStrip = strip;
        this.reviewHost.replaceChildren(
            el("div", {
                class: "rv-review-label",
                text:
                    "review take \u00b7 drag the window to pick what plays \u00b7 drag its right edge to set the line length",
            }),
            strip.element,
        );
        this.reviewHost.style.display = "block";
    }

    private clearReview(): void {
        if (this.reviewStrip) {
            this.reviewStrip.destroy();
            this.reviewStrip = null;
        }
        this.reviewKey = null;
        this.reviewHost.replaceChildren();
        this.reviewHost.style.display = "none";
    }

    private onCountdown(n: number | null): void {
        if (n === null) {
            this.recBtn.classList.remove("counting");
            this.tick();
        } else if (n === 0) {
            this.recBtn.classList.remove("counting");
        } else {
            this.recBtn.classList.add("counting");
            this.recIconEl.textContent = String(n);
            this.recLabelEl.textContent = "\u2026";
        }
    }

    private setStatus(text: string): void {
        this.statusEl.textContent = text;
        window.setTimeout(() => {
            if (this.statusEl.textContent === text) {
                this.statusEl.textContent = "";
            }
        }, 3500);
    }
}

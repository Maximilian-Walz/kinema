import { getProject } from "../api";
import { Emitter } from "../emitter";
import { el } from "./dom";

/* ============================================================================
   Workspace modes. Three top-level workspaces, each optimised for one of the
   user's main workflows:

     RECORD   capture takes -- teleprompter + mic monitor + per-line rec button
     TUNE     audition and compare takes, configure post chain
     TIME     retime the animation against the recorded narration (full timeline)
     STAGE    choreograph one scene -- live preview + per-element schedule editor
              (pick elements off the stage, name them, retime, pick an animation)

   The active mode drives a `body.mode-*` class which the CSS grid uses to
   collapse or promote the timeline / side panel. The mode is persisted per
   project in localStorage. Switching modes is non-destructive: playhead, mic
   arm state, recording, selection, etc. are owned by their respective modules
   and are not touched here.
============================================================================ */

export type Mode = "record" | "tune" | "time" | "stage";
export const MODES: Mode[] = ["record", "tune", "time", "stage"];

const LS_KEY = "video-studio.mode";

function storageKey(): string {
    return `${LS_KEY}:${getProject() ?? "__default__"}`;
}

function readStored(): Mode {
    try {
        const raw = localStorage.getItem(storageKey());
        if (raw && (MODES as string[]).includes(raw)) return raw as Mode;
    } catch { /* localStorage may be unavailable */ }
    return "time";
}

function writeStored(mode: Mode): void {
    try {
        localStorage.setItem(storageKey(), mode);
    } catch { /* ignore */ }
}

const LABEL: Record<Mode, string> = {
    record: "RECORD",
    tune: "TUNE",
    time: "TIME",
    stage: "STAGE",
};

const TITLE: Record<Mode, string> = {
    record: "record takes -- teleprompter + microphone (F1)",
    tune: "audition and compare takes, tune post chain (F2)",
    time: "retime animation against narration on the full timeline (F3)",
    stage: "choreograph one scene -- pick, name, retime and animate elements (F4)",
};

export class WorkspaceMode {
    readonly events = new Emitter<{ change: [Mode] }>();
    private current: Mode;
    private readonly buttons = new Map<Mode, HTMLButtonElement>();

    constructor() {
        this.current = readStored();
        this.applyClass();
    }

    get mode(): Mode {
        return this.current;
    }

    /** Build the switcher chip group. Caller appends the returned element. */
    buildSwitcher(): HTMLElement {
        const wrap = el("div", {
            class: "mode-switch",
            title: "switch workspace mode (F1 / F2 / F3)",
        });
        MODES.forEach((m, i) => {
            const b = el("button", {
                class: `mode-chip mode-chip-${m}`,
                title: TITLE[m],
                text: `${LABEL[m]}`,
            });
            const key = el("span", { class: "mode-key", text: `F${i + 1}` });
            b.appendChild(key);
            b.onclick = () => this.set(m);
            this.buttons.set(m, b);
            wrap.appendChild(b);
        });
        this.paintButtons();
        return wrap;
    }

    set(mode: Mode): void {
        if (mode === this.current) return;
        this.current = mode;
        writeStored(mode);
        this.applyClass();
        this.paintButtons();
        this.events.emit("change", mode);
    }

    /** Wire the F1/F2/F3 hotkeys. Caller invokes this once at boot. */
    installHotkeys(): void {
        document.addEventListener("keydown", (e) => {
            if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
            const t = e.target as HTMLElement;
            const tag = t?.tagName;
            if (
                tag === "TEXTAREA" ||
                (tag === "INPUT" && (t as HTMLInputElement).type === "text")
            ) return;
            if (e.key === "F1") {
                e.preventDefault();
                this.set("record");
            } else if (e.key === "F2") {
                e.preventDefault();
                this.set("tune");
            } else if (e.key === "F3") {
                e.preventDefault();
                this.set("time");
            } else if (e.key === "F4") {
                e.preventDefault();
                this.set("stage");
            }
        });
    }

    private applyClass(): void {
        const b = document.body;
        MODES.forEach((m) =>
            b.classList.toggle(`mode-${m}`, m === this.current)
        );
    }

    private paintButtons(): void {
        this.buttons.forEach((b, m) =>
            b.classList.toggle("active", m === this.current)
        );
    }
}

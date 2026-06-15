import type { MicMonitor } from "../audio/monitor";
import type { Takes } from "../audio/takes";
import { fmt, type Player } from "../engine/player";
import type { TimedText } from "../types";
import { el } from "./dom";

/* ============================================================================
   RECORD mode bottom workspace.

   Layout (occupies the bottom dock that the timeline normally holds):

     +-------------------------------------------------------------+
     | [arm mic] [waveform] [meter] [clip warn]   [\u25cf rec this line]   |
     +-------------------------------------------------------------+
     | scene N \u00b7 Title                                              |
     |                                                             |
     |   previous line (dim)                                       |
     |                                                             |
     |   CURRENT LINE -- big, centred                              |
     |                                                             |
     |   next line (dim)                                           |
     |   ...                                                       |
     +-------------------------------------------------------------+

   The monitor bar mounts MicMonitor (the same singleton the TUNE/TAKES tab
   uses), so arming the mic in any mode keeps the widgets alive.

   The big "rec this line" button records the line currently under the cursor
   with the existing 3-2-1 count-in; on stop the recording is auto-picked.
============================================================================ */

export class RecordView {
  private readonly root: HTMLElement;
  private readonly player: Player;
  private readonly takes: Takes;
  private readonly micMonitor: MicMonitor;

  private monitorMeterHost!: HTMLElement;
  private armBtn!: HTMLButtonElement;
  private recBtn!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private clipWarn!: HTMLElement;
  private clipPollId: number | null = null;

  private promptHost!: HTMLElement;
  private lineEls: { div: HTMLElement; from: number; to: number; line: TimedText }[] = [];
  private lastCurrentId: string | null = null;

  constructor(root: HTMLElement, player: Player, takes: Takes, micMonitor: MicMonitor) {
    this.root = root;
    this.player = player;
    this.takes = takes;
    this.micMonitor = micMonitor;

    this.build();

    player.events.on("scene", () => this.renderPrompter());
    player.events.on("time", () => this.tick());
    player.events.on("timings", () => this.renderPrompter());

    takes.events.on("monitor", () => this.refreshMonitor());
    takes.events.on("recording", (on) => this.onRecording(on));
    takes.events.on("countdown", (n) => this.onCountdown(n));
    takes.events.on("change", () => this.tick());

    this.renderPrompter();
    this.refreshMonitor();
  }

  /* ------------------------------- build --------------------------------- */

  private build(): void {
    /* monitor bar -- pinned at the top of the dock */
    const monitor = el("div", { class: "rv-monitor" });

    this.armBtn = el("button", {
      class: "rv-arm",
      title: "open/release the microphone for level monitoring",
    }) as HTMLButtonElement;
    this.armBtn.onclick = async () => {
      if (this.takes.monitoring) this.takes.stopMonitor();
      else {
        const err = await this.takes.startMonitor();
        if (err) this.setStatus(err);
      }
    };

    this.monitorMeterHost = el("div", { class: "rv-monitor-host" });

    this.clipWarn = el("div", {
      class: "rv-clip",
      text: "input clipping",
    });

    this.recBtn = el("button", {
      class: "rv-rec",
      text: "\u25cf rec this line",
      title: "record the line under the cursor with a 3-2-1 count-in (r)",
    }) as HTMLButtonElement;
    this.recBtn.onclick = async () => {
      if (this.takes.recording || this.takes.counting) {
        this.takes.stopRecording();
        return;
      }
      const lineId = this.currentLineId();
      const err = await this.takes.startRecordingWithCountIn(lineId ?? undefined);
      if (err) this.setStatus(err);
    };

    this.statusEl = el("span", { class: "rv-status" });

    monitor.append(this.armBtn, this.monitorMeterHost, this.clipWarn, this.statusEl, this.recBtn);

    /* prompter */
    this.promptHost = el("div", { class: "rv-prompter" });

    this.root.classList.add("rv");
    this.root.append(monitor, this.promptHost);
  }

  /* ------------------------------ prompter ------------------------------- */

  private renderPrompter(): void {
    this.promptHost.replaceChildren();
    this.lineEls = [];
    const scene = this.player.scene;
    const idx = this.player.sceneIndex;

    this.promptHost.appendChild(
      el("div", { class: "rv-scenetitle", text: `${idx + 1} \u00b7 ${scene.title}` }),
    );

    const list = el("div", { class: "rv-lines" });
    if (!scene.lines.length) {
      list.appendChild(el("div", { class: "rv-empty", text: "no narration lines in this scene" }));
    }
    scene.lines.forEach((ln) => {
      const div = el(
        "div",
        { class: "rv-line", title: `${fmt(ln.from)}\u2013${fmt(ln.to)} \u00b7 click to seek` },
        ln.text || "(empty line)",
      );
      div.onclick = () => this.player.seek(this.player.offsets[idx] + ln.from + 0.001);
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

  /* highlight + autoscroll the current line, light up the section dot */
  private tick(): void {
    if (!this.lineEls.length) return;
    const local = this.player.localTime;
    const curIdx = this.currentLineIndex();
    for (let i = 0; i < this.lineEls.length; i++) {
      const le = this.lineEls[i];
      const cur = i === curIdx;
      le.div.classList.toggle("current", cur);
      le.div.classList.toggle("done", local >= le.to);
      le.div.classList.toggle("next", i === curIdx + 1);
      le.div.classList.toggle("prev", i === curIdx - 1);
    }
    const cur = curIdx >= 0 ? this.lineEls[curIdx] : null;
    const curId = cur ? cur.line.id ?? `__idx${curIdx}` : null;
    if (cur && curId !== this.lastCurrentId) {
      cur.div.scrollIntoView({ block: "center", behavior: "smooth" });
      this.lastCurrentId = curId;
    } else if (!cur) {
      this.lastCurrentId = null;
    }
    /* keep the rec button label in sync with whether the cursor is on a line */
    if (!this.takes.recording && !this.takes.counting) {
      this.recBtn.textContent = cur ? "\u25cf rec this line" : "\u25cf rec";
      this.recBtn.disabled = false;
    }
  }

  /* ----------------------------- monitor --------------------------------- */

  private refreshMonitor(): void {
    const armed = this.takes.monitoring;
    this.armBtn.textContent = armed ? "disarm mic" : "arm mic";
    this.armBtn.classList.toggle("live", armed);
    if (armed && this.micMonitor.active) {
      this.micMonitor.attach(this.monitorMeterHost);
      this.startClipPoll();
    } else {
      this.monitorMeterHost.replaceChildren();
      this.stopClipPoll();
      this.clipWarn.classList.remove("visible");
    }
  }

  private startClipPoll(): void {
    this.stopClipPoll();
    const led = this.micMonitor.meterClipEl;
    if (!led) return;
    this.clipPollId = window.setInterval(() => {
      this.clipWarn.classList.toggle("visible", led.classList.contains("clipped"));
    }, 120);
  }

  private stopClipPoll(): void {
    if (this.clipPollId !== null) {
      clearInterval(this.clipPollId);
      this.clipPollId = null;
    }
  }

  /* --------------------------- record state ------------------------------ */

  private onRecording(on: boolean): void {
    this.recBtn.classList.toggle("live", on);
    this.recBtn.textContent = on ? "\u25a0 stop" : "\u25cf rec this line";
    this.root.classList.toggle("recording", on);
    if (!on) this.tick();
  }

  private onCountdown(n: number | null): void {
    if (n === null) {
      this.recBtn.classList.remove("counting");
      this.tick();
    } else if (n === 0) {
      this.recBtn.classList.remove("counting");
    } else {
      this.recBtn.classList.add("counting");
      this.recBtn.textContent = `${n}\u2026`;
    }
  }

  private setStatus(text: string): void {
    this.statusEl.textContent = text;
    window.setTimeout(() => {
      if (this.statusEl.textContent === text) this.statusEl.textContent = "";
    }, 3500);
  }
}

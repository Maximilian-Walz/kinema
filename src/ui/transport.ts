import { fetchProjects, getProject } from "../api";
import type { Takes } from "../audio/takes";
import { fmt, fmtMs, type Player } from "../engine/player";
import type { TimingSync } from "../timings";
import { el } from "./dom";
import type { ExportDialog } from "./export-dialog";
import { openProject } from "./picker";
import type { Mode, WorkspaceMode } from "./workspace-mode";

/* Per-mode key cheatsheet shown on the right of the transport bar. Common
   keys (mode switch, play/pause, clean, project nav) are listed for every
   mode so the operator never has to remember a different alphabet per mode;
   the mode-specific keys lead each line. */
const MODE_KEY_HINT: Record<Mode, string> = {
  record: "r rec this line \u00b7 ESC stop \u00b7 SPACE play \u00b7 \u2190/\u2192 \u00b15s \u00b7 F2 tune \u00b7 F3 time",
  tune: "\u25b6 audition \u00b7 drag waveform to scrub \u00b7 SPACE play \u00b7 F1 record \u00b7 F3 time",
  time: "SPACE play \u00b7 drag clips \u00b7 I/O loop \u00b7 [ ] scene \u00b7 1-9 jump \u00b7 F1 record \u00b7 F2 tune \u00b7 C clean",
};

/* play/pause, scene navigation, timecode, record shortcut, clean mode */
export class Transport {
  private readonly player: Player;
  private playBtn!: HTMLButtonElement;
  private recBtn!: HTMLButtonElement;
  private timeEl!: HTMLElement;
  private sceneEl!: HTMLElement;
  private savedEl!: HTMLElement;

  constructor(
    root: HTMLElement,
    player: Player,
    takes: Takes,
    sync: TimingSync,
    mode: WorkspaceMode,
    exportDialog: ExportDialog,
  ) {
    this.player = player;

    this.playBtn = el("button", { class: "t-play", text: "▶ play" });
    this.playBtn.onclick = () => player.toggle();
    const restart = el("button", {
      text: "⟲ scene",
      title: "restart scene (Shift+R)",
    });
    restart.onclick = () => player.restartScene();
    const prev = el("button", { text: "⟨", title: "previous scene ([)" });
    prev.onclick = () => player.seekScene(player.sceneIndex - 1);
    const next = el("button", { text: "⟩", title: "next scene (])" });
    next.onclick = () => player.seekScene(player.sceneIndex + 1);

    this.sceneEl = el("span", { class: "t-scene" });
    this.timeEl = el("span", { class: "t-time" });
    this.savedEl = el("span", { class: "t-saved" });

    this.recBtn = el("button", {
      class: "t-rec",
      text: "● rec",
      title: "record with 3-2-1 count-in (r)",
    });
    this.recBtn.onclick = async () => {
      if (takes.recording || takes.counting) takes.stopRecording();
      else await takes.startRecordingWithCountIn();
    };

    const clean = el("button", {
      text: "◻ clean (C)",
      title: "stage only — for screen capture",
    });
    clean.onclick = () => document.body.classList.toggle("clean");

    const exportBtn = el("button", {
      class: "t-export",
      text: "⤓ export",
      title: "render the project to MP4",
    });
    exportBtn.onclick = () => exportDialog.open();
    const exportBadge = exportDialog.attachTransportBadge();

    const picker = el("select", {
      class: "t-project",
      title: "switch project",
    }) as HTMLSelectElement;
    this.fillPicker(picker);

    const modeSwitch = mode.buildSwitcher();
    const keysEl = el("span", { class: "t-keys" });
    const paintKeys = (): void => { keysEl.textContent = MODE_KEY_HINT[mode.mode]; };
    paintKeys();
    mode.events.on("change", paintKeys);

    root.append(
      this.playBtn,
      restart,
      prev,
      next,
      this.sceneEl,
      this.timeEl,
      this.savedEl,
      el("span", { class: "t-spacer" }),
      modeSwitch,
      picker,
      this.recBtn,
      exportBtn,
      exportBadge,
      clean,
      keysEl,
    );

    player.events.on("time", () => this.tick());
    player.events.on("play", (p) => {
      this.playBtn.textContent = p ? "❚❚ pause" : "▶ play";
    });
    takes.events.on("recording", (on) => {
      this.recBtn.classList.toggle("live", on);
      this.recBtn.classList.remove("counting");
      this.recBtn.textContent = on ? "■ stop" : "● rec";
    });
    takes.events.on("countdown", (n) => {
      if (n === null) {
        /* cancelled */
        this.recBtn.classList.remove("counting");
        this.recBtn.textContent = "● rec";
      } else if (n === 0) {
        /* handed off to recording -- recording event will fire shortly */
        this.recBtn.classList.remove("counting");
      } else {
        this.recBtn.classList.add("counting");
        this.recBtn.textContent = `${n}…`;
      }
    });
    sync.events.on("saved", () => this.flashSaved("✓ saved"));
    sync.events.on("error", () => this.flashSaved("✗ save failed", true));
    this.tick();
  }

  /* populate the project switcher async; changing it reloads on that project */
  private async fillPicker(sel: HTMLSelectElement): Promise<void> {
    const projects = await fetchProjects().catch(() => []);
    const current = getProject();
    for (const proj of projects) {
      const opt = el("option", {
        value: proj.id,
        text: proj.name,
      }) as HTMLOptionElement;
      if (proj.id === current || (!current && proj.default)) {
        opt.selected = true;
      }
      sel.append(opt);
    }
    sel.onchange = () => openProject(sel.value);
  }

  private savedTimer: number | undefined;
  private flashSaved(text: string, error = false): void {
    this.savedEl.textContent = text;
    this.savedEl.classList.toggle("error", error);
    clearTimeout(this.savedTimer);
    this.savedTimer = window.setTimeout(() => {
      this.savedEl.textContent = "";
    }, 1500);
  }

  private tick(): void {
    const P = this.player;
    const { index, local } = P.cursor();
    const scene = P.project.scenes[index];
    this.sceneEl.textContent = `${
      index + 1
    }/${P.project.scenes.length} ${scene.title}`;
    this.timeEl.textContent = `${fmtMs(local)} / ${fmt(scene.len)}  ·  video ${
      fmt(P.time)
    } / ${fmt(P.total)}`;
  }
}

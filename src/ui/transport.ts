import { fetchProjects, getProject } from "../api";
import type { Takes } from "../audio/takes";
import { fmt, fmtMs, type Player } from "../engine/player";
import type { TimingSync } from "../timings";
import { el } from "./dom";
import type { ExportDialog } from "./export-dialog";
import { openProject } from "./picker";
import type { WorkspaceMode } from "./workspace-mode";

/** Add a small key indicator chip to a button (e.g. "SPACE" on Play).
    Inserted at the end of the button so the label leads and the key follows. */
function addKbd(btn: HTMLElement, key: string): void {
  btn.appendChild(el("span", { class: "t-kbd", text: key }));
}

/* Single transport row. Ordering follows the operator's flow left-to-right:
     CONTEXT   project picker, mode switcher
     TRANSPORT play, restart, [\u27e8 scene-title + time \u27e9]    \u2190 fixed-width nav cluster
     [spacer]  saved indicator
     ACTIONS   export, clean

   The nav cluster has a fixed flex-basis so the chevrons live at the same
   horizontal position regardless of the current scene's title length \u2014 the
   user can muscle-memory click \u27e8 / \u27e9 to step scenes. Recording lives only
   in record mode (and on the global `R` shortcut), so there is no rec button
   on the transport bar. */
export class Transport {
  private readonly player: Player;
  private playBtn!: HTMLButtonElement;
  private timeEl!: HTMLElement;
  private sceneEl!: HTMLElement;
  private savedEl!: HTMLElement;
  /** Cached play/pause glyph node so we can swap it without destroying the
      key-chip child appended via addKbd(). */
  private playLabel!: Text;

  constructor(
    root: HTMLElement,
    player: Player,
    _takes: Takes,
    sync: TimingSync,
    mode: WorkspaceMode,
    exportDialog: ExportDialog,
  ) {
    this.player = player;

    this.playBtn = el("button", {
      class: "t-play",
      title: "play / pause",
    }) as HTMLButtonElement;
    /* the glyph lives in a fixed-width centred icon span so the \u25b6/\u275a\u275a swap never
       resizes the button or shifts the keybind chip */
    this.playLabel = document.createTextNode("\u25b6");
    const playIcon = el("span", { class: "t-btn-icon" });
    playIcon.appendChild(this.playLabel);
    this.playBtn.appendChild(playIcon);
    addKbd(this.playBtn, "SPACE");
    this.playBtn.onclick = () => player.toggle();

    const restart = el("button", { class: "t-restart", title: "restart scene" });
    restart.appendChild(el("span", { class: "t-btn-icon", text: "\u27f2" }));
    addKbd(restart, "\u21e7R");
    restart.onclick = () => player.restartScene();

    const prev = el("button", {
      class: "t-nav-arrow",
      title: "previous scene (Ctrl+\u2190, or [)",
    });
    prev.appendChild(document.createTextNode("\u27e8"));
    addKbd(prev, "Ctrl \u2190");
    prev.onclick = () => player.seekScene(player.sceneIndex - 1);

    const next = el("button", {
      class: "t-nav-arrow",
      title: "next scene (Ctrl+\u2192, or ])",
    });
    /* Mirror the prev button: kbd chip first, chevron last, so the chevron
       points outward (away from the title) on both sides. addKbd appends,
       so we add it before the chevron text node. */
    addKbd(next, "Ctrl \u2192");
    next.appendChild(document.createTextNode("\u27e9"));
    next.onclick = () => player.seekScene(player.sceneIndex + 1);

    /* The scene title + timecode share one centred column inside the nav
       cluster. The cluster itself has a fixed flex-basis (see styles.css)
       so this column expands/contracts but the surrounding chevrons stay
       put across scenes. */
    this.sceneEl = el("span", { class: "t-scene" });
    this.timeEl = el("span", { class: "t-time" });
    const sceneCol = el(
      "div",
      { class: "t-scene-col" },
      this.sceneEl,
      this.timeEl,
    );
    const nav = el(
      "div",
      { class: "t-nav" },
      prev,
      sceneCol,
      next,
    );

    this.savedEl = el("span", { class: "t-saved" });

    const clean = el("button", {
      title: "clean stage \u2014 for screen capture",
    });
    clean.appendChild(document.createTextNode("\u25fb"));
    addKbd(clean, "C");
    clean.onclick = () => document.body.classList.toggle("clean");

    const exportBtn = el("button", {
      class: "t-export",
      text: "\u2913 export",
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

    root.append(
      picker,
      modeSwitch,
      el("span", { class: "t-sep" }),
      this.playBtn,
      restart,
      nav,
      this.savedEl,
      el("span", { class: "t-spacer" }),
      exportBtn,
      exportBadge,
      clean,
    );

    player.events.on("time", () => this.tick());
    player.events.on("play", (p) => {
      this.playLabel.data = p ? "\u275a\u275a" : "\u25b6";
    });
    sync.events.on("saved", () => this.flashSaved("\u2713 saved"));
    sync.events.on("error", () => this.flashSaved("\u2717 save failed", true));
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
    this.sceneEl.textContent = `Scene ${
      index + 1
    } of ${P.project.scenes.length} \u00b7 ${scene.title}`;
    this.timeEl.textContent = `${fmtMs(local)} / ${
      fmt(scene.len)
    }   \u00b7   total ${fmt(P.time)} / ${fmt(P.total)}`;
  }
}

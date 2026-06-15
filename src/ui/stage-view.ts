import * as api from "../api";
import { fmt, type Player } from "../engine/player";
import type { History } from "../history";
import type { TimingSync } from "../timings";
import type { ScheduleEntry, SceneData } from "../types";
import { el } from "./dom";

/* ============================================================================
   STAGE mode bottom workspace — choreograph ONE scene.

   Unlike TIME (a global timeline across every scene), STAGE is scene-scoped:
   the live preview above stays on the current scene and this dock edits that
   scene's element schedule directly, so the less the user touches raw files the
   better. Layout:

     +--------------------------------------------------+------------------+
     |  toolbar: scene title · + pick element · hint    |                  |
     +--------------------------------------------------+   INSPECTOR      |
     |  ruler (scene-local 0..len, click = seek)        |  selected element|
     |  ------------------------------------------------ |  - name + text   |
     |  [ title ][ sub ]   [ card======]   | <- lanes   |  - enter / exit  |
     |              [ note ]                |  playhead  |  - animation     |
     +--------------------------------------------------+------------------+

   Features:
   - pick an element straight off the live stage to schedule it (T16)
   - readable auto-labels from each element's text/data-label + a tag chip (T15)
   - drag to move / resize, or type exact enter/exit in the inspector (T14)
   - choose an entrance animation preset (writes ScheduleEntry.fx) (T17)
   - edit the element's on-screen text, patched straight into scene.html (T18)

   Schedule edits are undoable (history) and saved back to scene.json via sync,
   exactly like the TIME timeline. Text edits go to scene.html and are not part
   of the undo stack.
============================================================================ */

const FINE = 0.01;
const round = (v: number, step = FINE): number => Math.round(v / step) * step;

/* entrance-animation presets; the value is the `fx` suffix, paired with the
   `.fx-<value>` / `.fx-<value>.on` rules in the project theme.css */
const FX_PRESETS: Array<[string, string]> = [
  ["", "none (just toggle)"],
  ["fade", "fade in"],
  ["up", "rise + fade"],
  ["down", "drop + fade"],
  ["left", "slide from left"],
  ["right", "slide from right"],
  ["pop", "pop / scale in"],
];

interface Clip {
  entry: ScheduleEntry;
  div: HTMLElement;
  place: () => void;
  isCurrent: (local: number) => boolean;
  edges: () => number[];
}

export class StageView {
  private readonly player: Player;
  private readonly sync: TimingSync;
  private readonly history: History;

  private readonly root: HTMLElement;
  private titleEl!: HTMLElement;
  private scroll!: HTMLElement;
  private lanes!: HTMLElement;
  private ruler!: HTMLElement;
  private playhead!: HTMLElement;
  private snapGuide!: HTMLElement;
  private inspector!: HTMLElement;

  private pps = 40;
  private clips: Clip[] = [];
  private selected: ScheduleEntry | null = null;
  private dragging = false;
  private picking = false;

  constructor(
    root: HTMLElement,
    player: Player,
    sync: TimingSync,
    history: History,
  ) {
    this.root = root;
    this.player = player;
    this.sync = sync;
    this.history = history;
    this.build();

    player.events.on("scene", () => {
      if (!this.dragging) this.rebuild();
    });
    player.events.on("timings", () => {
      if (!this.dragging) this.rebuild();
    });
    player.events.on("time", () => this.onTime());

    /* refit once the dock actually has a width (it is display:none until the
       user first switches to STAGE, so the initial measure is zero) */
    const ro = new ResizeObserver(() => {
      if (this.scroll.clientWidth > 0 && !this.dragging) this.rebuild();
    });
    ro.observe(this.scroll);
  }

  /** Called by main.ts on every mode switch. Entering STAGE refits the lanes to
      the now-visible dock width; leaving it cancels any in-progress stage pick. */
  onModeChange(active: boolean): void {
    if (active) this.rebuild();
    else this.stopPicking();
  }

  /* ------------------------------- shell -------------------------------- */

  private build(): void {
    this.root.classList.add("sv");

    this.titleEl = el("span", { class: "sv-title" });
    const pick = el("button", {
      class: "sv-pick",
      text: "✛ pick element",
      title: "click an element on the stage above to schedule it",
    });
    pick.onclick = () => this.togglePicking();
    const byId = el("button", {
      class: "sv-byid",
      text: "+ by id",
      title: "schedule an element by typing its id",
    });
    byId.onclick = () => this.addById();

    const toolbar = el(
      "div",
      { class: "sv-toolbar" },
      this.titleEl,
      el("span", { class: "tl-sep" }),
      pick,
      byId,
      el("span", {
        class: "sv-hint",
        text:
          "pick or click an element to edit it · drag = move · drag edges = retime · del = remove",
      }),
    );

    this.ruler = el("div", { class: "sv-ruler" });
    this.lanes = el("div", { class: "sv-lanes" });
    this.playhead = el("div", { class: "sv-playhead" });
    this.snapGuide = el("div", { class: "sv-snapguide" });
    this.scroll = el(
      "div",
      { class: "sv-scroll" },
      this.ruler,
      this.lanes,
      this.snapGuide,
      this.playhead,
    );

    this.inspector = el("div", { class: "sv-inspector" });

    const main = el("div", { class: "sv-main" }, this.scroll, this.inspector);
    this.root.append(toolbar, main);

    /* click empty space on the ruler/lanes = seek (scene-local) + deselect */
    const seekFromEvent = (e: PointerEvent): void => {
      const rect = this.scroll.getBoundingClientRect();
      const local = Math.max(
        0,
        Math.min(this.player.scene.len, (e.clientX - rect.left) / this.pps),
      );
      this.player.seek(this.player.offsets[this.player.sceneIndex] + local);
    };
    this.ruler.onpointerdown = (e) => seekFromEvent(e);
    this.lanes.onpointerdown = (e) => {
      if ((e.target as HTMLElement).closest(".tl-clip, .tl-handle")) return;
      this.select(null);
      seekFromEvent(e);
    };
  }

  /* ------------------------------ rebuild ------------------------------- */

  private rebuild(): void {
    const scene = this.player.scene;
    const si = this.player.sceneIndex;
    this.titleEl.textContent = `${si + 1} · ${scene.title}`;

    const width = this.scroll.clientWidth || 600;
    this.pps = Math.max(6, (width - 24) / Math.max(1, scene.len));

    this.clips = [];
    this.lanes.innerHTML = "";
    this.buildRuler(scene);

    /* lane packing: greedily place each entry on the first lane whose last clip
       has ended (markers get a label-width box) */
    const laneEnds: number[] = [];
    for (const entry of scene.schedule) {
      this.addClip(scene, entry, laneEnds);
    }
    this.lanes.style.height = Math.max(1, laneEnds.length) * 24 + 8 + "px";

    this.onTime();
    this.renderInspector();
  }

  private buildRuler(scene: SceneData): void {
    this.ruler.innerHTML = "";
    const steps = [0.5, 1, 2, 5, 10, 15, 30];
    const major = steps.find((s) => s * this.pps >= 56) ?? 30;
    for (let t = 0; t <= scene.len + 1e-6; t += major) {
      const tick = el("div", { class: "sv-tick", text: fmt(t) });
      tick.style.left = t * this.pps + "px";
      this.ruler.appendChild(tick);
    }
  }

  private addClip(
    scene: SceneData,
    entry: ScheduleEntry,
    laneEnds: number[],
  ): void {
    const isSpan = entry.exit !== undefined;
    const info = this.player.elementInfo(entry.id);
    const startPx = entry.enter * this.pps;
    const widthPx = isSpan
      ? Math.max(12, (entry.exit! - entry.enter) * this.pps)
      : Math.max(40, info.label.length * 6.4 + 30);

    let lane = laneEnds.findIndex((end) => end <= startPx + 0.5);
    if (lane < 0) {
      lane = laneEnds.length;
      laneEnds.push(0);
    }
    laneEnds[lane] = startPx + widthPx + 6;

    const clip = el("div", {
      class: "tl-clip tl-element" + (isSpan ? "" : " tl-marker") +
        (info.exists ? "" : " sv-missing"),
      title: `#${entry.id}` + (info.exists ? "" : " — no element in scene.html"),
    });
    const tag = el("span", {
      class: "sv-tag",
      text: info.exists ? (info.tag || "?") : "missing",
    });
    const label = el("span", { class: "tl-cliptext", text: info.label });
    clip.append(tag, label);

    const hl = isSpan ? el("div", { class: "tl-handle tl-handle-l" }) : null;
    const hr = el("div", { class: "tl-handle tl-handle-r" });
    if (hl) clip.appendChild(hl);
    clip.appendChild(hr);

    const laneTop = lane * 24 + 4;
    const place = (): void => {
      clip.style.left = entry.enter * this.pps + "px";
      clip.style.top = laneTop + "px";
      if (entry.exit !== undefined) {
        clip.style.width = Math.max(12, (entry.exit - entry.enter) * this.pps) +
          "px";
      } else {
        clip.style.width = widthPx + "px";
      }
    };

    const clipRec: Clip = {
      entry,
      div: clip,
      place,
      isCurrent: (local) =>
        local >= entry.enter && (entry.exit === undefined || local < entry.exit),
      edges: () =>
        entry.exit === undefined
          ? [entry.enter]
          : [entry.enter, entry.exit],
    };
    this.clips.push(clipRec);

    clip.onpointerdown = (e) => {
      e.stopPropagation();
      this.select(entry);
      const target = e.target as HTMLElement;
      if (target === hl) {
        const orig = entry.enter;
        this.beginDrag(e, entry, [entry.enter], (delta) => {
          entry.enter = Math.min(
            (entry.exit ?? scene.len) - 0.1,
            Math.max(0, round(orig + delta)),
          );
        });
      } else if (target === hr) {
        /* dragging a marker's right edge gives it an exit (turns it into a span) */
        const orig = entry.exit ?? entry.enter;
        this.beginDrag(e, entry, [orig], (delta) => {
          entry.exit = Math.max(
            entry.enter + 0.1,
            Math.min(scene.len, round(orig + delta)),
          );
        });
      } else {
        const oEnter = entry.enter, oExit = entry.exit;
        this.beginDrag(e, entry, clipRec.edges(), (delta) => {
          const d = Math.max(-oEnter, delta);
          entry.enter = round(oEnter + d);
          if (oExit !== undefined) {
            entry.exit = Math.min(scene.len, round(oExit + d));
          }
        });
      }
    };

    this.lanes.appendChild(clip);
    place();
  }

  /* ------------------------------- drag --------------------------------- */

  /** one editing drag = one undoable transaction, snapped while it runs */
  private beginDrag(
    e: PointerEvent,
    entry: ScheduleEntry,
    edges: number[],
    apply: (delta: number) => void,
  ): void {
    const scene = this.player.scene;
    this.dragging = true;
    const startX = e.clientX;
    const before = this.history.snapshot(scene);
    const targets = this.snapTargets(entry);

    const target = e.target as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent): void => {
      const raw = (ev.clientX - startX) / this.pps;
      apply(this.snapDelta(raw, edges, targets, ev.shiftKey));
      this.sync.changed(scene);
      for (const c of this.clips) c.place();
    };
    const up = (): void => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      this.dragging = false;
      this.snapGuide.style.display = "none";
      this.history.commit(scene, before);
      this.rebuild();
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  }

  /** snap candidates: scene bounds, playhead, every other entry's edges */
  private snapTargets(exclude: ScheduleEntry): number[] {
    const scene = this.player.scene;
    const targets = [0, scene.len, this.player.localTime];
    for (const ev of scene.schedule) {
      if (ev === exclude) continue;
      targets.push(ev.enter);
      if (ev.exit !== undefined) targets.push(ev.exit);
    }
    return targets;
  }

  private snapDelta(
    raw: number,
    edges: number[],
    targets: number[],
    free: boolean,
  ): number {
    if (free) {
      this.snapGuide.style.display = "none";
      return round(raw);
    }
    const thresh = 8 / this.pps;
    let best: { delta: number; target: number; dist: number } | null = null;
    for (const edge of edges) {
      for (const t of targets) {
        const delta = t - edge;
        const dist = Math.abs(raw - delta);
        if (dist < thresh && (!best || dist < best.dist)) {
          best = { delta, target: t, dist };
        }
      }
    }
    if (best) {
      this.snapGuide.style.left = best.target * this.pps + "px";
      this.snapGuide.style.display = "block";
      return best.delta;
    }
    this.snapGuide.style.display = "none";
    return round(raw);
  }

  /* ----------------------------- selection ------------------------------ */

  private select(entry: ScheduleEntry | null): void {
    this.selected = entry;
    for (const c of this.clips) {
      c.div.classList.toggle("selected", c.entry === entry);
    }
    this.renderInspector();
  }

  deleteSelection(): void {
    const scene = this.player.scene;
    const at = this.selected ? scene.schedule.indexOf(this.selected) : -1;
    if (at < 0) return;
    const before = this.history.snapshot(scene);
    scene.schedule.splice(at, 1);
    this.history.commit(scene, before);
    this.sync.changed(scene);
    this.selected = null;
    this.rebuild();
  }

  /* ------------------------------ add clips ----------------------------- */

  private addEntry(id: string, cls?: string): void {
    const scene = this.player.scene;
    const before = this.history.snapshot(scene);
    const entry: ScheduleEntry = {
      id,
      enter: round(Math.max(0, Math.min(scene.len - 0.1, this.player.localTime))),
    };
    if (cls && cls !== "on") entry.cls = cls;
    scene.schedule.push(entry);
    this.history.commit(scene, before);
    this.sync.changed(scene);
    this.selected = entry;
    this.rebuild();
  }

  private addById(): void {
    const raw = window.prompt(
      'element id to schedule (e.g. "title", or "card.hl" for a class other than "on"):',
    );
    if (!raw) return;
    const m = /^([\w.-]+)(?:\.([\w-]+))?$/.exec(raw.trim());
    if (!m) return;
    this.addEntry(m[1], m[2]);
  }

  /* ------------------------- pick-from-stage (T16) ---------------------- */

  private togglePicking(): void {
    this.picking ? this.stopPicking() : this.startPicking();
  }

  private startPicking(): void {
    const content = document.getElementById("scenecontent");
    if (!content) return;
    this.picking = true;
    document.body.classList.add("sv-picking");
    this.root.querySelector(".sv-pick")?.classList.add("active");
    content.addEventListener("click", this.onPickClick, true);
    document.addEventListener("keydown", this.onPickKey, true);
  }

  private stopPicking(): void {
    this.picking = false;
    document.body.classList.remove("sv-picking");
    this.root.querySelector(".sv-pick")?.classList.remove("active");
    const content = document.getElementById("scenecontent");
    content?.removeEventListener("click", this.onPickClick, true);
    document.removeEventListener("keydown", this.onPickKey, true);
  }

  private onPickKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.stopPicking();
    }
  };

  private onPickClick = (e: MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    const node = (e.target as HTMLElement)?.closest<HTMLElement>("[id]");
    this.stopPicking();
    if (!node) return;
    const id = node.id;
    if (!/^[\w.-]+$/.test(id)) {
      window.alert(`"${id}" is not a usable id (needs to match [\\w.-]+).`);
      return;
    }
    this.addEntry(id);
  };

  /* ---------------------------- inspector (T14) ------------------------- */

  private renderInspector(): void {
    this.inspector.innerHTML = "";
    const scene = this.player.scene;
    const entry = this.selected;

    if (!entry || scene.schedule.indexOf(entry) < 0) {
      this.inspector.appendChild(
        el("div", {
          class: "sv-insp-empty",
          text: "select an element below, or pick one off the stage",
        }),
      );
      return;
    }

    const info = this.player.elementInfo(entry.id);

    /* header: tag chip + readable name + raw id */
    const head = el(
      "div",
      { class: "sv-insp-head" },
      el("span", {
        class: "sv-tag" + (info.exists ? "" : " sv-tag-missing"),
        text: info.exists ? (info.tag || "?") : "missing",
      }),
      el("span", { class: "sv-insp-name", text: info.label }),
    );
    this.inspector.append(
      head,
      el("div", { class: "sv-insp-id", text: "#" + entry.id }),
    );

    if (!info.exists) {
      this.inspector.appendChild(
        el("div", {
          class: "sv-insp-warn",
          text: "no element with this id in scene.html — it won't show.",
        }),
      );
    }

    /* element text (leaf elements only) ---------------------------------- */
    if (info.exists && info.leaf) {
      this.inspector.appendChild(this.field("text", this.textRow(scene, entry)));
    } else if (info.exists) {
      this.inspector.appendChild(
        el("div", {
          class: "sv-insp-note",
          text: "text: edit in scene.html (this element has child markup)",
        }),
      );
    }

    /* enter / exit ------------------------------------------------------- */
    const enterInput = this.numberInput(entry.enter, 0, scene.len, (v) => {
      this.commit(scene, () => {
        entry.enter = Math.max(
          0,
          Math.min(entry.exit !== undefined ? entry.exit - 0.1 : scene.len, v),
        );
      });
    });
    this.inspector.appendChild(this.field("enter (s)", enterInput));

    const exitRow = el("div", { class: "sv-insp-inline" });
    if (entry.exit !== undefined) {
      const exitInput = this.numberInput(entry.exit, 0, scene.len, (v) => {
        this.commit(scene, () => {
          entry.exit = Math.max(entry.enter + 0.1, Math.min(scene.len, v));
        });
      });
      const rm = el("button", {
        class: "sv-mini",
        text: "remove",
        title: "remove the exit — the element stays on once it enters",
      });
      rm.onclick = () => this.commit(scene, () => delete entry.exit);
      exitRow.append(exitInput, rm);
      this.inspector.appendChild(this.field("exit (s)", exitRow));
    } else {
      const add = el("button", {
        class: "sv-mini",
        text: "+ add exit",
        title: "give the element an exit time (a window instead of staying on)",
      });
      add.onclick = () =>
        this.commit(scene, () => {
          entry.exit = round(Math.min(scene.len, entry.enter + 2));
        });
      this.inspector.appendChild(this.field("exit", add));
    }

    /* animation preset (T17) -------------------------------------------- */
    const fxSel = el("select", { class: "sv-select" }) as HTMLSelectElement;
    for (const [val, label] of FX_PRESETS) {
      const opt = el("option", { value: val, text: label }) as HTMLOptionElement;
      if ((entry.fx ?? "") === val) opt.selected = true;
      fxSel.appendChild(opt);
    }
    fxSel.onchange = () =>
      this.commit(scene, () => {
        if (fxSel.value) entry.fx = fxSel.value;
        else delete entry.fx;
      });
    this.stopKeys(fxSel);
    this.inspector.appendChild(this.field("animation", fxSel));

    /* toggle class (advanced) ------------------------------------------- */
    const clsInput = el("input", {
      type: "text",
      class: "sv-input",
      value: entry.cls ?? "on",
      title:
        "CSS class the engine toggles on this element (default 'on'). Animation presets pair with 'on'.",
    }) as HTMLInputElement;
    const commitCls = (): void =>
      this.commit(scene, () => {
        const v = clsInput.value.trim();
        if (v && v !== "on") entry.cls = v;
        else delete entry.cls;
      });
    clsInput.onchange = commitCls;
    this.stopKeys(clsInput);
    this.inspector.appendChild(this.field("toggle class", clsInput));

    /* delete ------------------------------------------------------------- */
    const del = el("button", {
      class: "sv-del",
      text: "✕ remove from schedule",
      title: "remove this element from the scene's schedule (del)",
    });
    del.onclick = () => this.deleteSelection();
    this.inspector.appendChild(del);
  }

  /** the editable text row for a leaf element; writes scene.html on commit */
  private textRow(scene: SceneData, entry: ScheduleEntry): HTMLElement {
    const wrap = el("div", { class: "sv-insp-inline" });
    const input = el("input", {
      type: "text",
      class: "sv-input",
      value: this.player.elementText(entry.id),
      title: "the element's on-screen text — saved into scene.html",
    }) as HTMLInputElement;
    const status = el("span", { class: "sv-insp-status" });
    this.stopKeys(input);
    const commitText = (): void => {
      const text = input.value;
      if (text === this.player.elementText(entry.id)) return;
      status.textContent = "saving…";
      api.setElementText(scene.id, entry.id, text)
        .then((html) => {
          this.player.replaceSceneHtml(scene, html);
          status.textContent = "✓";
          this.rebuild();
        })
        .catch((err) => {
          status.textContent = "✕";
          input.title = String(err);
        });
    };
    input.onchange = commitText;
    wrap.append(input, status);
    return wrap;
  }

  /* ------------------------------ helpers ------------------------------- */

  private field(label: string, control: HTMLElement): HTMLElement {
    return el(
      "label",
      { class: "sv-field" },
      el("span", { class: "sv-field-label", text: label }),
      control,
    );
  }

  private numberInput(
    value: number,
    min: number,
    max: number,
    onCommit: (v: number) => void,
  ): HTMLInputElement {
    const input = el("input", {
      type: "number",
      class: "sv-input sv-num",
      step: "0.1",
      min: String(min),
      max: String(max),
      value: value.toFixed(2),
    }) as HTMLInputElement;
    input.onchange = () => {
      const v = Number(input.value);
      if (Number.isFinite(v)) onCommit(round(v));
    };
    this.stopKeys(input);
    return input;
  }

  /** keep the inspector's inputs from triggering the app's global hotkeys
      (space = play, del = delete clip, etc.) while the user types */
  private stopKeys(input: HTMLElement): void {
    input.addEventListener("keydown", (e) => e.stopPropagation());
  }

  private commit(scene: SceneData, mutate: () => void): void {
    const before = this.history.snapshot(scene);
    mutate();
    this.history.commit(scene, before);
    this.sync.changed(scene);
    this.rebuild();
  }

  /* ------------------------------ per tick ------------------------------ */

  private onTime(): void {
    const local = this.player.localTime;
    this.playhead.style.left = local * this.pps + "px";
    for (const c of this.clips) {
      c.div.classList.toggle("current", c.isCurrent(local));
    }
  }
}

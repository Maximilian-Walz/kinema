import * as api from "../api";
import { fmt, type Player } from "../engine/player";
import type { History } from "../history";
import type { TimingSync } from "../timings";
import type { ScheduleEntry, SceneData } from "../types";
import { el } from "./dom";

/* ============================================================================
   SCENE mode — compose ONE scene. (Internal id stays "stage".)

   Scene-scoped, unlike TIME's global clock. The bottom dock is a full-width
   scene-local timeline; the element INSPECTOR lives in the tall side panel
   (mounted there via mountInspector, rendered by SidePanel's "stage" case):

     preview (top)                          side panel
       click  = select                        ▾ ELEMENT  (tag · name · #id)
       2click = edit text in place            ▾ TEXT     (one field per run)
       drag   = move (translate override)     ▾ LOOK     (size / colour / pos)
       corner = resize font                   ▾ TIMING   (enter/exit/fx/class)
     ┌───────────────────────────────────────────────────────────────┐
     │ ruler · SCRIPT lane (narration, read-only) · ELEMENT lanes     │
     └───────────────────────────────────────────────────────────────┘

   Selection is bidirectional (preview element <-> clip). Editing, no files:
   - text, incl. runs nested inside animated divs -> scene.html             (T20)
   - type scale + colour -> generated #id{} rule in scene.css               (T21)
   - position (drag) / font size (corner handle) -> scene.css override       (T22)
   - scene-local enter/exit timing + entrance animation preset + toggle class

   Schedule edits are undoable (history) + saved to scene.json. Text edits write
   scene.html; style/position edits write scene.css.
============================================================================ */

const FINE = 0.01;
const round = (v: number, step = FINE): number => Math.round(v / step) * step;

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

/** what the inspector is editing: an element id, plus the specific schedule
    entry if one was selected (an id can be unscheduled, or have many entries) */
interface Selection {
  id: string;
  entry: ScheduleEntry | null;
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
  private script!: HTMLElement;
  /* the inspector renders into the side panel (set by SidePanel via
     mountInspector); null until SCENE mode first shows it */
  private inspectorHost: HTMLElement | null = null;

  private pps = 40;
  private clips: Clip[] = [];
  /* `sel` is the inspector target (the primary, single element being edited).
     `selected` is the multi-selection set used for marquee / ctrl+click and
     moving or deleting several clips at once. A plain single click keeps the two
     in sync; selecting many leaves `sel` null and shows a multi summary. The set
     holds the schedule-entry objects, which are stable across rebuilds. */
  private sel: Selection | null = null;
  private selected = new Set<ScheduleEntry>();
  private dragging = false;
  private active = false;

  /* SCENE playback: loop the current scene vs play through to the next. When on
     and SCENE is active, the player loop is pinned to the current scene's bounds
     so playback wraps at its end; persisted per the UI. */
  private loopScene = false;
  private loopBtn!: HTMLButtonElement;
  private static readonly LOOP_KEY = "sv.loopScene";

  /* highlight overlay boxes drawn in #stagearea chrome (not on the element
     itself, so they show even when the element is opacity:0 before its entrance
     and aren't clipped by scene overflow). One for the selection, one for hover. */
  private selBox: HTMLElement | null = null;
  private hoverBox: HTMLElement | null = null;
  private hoverEl: HTMLElement | null = null;
  private fontHandle: HTMLElement | null = null;
  /** custom text caret drawn in #stagearea chrome. The native caret is a 1px
      line that lands on/off a rasterised column at different sub-pixel x inside
      the scaled #stage, so it vanishes at some positions — we draw our own. */
  private caret: HTMLElement | null = null;
  /** true while an in-place text edit (contenteditable) is open, so the
      select/drag handlers stand down and let the caret work */
  private editing = false;
  /** the node currently being edited in place (for caret fallback metrics) */
  private editingNode: HTMLElement | null = null;

  /** which inspector group is shown (TEXT / LOOK / TIMING). One at a time —
      persisted per session so re-selecting an element doesn't reset it. */
  private static readonly TAB_KEY = "sv.tab";
  private static readonly TABS = ["text", "look", "timing"] as const;
  private activeTab: (typeof StageView.TABS)[number] = StageView.readTab();
  private static readTab(): (typeof StageView.TABS)[number] {
    try {
      const raw = localStorage.getItem(StageView.TAB_KEY);
      if (raw && (StageView.TABS as readonly string[]).includes(raw)) {
        return raw as (typeof StageView.TABS)[number];
      }
    } catch { /* localStorage may be unavailable */ }
    return "text";
  }

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
      this.syncSceneLoop(); // follow the loop to the newly-mounted scene
    });
    player.events.on("timings", () => {
      if (!this.dragging) this.rebuild();
    });
    player.events.on("time", () => this.onTime());

    const ro = new ResizeObserver(() => {
      if (this.scroll.clientWidth > 0 && !this.dragging) this.rebuild();
    });
    ro.observe(this.scroll);

    /* the stage rescales on window resize; reposition the highlight boxes (they
       only auto-track during playback via onTime) */
    window.addEventListener("resize", () => this.repositionBoxes());
  }

  /** Called by main.ts on every mode switch. Entering STAGE wires up live-preview
      selection + refits the lanes; leaving it tears the listeners down and clears
      the preview highlight. */
  onModeChange(active: boolean): void {
    this.active = active;
    const content = document.getElementById("scenecontent");
    if (active) {
      this.ensureOverlays();
      content?.addEventListener("pointerdown", this.onPreviewPointerDown, true);
      content?.addEventListener("pointermove", this.onPreviewPointerMove);
      content?.addEventListener("pointerleave", this.onPreviewPointerLeave);
      content?.addEventListener("dblclick", this.onPreviewDblClick, true);
      this.rebuild();
      this.applyHighlight();
      this.syncSceneLoop(); // engage the scene loop if it's on
    } else {
      content?.removeEventListener("pointerdown", this.onPreviewPointerDown, true);
      content?.removeEventListener("pointermove", this.onPreviewPointerMove);
      content?.removeEventListener("pointerleave", this.onPreviewPointerLeave);
      content?.removeEventListener("dblclick", this.onPreviewDblClick, true);
      this.hoverEl = null;
      this.highlight(null);
      this.positionBox(this.hoverBox, null);
      /* don't let a scene loop leak into TIME; only clear if we set one */
      if (this.loopScene) this.player.setLoop(null);
    }
  }

  /* --------------------------- scene loop toggle ------------------------- */

  private paintLoopBtn(): void {
    this.loopBtn.textContent = this.loopScene ? "⟳ loop scene" : "→ play through";
    this.loopBtn.classList.toggle("on", this.loopScene);
    this.loopBtn.title = this.loopScene
      ? "looping this scene during playback (click to play through to the next)"
      : "playing through to the next scene (click to loop this scene)";
  }

  private toggleLoop(): void {
    this.loopScene = !this.loopScene;
    localStorage.setItem(StageView.LOOP_KEY, this.loopScene ? "1" : "0");
    this.paintLoopBtn();
    if (this.loopScene) this.syncSceneLoop();
    else this.player.setLoop(null);
  }

  /** Pin the player loop to the current scene's bounds while SCENE is active and
      looping is on. The frame loop wraps at loop.end, so playback loops the
      scene; play-through mode leaves the loop clear. */
  private syncSceneLoop(): void {
    if (!this.active || !this.loopScene) return;
    const i = this.player.sceneIndex;
    const start = this.player.offsets[i];
    this.player.setLoop({ start, end: start + this.player.scene.len });
  }

  /* ------------------------------- shell -------------------------------- */

  private build(): void {
    this.root.classList.add("sv");

    this.titleEl = el("span", { class: "sv-title" });
    const byId = el("button", {
      class: "sv-byid",
      text: "+ by id",
      title: "schedule an element by typing its id (for elements you can't click)",
    });
    byId.onclick = () => this.addById();

    this.loopScene = localStorage.getItem(StageView.LOOP_KEY) === "1";
    this.loopBtn = el("button", { class: "sv-loop" }) as HTMLButtonElement;
    this.loopBtn.onclick = () => this.toggleLoop();
    this.paintLoopBtn();

    const toolbar = el(
      "div",
      { class: "sv-toolbar" },
      this.titleEl,
      el("span", { class: "tl-sep" }),
      byId,
      this.loopBtn,
      el("span", {
        class: "sv-hint",
        text:
          "click an element in the preview to select · drag it to move · edit text/size/colour in the inspector · del = remove from schedule",
      }),
    );

    this.ruler = el("div", { class: "sv-ruler" });
    this.script = el("div", { class: "sv-script" });
    this.lanes = el("div", { class: "sv-lanes" });
    this.playhead = el("div", { class: "sv-playhead" });
    this.snapGuide = el("div", { class: "sv-snapguide" });
    this.scroll = el(
      "div",
      { class: "sv-scroll" },
      this.ruler,
      this.script,
      this.lanes,
      this.snapGuide,
      this.playhead,
    );

    /* full-width timeline; the inspector lives in the side panel */
    this.root.append(toolbar, this.scroll);

    this.ruler.onpointerdown = (e) => this.seekDrag(e);
    this.script.onpointerdown = (e) => this.seekDrag(e);
    this.lanes.onpointerdown = (e) => {
      if ((e.target as HTMLElement).closest(".tl-clip, .tl-handle")) return;
      /* empty lanes: a drag draws a marquee (multi-select), a plain click seeks
         and clears the selection */
      this.marqueeOrSeek(e);
    };
  }

  /** SidePanel calls this in SCENE mode, handing us its body to render into. */
  mountInspector(host: HTMLElement): void {
    this.inspectorHost = host;
    this.renderInspector();
  }

  /** scrub the playhead by clicking or dragging the ruler / empty lanes
      (window-level listeners so the drag keeps tracking outside the element) */
  private seekDrag(e: PointerEvent): void {
    const seek = (clientX: number): void =>
      this.player.seek(this.player.offsets[this.player.sceneIndex] + this.localAt(clientX));
    seek(e.clientX);
    const move = (ev: PointerEvent): void => seek(ev.clientX);
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  /* ------------------------------ rebuild ------------------------------- */

  private rebuild(): void {
    const scene = this.player.scene;
    const si = this.player.sceneIndex;
    this.titleEl.textContent = `${si + 1} · ${scene.title}`;

    const width = this.scroll.clientWidth || 600;
    this.pps = Math.max(6, (width - 8) / Math.max(1, scene.len));

    this.clips = [];
    this.lanes.innerHTML = "";
    this.buildRuler(scene);
    this.buildScriptLane(scene);

    const laneEnds: number[] = [];
    for (const entry of scene.schedule) this.addClip(scene, entry, laneEnds);
    this.lanes.style.height = Math.max(1, laneEnds.length) * 24 + 8 + "px";

    this.onTime();
    this.applyHighlight();
    this.renderInspector();
  }

  /* read-only narration lane: shows the scene's script lines so you can time
     element entrances against the spoken words without leaving SCENE mode.
     Click to seek; not draggable (lines are retimed in TIME). */
  private buildScriptLane(scene: SceneData): void {
    this.script.innerHTML = "";
    for (const ln of scene.lines) {
      const clip = el("div", { class: "sv-script-clip", title: ln.text },
        el("span", { class: "tl-cliptext", text: ln.text }));
      clip.style.left = ln.from * this.pps + "px";
      clip.style.width = Math.max(8, (ln.to - ln.from) * this.pps - 1) + "px";
      clip.onpointerdown = (e) => {
        e.stopPropagation();
        this.player.seek(this.player.offsets[this.player.sceneIndex] + ln.from + 0.001);
      };
      this.script.appendChild(clip);
    }
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

  private addClip(scene: SceneData, entry: ScheduleEntry, laneEnds: number[]): void {
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
    /* pack to the clip's true right edge (no extra gap): when one element's
       enter is snapped to another's exit they only touch, so they belong on the
       same row — the +0.5 tolerance above lets a touching clip reuse the lane. */
    laneEnds[lane] = startPx + widthPx;

    const clip = el("div", {
      class: "tl-clip tl-element" + (isSpan ? "" : " tl-marker") +
        (info.exists ? "" : " sv-missing") +
        /* keep the selection visible across rebuilds (a clip click ends in a
           rebuild via beginDrag's pointerup, which recreates these divs) */
        (this.selected.has(entry) ? " selected" : ""),
      title: `#${entry.id}` + (info.exists ? "" : " — no element in scene.html"),
    });
    clip.append(
      el("span", { class: "sv-tag", text: info.exists ? (info.tag || "?") : "missing" }),
      el("span", { class: "tl-cliptext", text: info.label }),
    );

    const hl = isSpan ? el("div", { class: "tl-handle tl-handle-l" }) : null;
    const hr = el("div", { class: "tl-handle tl-handle-r" });
    if (hl) clip.appendChild(hl);
    clip.appendChild(hr);

    const laneTop = lane * 24 + 4;
    const place = (): void => {
      clip.style.left = entry.enter * this.pps + "px";
      clip.style.top = laneTop + "px";
      clip.style.width = entry.exit !== undefined
        ? Math.max(12, (entry.exit - entry.enter) * this.pps) + "px"
        : widthPx + "px";
    };

    const clipRec: Clip = {
      entry,
      div: clip,
      place,
      isCurrent: (local) =>
        local >= entry.enter && (entry.exit === undefined || local < entry.exit),
      edges: () =>
        entry.exit === undefined ? [entry.enter] : [entry.enter, entry.exit],
    };
    this.clips.push(clipRec);

    clip.onpointerdown = (e) => {
      e.stopPropagation();
      const target = e.target as HTMLElement;
      if (target === hl) {
        this.selectEntry(entry);
        const orig = entry.enter;
        this.beginDrag(e, new Set([entry]), [entry.enter], (delta) => {
          entry.enter = Math.min(
            (entry.exit ?? scene.len) - 0.1,
            Math.max(0, round(orig + delta)),
          );
        });
      } else if (target === hr) {
        this.selectEntry(entry);
        /* a marker has no exit yet: spawn it where the mouse grabbed (the
           visual right edge), not back at `enter`, so it doesn't jump */
        const orig = entry.exit ?? this.localAt(e.clientX);
        this.beginDrag(e, new Set([entry]), [orig], (delta) => {
          entry.exit = Math.max(
            entry.enter + 0.1,
            Math.min(scene.len, round(orig + delta)),
          );
        });
      } else {
        /* body: (ctrl+)click selection, then drag the whole selection together */
        this.clipPointerDown(e, entry, clipRec);
      }
    };

    /* double-click a clip: select it and jump the playhead to its entrance
       (mirrors double-clicking the element in the preview) */
    clip.ondblclick = (e) => {
      e.stopPropagation();
      this.selectEntry(entry);
      this.player.seek(this.player.offsets[this.player.sceneIndex] + entry.enter);
    };

    this.lanes.appendChild(clip);
    place();
  }

  /** scene-local time under a client x (shared by scrubbing + exit-on-drag) */
  private localAt(clientX: number): number {
    const rect = this.scroll.getBoundingClientRect();
    return Math.max(
      0,
      Math.min(
        this.player.scene.len,
        (clientX - rect.left + this.scroll.scrollLeft) / this.pps,
      ),
    );
  }

  /* ------------------------------- drag (clips) ------------------------- */

  /** drag one or more clips' edges/positions. `exclude` is the set of entries
      being moved (kept out of the snap targets so a clip never snaps to itself). */
  private beginDrag(
    e: PointerEvent,
    exclude: Set<ScheduleEntry>,
    edges: number[],
    apply: (delta: number) => void,
  ): void {
    const scene = this.player.scene;
    this.dragging = true;
    const startX = e.clientX;
    const before = this.history.snapshot(scene);
    const targets = this.snapTargets(exclude);
    const target = e.target as HTMLElement;
    target.setPointerCapture(e.pointerId);
    let moved = false;
    const move = (ev: PointerEvent): void => {
      /* ignore sub-threshold jitter so a plain click isn't treated as a drag:
         no rebuild on click keeps the clip div alive across a double-click */
      if (!moved && Math.abs(ev.clientX - startX) < 3) return;
      moved = true;
      apply(this.snapDelta((ev.clientX - startX) / this.pps, edges, targets, ev.shiftKey));
      this.sync.changed(scene);
      for (const c of this.clips) c.place();
    };
    const up = (): void => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      this.dragging = false;
      this.snapGuide.style.display = "none";
      if (moved) {
        this.history.commit(scene, before);
        this.rebuild();
      }
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  }

  private snapTargets(exclude: Set<ScheduleEntry>): number[] {
    const scene = this.player.scene;
    const targets = [0, scene.len, this.player.localTime];
    for (const ev of scene.schedule) {
      if (exclude.has(ev)) continue;
      targets.push(ev.enter);
      if (ev.exit !== undefined) targets.push(ev.exit);
    }
    return targets;
  }

  /** Move every entry in `entries` by the same (snapped) delta, clamped so the
      whole group stays within [0, scene.len]. The grabbed clip supplies the snap
      edges, so the group snaps off whichever clip the user is actually dragging. */
  private beginMultiDrag(
    e: PointerEvent,
    grabbed: ScheduleEntry,
    entries: ScheduleEntry[],
  ): void {
    const scene = this.player.scene;
    const orig = entries.map((en) => ({ en, enter: en.enter, exit: en.exit }));
    const minEnter = Math.min(...orig.map((o) => o.enter));
    const maxExit = Math.max(...orig.map((o) => o.exit ?? o.enter));
    const edges = grabbed.exit === undefined
      ? [grabbed.enter]
      : [grabbed.enter, grabbed.exit];
    this.beginDrag(e, new Set(entries), edges, (delta) => {
      const d = Math.max(-minEnter, Math.min(scene.len - maxExit, delta));
      for (const o of orig) {
        o.en.enter = round(o.enter + d);
        if (o.exit !== undefined) o.en.exit = round(o.exit + d);
      }
    });
  }

  private snapDelta(raw: number, edges: number[], targets: number[], free: boolean): number {
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
        if (dist < thresh && (!best || dist < best.dist)) best = { delta, target: t, dist };
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

  private selectEntry(entry: ScheduleEntry): void {
    this.select({ id: entry.id, entry });
  }

  private selectElement(id: string): void {
    const entry = this.player.scene.schedule.find((s) => s.id === id) ?? null;
    this.select({ id, entry });
  }

  /** single-select: replaces the whole multi-selection with just this element
      (or clears it). The inspector follows `sel`. */
  private select(sel: Selection | null): void {
    this.sel = sel;
    this.selected = sel?.entry ? new Set([sel.entry]) : new Set();
    this.paintSelected();
    this.highlight(sel?.id ?? null);
    this.renderInspector();
  }

  /** paint the `.selected` ring on every clip whose entry is in the set */
  private paintSelected(): void {
    for (const c of this.clips) {
      c.div.classList.toggle("selected", this.selected.has(c.entry));
    }
  }

  /** set the multi-selection to exactly `entries`. The inspector edits the sole
      member when there's one; with several it shows a multi summary instead. */
  private setSelectionSet(entries: Set<ScheduleEntry>): void {
    this.selected = entries;
    const only = entries.size === 1 ? [...entries][0] : null;
    this.sel = only ? { id: only.id, entry: only } : null;
    this.paintSelected();
    this.highlight(this.sel?.id ?? null);
    this.renderInspector();
  }

  private addToSelection(entry: ScheduleEntry): void {
    const next = new Set(this.selected);
    next.add(entry);
    this.setSelectionSet(next);
  }

  private removeFromSelection(entry: ScheduleEntry): void {
    const next = new Set(this.selected);
    next.delete(entry);
    this.setSelectionSet(next);
  }

  /** pointerdown on a clip body: ctrl/cmd toggles it in the selection, a plain
      click on an unselected clip replaces the selection, and a click on an
      already-selected clip keeps the (possibly multi) selection — then the drag
      moves everything selected together. */
  private clipPointerDown(e: PointerEvent, entry: ScheduleEntry, rec: Clip): void {
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl) {
      if (this.selected.has(entry)) {
        this.removeFromSelection(entry);
        return; // toggled off — nothing to drag
      }
      this.addToSelection(entry);
    } else if (!this.selected.has(entry)) {
      this.select({ id: entry.id, entry });
    }
    const entries = this.clips
      .filter((c) => this.selected.has(c.entry))
      .map((c) => c.entry);
    if (entries.length <= 1) {
      /* single clip: keep the original per-edge clamp against the scene end */
      const scene = this.player.scene;
      const oEnter = entry.enter, oExit = entry.exit;
      this.beginDrag(e, new Set([entry]), rec.edges(), (delta) => {
        const d = Math.max(-oEnter, delta);
        entry.enter = round(oEnter + d);
        if (oExit !== undefined) entry.exit = Math.min(scene.len, round(oExit + d));
      });
    } else {
      this.beginMultiDrag(e, entry, entries);
    }
  }

  /** empty-lanes pointer: drag = marquee select (ctrl adds to the current set),
      plain click = seek the playhead and clear the selection. */
  private marqueeOrSeek(e: PointerEvent): void {
    const startX = e.clientX, startY = e.clientY;
    const additive = e.ctrlKey || e.metaKey;
    const base = additive ? new Set(this.selected) : new Set<ScheduleEntry>();
    const target = e.target as HTMLElement;
    target.setPointerCapture(e.pointerId);
    let marquee: HTMLElement | null = null;
    const move = (ev: PointerEvent): void => {
      if (!marquee && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
      if (!marquee) {
        marquee = el("div", { class: "tl-marquee" });
        this.lanes.appendChild(marquee);
      }
      const lr = this.lanes.getBoundingClientRect();
      const x1 = Math.min(startX, ev.clientX), x2 = Math.max(startX, ev.clientX);
      const y1 = Math.min(startY, ev.clientY), y2 = Math.max(startY, ev.clientY);
      Object.assign(marquee.style, {
        left: x1 - lr.left + "px",
        top: y1 - lr.top + "px",
        width: x2 - x1 + "px",
        height: y2 - y1 + "px",
      });
      const next = new Set(base);
      for (const c of this.clips) {
        const r = c.div.getBoundingClientRect();
        if (r.left < x2 && r.right > x1 && r.top < y2 && r.bottom > y1) next.add(c.entry);
      }
      this.setSelectionSet(next);
    };
    const up = (): void => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      if (marquee) {
        marquee.remove();
      } else {
        /* a plain click on empty space: seek + deselect */
        this.player.seek(this.player.offsets[this.player.sceneIndex] + this.localAt(startX));
        this.select(null);
      }
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  }

  /** draw the selection box over the element with this id (null = hide it).
      Gate on isOnScreen() — same as repositionBoxes() — so selecting an element
      that isn't on-screen at the current playhead (before entrance / after exit /
      off the viewport) hides the box immediately instead of leaving a stale box
      that only corrects on the next playhead move. */
  private highlight(id: string | null): void {
    this.ensureOverlays();
    const node = id && this.isOnScreen(id) ? this.sceneEl(id) : null;
    this.positionBox(this.selBox, node);
  }

  private applyHighlight(): void {
    if (this.active) this.highlight(this.sel?.id ?? null);
  }

  private ensureOverlays(): void {
    if (this.selBox) return;
    const sa = document.getElementById("stagearea");
    if (!sa) return;
    this.selBox = el("div", { class: "sv-ovl-box sv-ovl-sel" });
    this.hoverBox = el("div", { class: "sv-ovl-box sv-ovl-hover" });
    /* corner handle on the selection box: drag to resize the element's font */
    this.fontHandle = el("div", { class: "sv-ovl-handle", title: "drag to resize the font" });
    this.fontHandle.onpointerdown = (e) => this.beginFontResize(e);
    this.selBox.appendChild(this.fontHandle);
    this.caret = el("div", { class: "sv-caret" });
    this.caret.style.display = "none";
    sa.append(this.selBox, this.hoverBox, this.caret);
  }

  /** Position the custom caret at the selection's focus point, in #stagearea
      coordinates (same basis as positionBox — getClientRects() is post-scale).
      Restarts the blink so the caret is solid immediately after it moves. */
  private positionCaret = (): void => {
    if (!this.editing || !this.caret) return;
    const sa = document.getElementById("stagearea");
    const sel = window.getSelection();
    if (!sa || !sel || !sel.focusNode || !this.editingNode?.contains(sel.focusNode)) {
      this.caret.style.display = "none";
      return;
    }
    let rect: DOMRect | null = null;
    try {
      const r = document.createRange();
      r.setStart(sel.focusNode, sel.focusOffset);
      r.collapse(true);
      rect = r.getClientRects()[0] ?? r.getBoundingClientRect();
    } catch { /* fall through to the node-metrics fallback */ }
    // empty element / zero rect: derive a caret box from the node's font metrics
    if (!rect || (rect.height === 0 && rect.width === 0 && rect.left === 0)) {
      const nr = this.editingNode.getBoundingClientRect();
      const fs = parseFloat(getComputedStyle(this.editingNode).fontSize) || 16;
      rect = new DOMRect(nr.left + 1, nr.top + Math.max(0, (nr.height - fs) / 2), 0, fs);
    }
    const sr = sa.getBoundingClientRect();
    this.caret.style.left = (rect.left - sr.left) + "px";
    this.caret.style.top = (rect.top - sr.top) + "px";
    this.caret.style.height = (rect.height || 16) + "px";
    this.caret.style.display = "block";
    this.caret.style.animation = "none";
    void this.caret.offsetWidth; // reflow to restart the blink
    this.caret.style.animation = "";
  };

  /** R6: drag the selection's corner handle to scale the element's font-size,
      written to the scene.css override (live preview while dragging). */
  private beginFontResize(e: PointerEvent): void {
    if (!this.sel) return;
    e.preventDefault();
    e.stopPropagation();
    const scene = this.player.scene;
    const id = this.sel.id;
    const node = this.sceneEl(id);
    if (!node) return;
    const startY = e.clientY;
    const startFont = parseFloat(getComputedStyle(node).fontSize) || 16;
    const startH = node.getBoundingClientRect().height || 1;
    let font = startFont;
    let moved = false;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const move = (ev: PointerEvent): void => {
      const dy = ev.clientY - startY;
      if (!moved && Math.abs(dy) < 2) return;
      moved = true;
      font = Math.max(4, Math.min(400, Math.round(startFont * (startH + dy) / startH)));
      node.style.fontSize = font + "px";
      this.positionBox(this.selBox, node);
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!moved) return;
      /* the drag only set node.style.fontSize inline; scene.css still holds the
         prior size, so snapshot now for an undoable resize */
      const before = this.history.snapshot(scene);
      api.setElementStyle(scene.id, id, { "font-size": font + "px" })
        .then((css) => {
          this.player.replaceSceneCss(scene, css);
          node.style.fontSize = ""; // hand off to the override
          this.history.commit(scene, before);
          this.renderInspector();
        })
        .catch((err) => console.warn("[stage] font resize failed:", err));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  /** position a chrome overlay box over an element's bounding rect (relative to
      #stagearea), or hide it when there's nothing to show. Drawn in studio
      chrome rather than on the element, so it survives opacity:0 / clipping. */
  private positionBox(box: HTMLElement | null, target: HTMLElement | null): void {
    if (!box) return;
    const sa = document.getElementById("stagearea");
    if (!target || !this.active || !sa || document.body.classList.contains("clean")) {
      box.style.display = "none";
      return;
    }
    const sr = sa.getBoundingClientRect();
    const r = target.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) { box.style.display = "none"; return; }
    box.style.display = "block";
    box.style.left = (r.left - sr.left) + "px";
    box.style.top = (r.top - sr.top) + "px";
    box.style.width = r.width + "px";
    box.style.height = r.height + "px";
  }

  /** Is element `id` on-screen at the current playhead? When it's scheduled,
      use the schedule window (deterministic + instant on a seek, vs. waiting on
      the entrance/exit fade). Otherwise fall back to computed visibility. */
  private isOnScreen(id: string): boolean {
    const entry = this.player.scene.schedule.find((s) => s.id === id);
    if (entry) {
      const local = this.player.localTime;
      return local >= entry.enter && (entry.exit === undefined || local < entry.exit);
    }
    const node = this.sceneEl(id);
    if (!node) return false;
    const cs = getComputedStyle(node);
    return cs.display !== "none" && cs.visibility !== "hidden" && parseFloat(cs.opacity) > 0.01;
  }

  private repositionBoxes(): void {
    if (!this.active) return;
    /* while editing text in place, the .sv-editing outline owns the element's
       visuals — keep the chrome boxes hidden so they don't reappear over the
       caret on a stray player event */
    if (this.editing) {
      this.positionBox(this.selBox, null);
      this.positionBox(this.hoverBox, null);
      return;
    }
    /* hide the selection box when its element isn't on-screen (before entrance /
       after exit) — a box floating over an invisible element is just noise */
    const selNode = this.sel && this.isOnScreen(this.sel.id) ? this.sceneEl(this.sel.id) : null;
    this.positionBox(this.selBox, selNode);
    this.positionBox(this.hoverBox, this.hoverEl);
  }

  /** Keep the overlay boxes glued to their elements across a CSS transition
      while paused (playback already repositions every frame). Undo/redo and
      style edits can re-trigger an entrance or move an element over ~0.5s; a
      single reposition would capture only the start of that motion. */
  private settleRaf = 0;
  private settleBoxes(): void {
    if (this.player.playing) return;
    cancelAnimationFrame(this.settleRaf);
    let frames = 0;
    const tick = (): void => {
      this.repositionBoxes();
      if (++frames < 45) this.settleRaf = requestAnimationFrame(tick); // ~0.7s @60fps
    };
    this.settleRaf = requestAnimationFrame(tick);
  }

  deleteSelection(): void {
    const scene = this.player.scene;
    /* remove every selected entry (falls back to the inspector target if the
       set is somehow empty but one is being edited) */
    const entries = this.selected.size
      ? [...this.selected]
      : (this.sel?.entry ? [this.sel.entry] : []);
    const present = entries.filter((en) => scene.schedule.includes(en));
    if (!present.length) return;
    const before = this.history.snapshot(scene);
    for (const en of present) {
      const at = scene.schedule.indexOf(en);
      if (at >= 0) scene.schedule.splice(at, 1);
    }
    this.history.commit(scene, before);
    this.sync.changed(scene);
    this.selected = new Set();
    this.sel = this.sel ? { id: this.sel.id, entry: null } : null;
    this.rebuild();
  }

  /* ------------------------------ add clips ----------------------------- */

  private addEntry(id: string, cls?: string): void {
    const scene = this.player.scene;
    const enter = round(Math.max(0, Math.min(scene.len - 0.1, this.player.localTime)));
    const wantCls = cls && cls !== "on" ? cls : undefined;
    /* don't stack an exact-duplicate entry (same id + enter + class, no exit/fx);
       just select the one that's already there */
    const dup = scene.schedule.find((s) =>
      s.id === id && s.enter === enter && s.exit === undefined &&
      (s.cls ?? "on") === (wantCls ?? "on") && !s.fx);
    if (dup) {
      this.selectEntry(dup);
      return;
    }
    const before = this.history.snapshot(scene);
    const entry: ScheduleEntry = { id, enter };
    if (wantCls) entry.cls = wantCls;
    scene.schedule.push(entry);
    this.history.commit(scene, before);
    this.sync.changed(scene);
    this.sel = { id, entry };
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

  /* ------------------- live-preview select + drag (T19/T22) ------------- */

  /** topmost VISIBLE id-bearing element under a point. Native hit-testing returns
      the literal topmost element, but a transparent full-stage overlay (opacity:0
      inactive .ovl) sits on top and would swallow it — so walk the hit stack and
      take the first visible id-element, falling back to the first id-element if
      none are visible (e.g. before anything has entered). */
  private pickAt(clientX: number, clientY: number): HTMLElement | null {
    const content = document.getElementById("scenecontent");
    if (!content) return null;
    let fallback: HTMLElement | null = null;
    for (const n of document.elementsFromPoint(clientX, clientY)) {
      /* accept SVG nodes too (an <svg>/<g>/<path> is an Element, not an
         HTMLElement) — a chart diagram is otherwise unselectable in the preview */
      if (!(n instanceof Element) || !content.contains(n)) continue;
      const idEl = n.closest<HTMLElement>("[id]");
      if (!idEl || idEl.id === "scenecontent" || idEl.id === "caption") continue;
      if (!/^[\w.-]+$/.test(idEl.id)) continue;
      if (!fallback) fallback = idEl;
      if (this.isVisible(idEl)) return idEl;
    }
    return fallback;
  }

  private isVisible(el: Element): boolean {
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" &&
      parseFloat(s.opacity || "1") > 0.05;
  }

  private onPreviewPointerDown = (e: PointerEvent): void => {
    if (this.editing) return; // let the caret place inside the editable
    const node = this.pickAt(e.clientX, e.clientY);
    if (!node) return;
    e.stopPropagation();
    if (!this.sel || this.sel.id !== node.id) this.selectElement(node.id);
    this.beginElementDrag(e, node, node.id);
  };

  private onPreviewPointerMove = (e: PointerEvent): void => {
    if (this.dragging || this.editing) return;
    const node = this.pickAt(e.clientX, e.clientY);
    this.hoverEl = node && node.id !== this.sel?.id ? node : null;
    this.positionBox(this.hoverBox, this.hoverEl);
  };

  private onPreviewPointerLeave = (): void => {
    this.hoverEl = null;
    this.positionBox(this.hoverBox, null);
  };

  /* double-click a preview element to edit its text in place (contenteditable).
     The clicked element's nearest id-bearing ancestor is the scheduled element
     we patch; a leaf gets a byte-faithful text patch, anything with children is
     re-serialised via element-html. */
  private onPreviewDblClick = (e: MouseEvent): void => {
    const node = e.target as HTMLElement;
    const content = document.getElementById("scenecontent");
    if (!node || !content?.contains(node)) return;
    const root = node.closest<HTMLElement>("[id]");
    if (!root || root.id === "scenecontent" || root.id === "caption") return;
    if (!/^[\w.-]+$/.test(root.id)) return;
    e.preventDefault();
    e.stopPropagation();
    this.selectElement(root.id);
    this.startInlineEdit(node, root);
  };

  /** make `node` contenteditable in place; commit on blur/Enter, cancel on Esc.
      Leaf + is-the-root → setElementText; otherwise re-serialise root.innerHTML. */
  private startInlineEdit(node: HTMLElement, root: HTMLElement): void {
    if (this.editing) return;
    const scene = this.player.scene;
    const orig = node.textContent ?? "";
    this.editing = true;
    this.editingNode = node;
    this.ensureOverlays(); // make sure the custom caret element exists
    node.setAttribute("contenteditable", "plaintext-only");
    node.classList.add("sv-editing");
    // the selection box (outline + glow) would compete with the editing outline
    // and obscure the caret — hide it while editing, restore in cleanup.
    this.positionBox(this.selBox, null);
    node.focus();
    const range = document.createRange();
    range.selectNodeContents(node);
    const selc = window.getSelection();
    selc?.removeAllRanges();
    selc?.addRange(range);
    // custom caret: native caret is unreliable inside the scaled stage. Track
    // every way the caret can move while editing and redraw our own.
    document.addEventListener("selectionchange", this.positionCaret);
    node.addEventListener("input", this.positionCaret);
    node.addEventListener("keyup", this.positionCaret);
    node.addEventListener("pointerup", this.positionCaret);
    this.positionCaret();

    const cleanup = (): void => {
      node.removeAttribute("contenteditable");
      node.classList.remove("sv-editing");
      node.removeEventListener("keydown", onKey, true);
      node.removeEventListener("blur", onBlur, true);
      document.removeEventListener("selectionchange", this.positionCaret);
      node.removeEventListener("input", this.positionCaret);
      node.removeEventListener("keyup", this.positionCaret);
      node.removeEventListener("pointerup", this.positionCaret);
      if (this.caret) this.caret.style.display = "none";
      this.editing = false;
      this.editingNode = null;
      this.repositionBoxes(); // re-show the selection box
    };
    const commit = (): void => {
      const text = node.textContent ?? "";
      cleanup();
      if (text === orig) return;
      const before = this.history.snapshot(scene); // pre-edit html, for undo
      const done = (html: string): void => {
        this.player.replaceSceneHtml(scene, html);
        this.history.commit(scene, before);
        this.rebuild();
      };
      const fail = (err: unknown): void => {
        node.textContent = orig;
        console.warn("[stage] text edit failed:", err);
      };
      if (node === root && root.children.length === 0) {
        api.setElementText(scene.id, root.id, text).then(done).catch(fail);
      } else {
        api.setElementHtml(scene.id, root.id, root.innerHTML).then(done).catch(fail);
      }
    };
    const onKey = (ev: KeyboardEvent): void => {
      ev.stopPropagation(); // don't let global hotkeys (space=play, del) fire
      if (ev.key === "Enter") { ev.preventDefault(); node.blur(); }
      else if (ev.key === "Escape") { ev.preventDefault(); node.textContent = orig; node.blur(); }
    };
    const onBlur = (): void => commit();
    node.addEventListener("keydown", onKey, true);
    node.addEventListener("blur", onBlur, true);
  }

  /** drag an element in the preview to reposition it. The offset is written as a
      `translate` override (which composes with the entrance animation's
      transform, so it doesn't fight the fx/.el motion). A pointerdown that
      doesn't move past the threshold is just a select. */
  private beginElementDrag(e: PointerEvent, node: HTMLElement, id: string): void {
    const scene = this.player.scene;
    const startX = e.clientX, startY = e.clientY;
    const scale = this.getScale();
    const base = this.parseTranslate(this.parseOverrides(scene.css, id).translate);
    let moved = false;
    let nx = base.x, ny = base.y;
    node.setPointerCapture?.(e.pointerId);
    const move = (ev: PointerEvent): void => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      this.dragging = true;
      nx = Math.round(base.x + dx / scale);
      ny = Math.round(base.y + dy / scale);
      node.style.translate = `${nx}px ${ny}px`;
      // onTime only repositions during playback; a paused drag would leave the
      // selection box at the start rect — track the node as it moves.
      this.positionBox(this.selBox, node);
      this.positionBox(this.hoverBox, null);
    };
    const up = (): void => {
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerup", up);
      node.removeEventListener("pointercancel", up);
      if (!moved) return;
      this.dragging = false;
      const val = nx === 0 && ny === 0 ? null : `${nx}px ${ny}px`;
      /* the drag only moved the node's inline transform; scene.css still holds
         the pre-drag translate, so snapshot now for an undoable reposition */
      const before = this.history.snapshot(scene);
      api.setElementStyle(scene.id, id, { translate: val })
        .then((css) => {
          this.player.replaceSceneCss(scene, css);
          node.style.translate = ""; // hand off to the CSS override
          this.history.commit(scene, before);
          this.renderInspector();
        })
        .catch((err) => console.warn("[stage] reposition failed:", err));
    };
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerup", up);
    node.addEventListener("pointercancel", up);
  }

  /* ---------------------------- inspector ------------------------------- */

  /** Rebuild the inspector into the side-panel host (set by mountInspector).
      No-op until SCENE mode has shown it once. */
  private renderInspector(): void {
    const host = this.inspectorHost;
    /* only when SCENE is active: rebuild() fires on player events in every mode,
       and the host is the shared side panel another mode may currently own */
    if (!host || !this.active) return;
    host.innerHTML = "";
    const scene = this.player.scene;
    const sel = this.sel;

    /* several clips selected (marquee / ctrl+click): no single element to edit,
       so show a count + bulk actions instead of the per-element groups */
    if (this.selected.size > 1) {
      const n = this.selected.size;
      host.appendChild(el("div", { class: "sv-insp-head" },
        el("span", { class: "sv-insp-name", text: `${n} elements selected` })));
      host.appendChild(el("div", {
        class: "sv-insp-note",
        text: "Drag any selected clip to move them together. Delete removes them all from the schedule.",
      }));
      const del = el("button", {
        class: "sv-del", text: `✕ remove ${n} from schedule`,
        title: "remove the selected elements from the scene's schedule (del)",
      });
      del.onclick = () => this.deleteSelection();
      host.appendChild(del);
      return;
    }

    if (!sel) {
      host.appendChild(el("div", {
        class: "sv-insp-empty",
        text: "Select an element in the preview (or a clip below) to edit its text, look and timing.",
      }));
      return;
    }

    const info = this.player.elementInfo(sel.id);
    const entry = sel.entry && scene.schedule.includes(sel.entry) ? sel.entry : null;

    host.appendChild(el("div", { class: "sv-insp-head" },
      el("span", {
        class: "sv-tag" + (info.exists ? "" : " sv-tag-missing"),
        text: info.exists ? (info.tag || "?") : "missing",
      }),
      el("span", { class: "sv-insp-name", text: info.label }),
      el("span", { class: "sv-insp-id", text: "#" + sel.id }),
    ));

    if (!info.exists) {
      host.appendChild(el("div", {
        class: "sv-insp-warn",
        text: "No element with this id in scene.html.",
      }));
      return;
    }

    /* one group at a time, chosen by the tab strip (B): TEXT | LOOK | TIMING.
       TEXT dims when the element has no editable text; TIMING shows either the
       schedule fields or the add-to-schedule button. */
    const hasText = this.textSpansUnder(this.sceneEl(sel.id) as HTMLElement).length > 0;
    host.appendChild(this.mkTabs({ text: hasText, look: true, timing: true }));
    const body = el("div", { class: "sv-tabbody" });
    host.appendChild(body);

    switch (this.activeTab) {
      case "text":
        if (!this.appendTextSection(body, scene, sel.id)) {
          body.appendChild(el("div", { class: "sv-insp-note", text: "This element has no editable text." }));
        }
        break;
      case "look":
        this.appendStyleSection(body, scene, sel.id);
        break;
      case "timing":
        if (entry) {
          this.appendScheduleSection(body, scene, entry);
        } else {
          const add = el("button", {
            class: "sv-mini sv-add",
            text: "+ add to schedule at playhead",
            title: "give this element an enter time so it animates in",
          });
          add.onclick = () => this.addEntry(sel.id);
          body.appendChild(add);
        }
        break;
    }
  }

  /** the TEXT | LOOK | TIMING tab strip. `enabled[tab]` false dims a tab (kept
      clickable — it still shows its empty note). Persists the active tab. */
  private mkTabs(enabled: Record<(typeof StageView.TABS)[number], boolean>): HTMLElement {
    const strip = el("div", { class: "sv-tabs", role: "tablist" });
    for (const tab of StageView.TABS) {
      const btn = el("button", {
        class: "sv-tab"
          + (tab === this.activeTab ? " sv-tab-on" : "")
          + (enabled[tab] ? "" : " sv-tab-empty"),
        text: tab,
      });
      btn.onclick = () => {
        if (this.activeTab === tab) return;
        this.activeTab = tab;
        try { localStorage.setItem(StageView.TAB_KEY, tab); } catch { /* unavailable */ }
        this.renderInspector();
      };
      strip.appendChild(btn);
    }
    return strip;
  }

  /* T20: one field per editable text run under the element (handles text nested
     inside animated divs). Each run is patched precisely. Returns false if the
     element has no editable text. */
  private appendTextSection(parent: HTMLElement, scene: SceneData, id: string): boolean {
    const rootEl = this.sceneEl(id);
    if (!rootEl) return false;
    const spans = this.textSpansUnder(rootEl);
    if (!spans.length) return false;
    for (const span of spans) {
      const input = el("input", {
        type: "text", class: "sv-input", value: span.text,
        title: "on-screen text — saved into scene.html (or double-click it on the stage)",
      }) as HTMLInputElement;
      this.stopKeys(input);
      const status = el("span", { class: "sv-insp-status" });
      input.onchange = () => this.commitText(scene, id, rootEl, span, input.value, status);
      parent.appendChild(this.field(
        spans.length > 1 ? span.label : "content",
        el("div", { class: "sv-insp-inline" }, input, status),
      ));
    }
    return true;
  }

  private commitText(
    scene: SceneData,
    rootId: string,
    rootEl: HTMLElement,
    span: { node: ChildNode; path: number[]; text: string },
    value: string,
    status: HTMLElement,
  ): void {
    if (value === span.text) return;
    status.textContent = "…";
    const before = this.history.snapshot(scene); // pre-edit html, for undo
    const done = (html: string): void => {
      this.player.replaceSceneHtml(scene, html);
      this.history.commit(scene, before);
      status.textContent = "✓";
      this.rebuild();
    };
    const fail = (err: unknown): void => { status.textContent = "✕"; console.warn(err); };

    /* leaf element editing its own only text run: byte-faithful text patch */
    if (rootEl.children.length === 0 && span.path.length <= 1) {
      api.setElementText(scene.id, rootId, value).then(done).catch(fail);
      return;
    }
    /* nested: rebuild the element's inner HTML with just this text run changed */
    const clone = rootEl.cloneNode(true) as HTMLElement;
    const target = this.walkPath(clone, span.path);
    if (!target) { fail(new Error("lost the text node")); return; }
    target.nodeValue = value;
    api.setElementHtml(scene.id, rootId, clone.innerHTML).then(done).catch(fail);
  }

  /* T21: type scale + colour, persisted as a generated #id{} rule in scene.css */
  private appendStyleSection(parent: HTMLElement, scene: SceneData, id: string): boolean {
    const elNode = this.sceneEl(id);
    if (!elNode) return false;
    const ov = this.parseOverrides(scene.css, id);
    const computed = getComputedStyle(elNode);

    /* font size */
    const fsCur = parseFloat(ov["font-size"] ?? computed.fontSize) || 0;
    const fsInput = el("input", {
      type: "number", class: "sv-input sv-num", min: "4", max: "400", step: "1",
      value: String(Math.round(fsCur)),
      title: "font size in px (or drag the corner handle on the stage)",
    }) as HTMLInputElement;
    this.stopKeys(fsInput);
    fsInput.onchange = () => {
      const v = Math.round(Number(fsInput.value));
      this.commitStyle(scene, id, { "font-size": v > 0 ? v + "px" : null });
    };
    const fsReset = this.resetBtn(() => this.commitStyle(scene, id, { "font-size": null }), !ov["font-size"]);
    parent.appendChild(this.field("font size (px)", el("div", { class: "sv-insp-inline" }, fsInput, fsReset)));

    parent.appendChild(this.colorField(scene, id, "color", "text colour", ov, computed.color));
    parent.appendChild(this.colorField(scene, id, "background-color", "background", ov, computed.backgroundColor));

    /* position (translate) */
    const t = this.parseTranslate(ov.translate);
    const xIn = this.posInput(t.x, (v) => this.writeTranslate(scene, id, v, this.parseTranslate(this.parseOverrides(scene.css, id).translate).y));
    const yIn = this.posInput(t.y, (v) => this.writeTranslate(scene, id, this.parseTranslate(this.parseOverrides(scene.css, id).translate).x, v));
    const posReset = this.resetBtn(() => this.commitStyle(scene, id, { translate: null }), !ov.translate);
    parent.appendChild(this.field("position x / y (or drag on stage)",
      el("div", { class: "sv-insp-inline" }, xIn, yIn, posReset)));
    return true;
  }

  private colorField(
    scene: SceneData, id: string, prop: string, label: string,
    ov: Record<string, string>, computed: string,
  ): HTMLElement {
    const cur = ov[prop];
    const input = el("input", {
      type: "color", class: "sv-color",
      value: this.toHex(cur || computed),
    }) as HTMLInputElement;
    input.onchange = () => this.commitStyle(scene, id, { [prop]: input.value });
    const reset = this.resetBtn(() => this.commitStyle(scene, id, { [prop]: null }), !cur);
    return this.field(label, el("div", { class: "sv-insp-inline" }, input, reset));
  }

  private posInput(value: number, onCommit: (v: number) => void): HTMLInputElement {
    const input = el("input", {
      type: "number", class: "sv-input sv-num", step: "1", value: String(value),
    }) as HTMLInputElement;
    this.stopKeys(input);
    input.onchange = () => onCommit(Math.round(Number(input.value)) || 0);
    return input;
  }

  private writeTranslate(scene: SceneData, id: string, x: number, y: number): void {
    this.commitStyle(scene, id, { translate: x === 0 && y === 0 ? null : `${x}px ${y}px` });
  }

  private commitStyle(scene: SceneData, id: string, decls: Record<string, string | null>): void {
    /* snapshot the pre-edit css (still in scene.css until the server replies) so
       the style change is undoable */
    const before = this.history.snapshot(scene);
    api.setElementStyle(scene.id, id, decls)
      .then((css) => {
        this.player.replaceSceneCss(scene, css);
        this.history.commit(scene, before);
        this.renderInspector();
      })
      .catch((err) => console.warn("[stage] style write failed:", err));
  }

  /* schedule timing + animation (undoable, scene.json) */
  private appendScheduleSection(parent: HTMLElement, scene: SceneData, entry: ScheduleEntry): boolean {
    const enterInput = this.numberInput(entry.enter, (v) => {
      this.commit(scene, () => {
        entry.enter = Math.max(0, Math.min(entry.exit !== undefined ? entry.exit - 0.1 : scene.len, v));
      });
    });
    parent.appendChild(this.field("enter (s)", enterInput));

    if (entry.exit !== undefined) {
      const exitInput = this.numberInput(entry.exit, (v) => {
        this.commit(scene, () => {
          entry.exit = Math.max(entry.enter + 0.1, Math.min(scene.len, v));
        });
      });
      const rm = el("button", { class: "sv-mini", text: "remove", title: "remove the exit (element stays on)" });
      rm.onclick = () => this.commit(scene, () => delete entry.exit);
      parent.appendChild(this.field("exit (s)", el("div", { class: "sv-insp-inline" }, exitInput, rm)));
    } else {
      const add = el("button", {
        class: "sv-mini", text: "+ add exit",
        title: "give the element an exit — at the playhead if it's past the entrance",
      });
      add.onclick = () => this.commit(scene, () => {
        const p = this.player.localTime;
        entry.exit = round(
          p > entry.enter + 0.1
            ? Math.min(scene.len, p)
            : Math.min(scene.len, entry.enter + 2),
        );
      });
      parent.appendChild(this.field("exit", add));
    }

    const fxSel = el("select", { class: "sv-select" }) as HTMLSelectElement;
    for (const [val, label] of FX_PRESETS) {
      const opt = el("option", { value: val, text: label }) as HTMLOptionElement;
      if ((entry.fx ?? "") === val) opt.selected = true;
      fxSel.appendChild(opt);
    }
    fxSel.onchange = () => this.commit(scene, () => {
      if (fxSel.value) entry.fx = fxSel.value;
      else delete entry.fx;
    });
    this.stopKeys(fxSel);
    parent.appendChild(this.field("animation", fxSel));

    /* The dropdown only reflects the schedule's `fx` field. When an element has
       no preset but still animates (a class like .el / .ovl with a CSS
       transition), "none" looks wrong — say so, and that a preset overrides it. */
    if (!entry.fx) {
      const node = this.sceneEl(entry.id);
      const dur = node ? getComputedStyle(node).transitionDuration : "0s";
      if (dur && dur.split(",").some((d) => parseFloat(d) > 0)) {
        parent.appendChild(el("div", {
          class: "sv-insp-note",
          text: "Animates via its own CSS class (e.g. .el). Pick a preset to override that motion.",
        }));
      }
    }

    const clsInput = el("input", {
      type: "text", class: "sv-input", value: entry.cls ?? "on",
      title: "CSS class the engine toggles (default 'on'); animation presets pair with 'on'.",
    }) as HTMLInputElement;
    clsInput.onchange = () => this.commit(scene, () => {
      const v = clsInput.value.trim();
      if (v && v !== "on") entry.cls = v;
      else delete entry.cls;
    });
    this.stopKeys(clsInput);
    parent.appendChild(this.field("toggle class", clsInput));

    const del = el("button", {
      class: "sv-del", text: "✕ remove from schedule",
      title: "remove this element from the scene's schedule (del)",
    });
    del.onclick = () => this.deleteSelection();
    parent.appendChild(del);
    return true;
  }

  /* ------------------------------ helpers ------------------------------- */

  /** every text run under `root`, with its child-index path (so we can re-find
      it in a clone) and a short label from its nearest element ancestor */
  private textSpansUnder(
    root: HTMLElement,
  ): Array<{ node: ChildNode; path: number[]; text: string; label: string }> {
    const out: Array<{ node: ChildNode; path: number[]; text: string; label: string }> = [];
    const walk = (node: ChildNode, path: number[]): void => {
      const kids = node.childNodes;
      for (let i = 0; i < kids.length; i++) {
        const child = kids[i];
        if (child.nodeType === Node.TEXT_NODE) {
          const text = (child.nodeValue ?? "").trim();
          if (text) {
            const pe = child.parentElement;
            /* className is an SVGAnimatedString (not a string) on SVG nodes, so
               read the class via getAttribute — a #id slide can wrap an <svg>
               diagram whose <text> runs we'd otherwise crash on. */
            const peClass = (pe?.getAttribute("class") ?? "").trim().split(/\s+/)[0];
            const label = pe && pe !== root
              ? "." + (peClass || pe.tagName.toLowerCase())
              : "content";
            out.push({ node: child, path: [...path, i], text, label });
          }
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          walk(child, [...path, i]);
        }
      }
    };
    walk(root, []);
    return out;
  }

  private walkPath(root: HTMLElement, path: number[]): ChildNode | null {
    let node: ChildNode = root;
    for (const i of path) {
      if (!node.childNodes[i]) return null;
      node = node.childNodes[i];
    }
    return node;
  }

  private parseOverrides(css: string, id: string): Record<string, string> {
    const s = css.indexOf("studio:overrides");
    if (s < 0) return {};
    const end = css.indexOf("studio:overrides:end", s);
    const region = css.slice(s, end < 0 ? css.length : end);
    const re = new RegExp("#" + id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}");
    const m = re.exec(region);
    if (!m) return {};
    const out: Record<string, string> = {};
    for (const part of m[1].split(";")) {
      const i = part.indexOf(":");
      if (i < 0) continue;
      out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return out;
  }

  private parseTranslate(v: string | undefined): { x: number; y: number } {
    if (!v) return { x: 0, y: 0 };
    const parts = v.trim().split(/\s+/).map((p) => parseFloat(p) || 0);
    return { x: parts[0] ?? 0, y: parts[1] ?? 0 };
  }

  private toHex(color: string): string {
    if (/^#[0-9a-f]{6}$/i.test(color)) return color;
    const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(color);
    if (!m) return "#000000";
    const h = (n: string) => Math.max(0, Math.min(255, parseInt(n, 10))).toString(16).padStart(2, "0");
    return "#" + h(m[1]) + h(m[2]) + h(m[3]);
  }

  private getScale(): number {
    const st = document.getElementById("stage");
    if (!st) return 1;
    return st.getBoundingClientRect().width / this.player.project.width || 1;
  }

  private sceneEl(id: string): HTMLElement | null {
    const content = document.getElementById("scenecontent");
    return content?.querySelector<HTMLElement>("#" + CSS.escape(id)) ?? null;
  }

  private field(label: string, control: HTMLElement): HTMLElement {
    return el("label", { class: "sv-field" },
      el("span", { class: "sv-field-label", text: label }), control);
  }

  private resetBtn(onClick: () => void, disabled: boolean): HTMLButtonElement {
    const b = el("button", { class: "sv-reset", text: "⟲", title: "reset to the scene default" }) as HTMLButtonElement;
    b.disabled = disabled;
    b.onclick = onClick;
    return b;
  }

  private numberInput(value: number, onCommit: (v: number) => void): HTMLInputElement {
    const input = el("input", {
      type: "number", class: "sv-input sv-num", step: "0.1", value: value.toFixed(2),
    }) as HTMLInputElement;
    input.onchange = () => {
      const v = Number(input.value);
      if (Number.isFinite(v)) onCommit(round(v));
    };
    this.stopKeys(input);
    return input;
  }

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

  private onTime(): void {
    const local = this.player.localTime;
    this.playhead.style.left = local * this.pps + "px";
    for (const c of this.clips) c.div.classList.toggle("current", c.isCurrent(local));
    this.repositionBoxes(); // track elements as they move through animations
    /* during playback the player's rAF calls onTime every frame, so the boxes
       already track; a paused seek/scrub/undo fires onTime once, so kick a short
       settle loop to follow the element through its entrance/exit transition. */
    this.settleBoxes();
  }
}

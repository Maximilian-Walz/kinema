import * as api from "../api";
import { fmt, type Player } from "../engine/player";
import type { History } from "../history";
import type { TimingSync } from "../timings";
import type { ScheduleEntry, SceneData } from "../types";
import { el } from "./dom";

/* ============================================================================
   STAGE mode bottom workspace — choreograph ONE scene.

   Scene-scoped, unlike TIME's global timeline: the live preview above stays on
   the current scene and this dock edits that scene directly, so the user touches
   raw files as little as possible. Layout:

     +--------------------------------------------------+------------------+
     |  toolbar: scene title · + by id · hint           |                  |
     +--------------------------------------------------+   INSPECTOR      |
     |  ruler (scene-local 0..len, click = seek)        |  selected element|
     |  ------------------------------------------------ |  - text spans    |
     |  [ title ][ sub ]   [ card======]   | <- lanes   |  - size / colour |
     |              [ note ]                |  playhead  |  - position      |
     +--------------------------------------------------+  - enter/exit/fx |
                                                          +------------------+

   Selection is bidirectional: click an element in the live preview to select it
   (and the inspector + its schedule clip light up), or click a clip below. The
   inspector then edits, all without opening files:
   - the element's on-screen text, including text nested inside animated divs
     (each text run is its own field; patched into scene.html)              (T20)
   - type scale and colour, stored as a generated #id{} rule in scene.css    (T21)
   - position — drag the element in the preview; a `translate` override that
     composes with the entrance animation's transform                       (T22)
   - schedule timing (enter/exit), entrance animation preset, toggle class

   Schedule edits (timing/fx/cls/add/remove) are undoable via history + saved to
   scene.json. Text edits write scene.html; style/position edits write scene.css.
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
  private inspector!: HTMLElement;

  private pps = 40;
  private clips: Clip[] = [];
  private sel: Selection | null = null;
  private dragging = false;
  private active = false;

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

    const ro = new ResizeObserver(() => {
      if (this.scroll.clientWidth > 0 && !this.dragging) this.rebuild();
    });
    ro.observe(this.scroll);
  }

  /** Called by main.ts on every mode switch. Entering STAGE wires up live-preview
      selection + refits the lanes; leaving it tears the listeners down and clears
      the preview highlight. */
  onModeChange(active: boolean): void {
    this.active = active;
    const content = document.getElementById("scenecontent");
    if (active) {
      content?.addEventListener("pointerdown", this.onPreviewPointerDown, true);
      this.rebuild();
      this.applyHighlight();
    } else {
      content?.removeEventListener("pointerdown", this.onPreviewPointerDown, true);
      this.highlight(null);
    }
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

    const toolbar = el(
      "div",
      { class: "sv-toolbar" },
      this.titleEl,
      el("span", { class: "tl-sep" }),
      byId,
      el("span", {
        class: "sv-hint",
        text:
          "click an element in the preview to select · drag it to move · edit text/size/colour in the inspector · del = remove from schedule",
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

    const laneEnds: number[] = [];
    for (const entry of scene.schedule) this.addClip(scene, entry, laneEnds);
    this.lanes.style.height = Math.max(1, laneEnds.length) * 24 + 8 + "px";

    this.onTime();
    this.applyHighlight();
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
    laneEnds[lane] = startPx + widthPx + 6;

    const clip = el("div", {
      class: "tl-clip tl-element" + (isSpan ? "" : " tl-marker") +
        (info.exists ? "" : " sv-missing"),
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
      this.selectEntry(entry);
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
          if (oExit !== undefined) entry.exit = Math.min(scene.len, round(oExit + d));
        });
      }
    };

    this.lanes.appendChild(clip);
    place();
  }

  /* ------------------------------- drag (clips) ------------------------- */

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
      this.history.commit(scene, before);
      this.rebuild();
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  }

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

  private select(sel: Selection | null): void {
    this.sel = sel;
    for (const c of this.clips) {
      c.div.classList.toggle("selected", !!sel && c.entry === sel.entry);
    }
    this.highlight(sel?.id ?? null);
    this.renderInspector();
  }

  /** outline the selected element in the live preview (devtools-style) */
  private highlight(id: string | null): void {
    const content = document.getElementById("scenecontent");
    content?.querySelectorAll(".sv-el-selected").forEach((e) =>
      e.classList.remove("sv-el-selected")
    );
    if (id) this.sceneEl(id)?.classList.add("sv-el-selected");
  }

  /** re-apply the outline after a rebuild/remount (the class is on live DOM) */
  private applyHighlight(): void {
    if (this.active && this.sel) this.highlight(this.sel.id);
  }

  deleteSelection(): void {
    const scene = this.player.scene;
    const entry = this.sel?.entry;
    const at = entry ? scene.schedule.indexOf(entry) : -1;
    if (at < 0) return;
    const before = this.history.snapshot(scene);
    scene.schedule.splice(at, 1);
    this.history.commit(scene, before);
    this.sync.changed(scene);
    this.sel = this.sel ? { id: this.sel.id, entry: null } : null;
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

  private onPreviewPointerDown = (e: PointerEvent): void => {
    const content = document.getElementById("scenecontent");
    if (!content) return;
    /* Native hit-testing returns the topmost element, but a transparent
       full-stage overlay (opacity:0, e.g. an inactive .ovl) sits on top and
       would swallow the click. Walk the hit stack and take the first VISIBLE
       id-bearing element instead; fall back to the first id-element if none of
       them are visible (e.g. clicking before anything has entered). */
    const stack = document.elementsFromPoint(e.clientX, e.clientY);
    let chosen: HTMLElement | null = null;
    let fallback: HTMLElement | null = null;
    for (const n of stack) {
      if (!(n instanceof HTMLElement) || !content.contains(n)) continue;
      const idEl = n.closest<HTMLElement>("[id]");
      if (!idEl || idEl.id === "scenecontent" || idEl.id === "caption") continue;
      if (!/^[\w.-]+$/.test(idEl.id)) continue;
      if (!fallback) fallback = idEl;
      if (this.isVisible(idEl)) { chosen = idEl; break; }
    }
    const node = chosen ?? fallback;
    if (!node) return;
    e.stopPropagation();
    if (!this.sel || this.sel.id !== node.id) this.selectElement(node.id);
    this.beginElementDrag(e, node, node.id);
  };

  private isVisible(el: HTMLElement): boolean {
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" &&
      parseFloat(s.opacity || "1") > 0.05;
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
    };
    const up = (): void => {
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerup", up);
      node.removeEventListener("pointercancel", up);
      if (!moved) return;
      this.dragging = false;
      const val = nx === 0 && ny === 0 ? null : `${nx}px ${ny}px`;
      api.setElementStyle(scene.id, id, { translate: val })
        .then((css) => {
          this.player.replaceSceneCss(scene, css);
          node.style.translate = ""; // hand off to the CSS override
          this.renderInspector();
        })
        .catch((err) => console.warn("[stage] reposition failed:", err));
    };
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerup", up);
    node.addEventListener("pointercancel", up);
  }

  /* ---------------------------- inspector ------------------------------- */

  private renderInspector(): void {
    this.inspector.innerHTML = "";
    const scene = this.player.scene;
    const sel = this.sel;

    if (!sel) {
      this.inspector.appendChild(el("div", {
        class: "sv-insp-empty",
        text: "click an element in the preview (or a clip below) to edit it",
      }));
      return;
    }

    const info = this.player.elementInfo(sel.id);
    const entry = sel.entry && scene.schedule.includes(sel.entry) ? sel.entry : null;

    this.inspector.append(
      el("div", { class: "sv-insp-head" },
        el("span", {
          class: "sv-tag" + (info.exists ? "" : " sv-tag-missing"),
          text: info.exists ? (info.tag || "?") : "missing",
        }),
        el("span", { class: "sv-insp-name", text: info.label }),
      ),
      el("div", { class: "sv-insp-id", text: "#" + sel.id }),
    );

    if (!info.exists) {
      this.inspector.appendChild(el("div", {
        class: "sv-insp-warn",
        text: "no element with this id in scene.html.",
      }));
      return;
    }

    /* schedule membership: add if this element isn't scheduled yet */
    if (!entry) {
      const add = el("button", {
        class: "sv-mini sv-add",
        text: "+ add to schedule at playhead",
        title: "give this element an enter time so it animates in",
      });
      add.onclick = () => this.addEntry(sel.id);
      this.inspector.appendChild(add);
    }

    this.appendTextSection(scene, sel.id);
    this.appendStyleSection(scene, sel.id);
    if (entry) this.appendScheduleSection(scene, entry);
  }

  /* T20: one field per editable text run under the element (handles text nested
     inside animated divs). Each run is patched precisely. */
  private appendTextSection(scene: SceneData, id: string): void {
    const rootEl = this.sceneEl(id);
    if (!rootEl) return;
    const spans = this.textSpansUnder(rootEl);
    if (!spans.length) return;

    const sec = el("div", { class: "sv-insp-sec" },
      el("div", { class: "sv-sec-title", text: "text" }));
    for (const span of spans) {
      const input = el("input", {
        type: "text",
        class: "sv-input",
        value: span.text,
        title: "on-screen text — saved into scene.html",
      }) as HTMLInputElement;
      this.stopKeys(input);
      const status = el("span", { class: "sv-insp-status" });
      input.onchange = () => this.commitText(scene, id, rootEl, span, input.value, status);
      const row = el("div", { class: "sv-insp-inline" }, input, status);
      sec.append(
        el("div", { class: "sv-field" },
          spans.length > 1
            ? el("span", { class: "sv-field-label", text: span.label })
            : el("span", { class: "sv-field-label", text: "content" }),
          row),
      );
    }
    this.inspector.appendChild(sec);
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
    const done = (html: string): void => {
      this.player.replaceSceneHtml(scene, html);
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
  private appendStyleSection(scene: SceneData, id: string): void {
    const elNode = this.sceneEl(id);
    if (!elNode) return;
    const ov = this.parseOverrides(scene.css, id);
    const computed = getComputedStyle(elNode);
    const sec = el("div", { class: "sv-insp-sec" },
      el("div", { class: "sv-sec-title", text: "style" }));

    /* font size */
    const fsCur = parseFloat(ov["font-size"] ?? computed.fontSize) || 0;
    const fsInput = el("input", {
      type: "number", class: "sv-input sv-num", min: "4", max: "400", step: "1",
      value: String(Math.round(fsCur)),
      title: "font size in px",
    }) as HTMLInputElement;
    this.stopKeys(fsInput);
    fsInput.onchange = () => {
      const v = Math.round(Number(fsInput.value));
      this.commitStyle(scene, id, { "font-size": v > 0 ? v + "px" : null });
    };
    const fsReset = this.resetBtn(() => this.commitStyle(scene, id, { "font-size": null }), !ov["font-size"]);
    sec.appendChild(this.field("font size (px)", el("div", { class: "sv-insp-inline" }, fsInput, fsReset)));

    /* text colour */
    sec.appendChild(this.colorField(scene, id, "color", "text colour", ov, computed.color));
    /* background colour */
    sec.appendChild(this.colorField(scene, id, "background-color", "background", ov, computed.backgroundColor));

    /* position (translate) */
    const t = this.parseTranslate(ov.translate);
    const xIn = this.posInput(t.x, (v) => this.writeTranslate(scene, id, v, this.parseTranslate(this.parseOverrides(scene.css, id).translate).y));
    const yIn = this.posInput(t.y, (v) => this.writeTranslate(scene, id, this.parseTranslate(this.parseOverrides(scene.css, id).translate).x, v));
    const posReset = this.resetBtn(() => this.commitStyle(scene, id, { translate: null }), !ov.translate);
    sec.appendChild(this.field("position x / y (drag on stage)",
      el("div", { class: "sv-insp-inline" }, xIn, yIn, posReset)));

    this.inspector.appendChild(sec);
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
    api.setElementStyle(scene.id, id, decls)
      .then((css) => {
        this.player.replaceSceneCss(scene, css);
        this.renderInspector();
      })
      .catch((err) => console.warn("[stage] style write failed:", err));
  }

  /* schedule timing + animation (undoable, scene.json) */
  private appendScheduleSection(scene: SceneData, entry: ScheduleEntry): void {
    const sec = el("div", { class: "sv-insp-sec" },
      el("div", { class: "sv-sec-title", text: "schedule" }));

    const enterInput = this.numberInput(entry.enter, (v) => {
      this.commit(scene, () => {
        entry.enter = Math.max(0, Math.min(entry.exit !== undefined ? entry.exit - 0.1 : scene.len, v));
      });
    });
    sec.appendChild(this.field("enter (s)", enterInput));

    if (entry.exit !== undefined) {
      const exitInput = this.numberInput(entry.exit, (v) => {
        this.commit(scene, () => {
          entry.exit = Math.max(entry.enter + 0.1, Math.min(scene.len, v));
        });
      });
      const rm = el("button", { class: "sv-mini", text: "remove", title: "remove the exit (element stays on)" });
      rm.onclick = () => this.commit(scene, () => delete entry.exit);
      sec.appendChild(this.field("exit (s)", el("div", { class: "sv-insp-inline" }, exitInput, rm)));
    } else {
      const add = el("button", { class: "sv-mini", text: "+ add exit", title: "give the element an exit time" });
      add.onclick = () => this.commit(scene, () => { entry.exit = round(Math.min(scene.len, entry.enter + 2)); });
      sec.appendChild(this.field("exit", add));
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
    sec.appendChild(this.field("animation", fxSel));

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
    sec.appendChild(this.field("toggle class", clsInput));

    const del = el("button", {
      class: "sv-del", text: "✕ remove from schedule",
      title: "remove this element from the scene's schedule (del)",
    });
    del.onclick = () => this.deleteSelection();
    sec.appendChild(del);

    this.inspector.appendChild(sec);
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
            const label = pe && pe !== root
              ? "." + (pe.className.split(/\s+/)[0] || pe.tagName.toLowerCase())
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
  }
}

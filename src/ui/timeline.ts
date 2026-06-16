import * as api from "../api";
import { takeUrl } from "../api";
import type { Takes } from "../audio/takes";
import { drawWaveform, getPeaks } from "../audio/waveform";
import { fmt, type Player } from "../engine/player";
import type { History } from "../history";
import type { TimingSync } from "../timings";
import type { SceneData, TimedText } from "../types";
import { el } from "./dom";

/* ============================================================================
   Timeline editor — the GLOBAL clock across all scenes. Tracks, top to bottom:
     ruler      time ticks: click/drag seeks, alt+drag sets the loop region
     SCENES     one block per scene, drag the right edge to change its length
     SCRIPT     narration lines as clips
     CAPTIONS   lower-third captions
     VOICE      picked take waveform per scene — drag horizontally to align
                the recording against the scene (offset kept for export)

   Per-element enter/exit is scene-local and lives in SCENE mode, not here.

   Interactions:
   - drag clips to move, drag edges to retime; edits land in scene.json
   - magnetic snapping to playhead, scene bounds, loop edges and other clips
     (hold SHIFT for free placement)
   - click selects, ctrl+click toggles, drag on empty space = marquee;
     a drag on any selected clip moves the whole selection; DEL deletes
   - double-click a script/caption clip to edit its text
   - "+ line / + caption" insert at the playhead
   - every transaction is undoable (ctrl+Z / ctrl+shift+Z)
============================================================================ */

const GRID = 0.1;
const FINE = 0.01;
const round = (v: number, step: number): number => Math.round(v / step) * step;

interface ClipRecord {
  div: HTMLElement;
  place: () => void; // re-apply left/width from the model
  isCurrent?: (time: number) => boolean;
  key?: string; // present = selectable
  scene?: SceneData;
  edges?: () => number[]; // absolute times, used as snap targets
  beginMove?: () => (delta: number) => void; // participate in (multi-)drag
  remove?: () => void; // delete from the model
}

export class Timeline {
  private readonly player: Player;
  private readonly takes: Takes;
  private readonly sync: TimingSync;
  private readonly history: History;

  private readonly root: HTMLElement;
  private scroll!: HTMLElement;
  private canvas!: HTMLElement;
  private playhead!: HTMLElement;
  private snapGuide!: HTMLElement;
  private loopEl!: HTMLElement;
  private pps = 8;
  private clips: ClipRecord[] = [];
  private selection = new Set<string>();
  private dragging = false;

  constructor(
    root: HTMLElement,
    player: Player,
    takes: Takes,
    sync: TimingSync,
    history: History,
  ) {
    this.root = root;
    this.player = player;
    this.takes = takes;
    this.sync = sync;
    this.history = history;
    this.buildShell();

    player.events.on("time", () => this.onTime());
    player.events.on("scene", () => {
      if (!this.dragging) this.rebuild();
    });
    player.events.on("timings", () => {
      if (!this.dragging) this.rebuild();
    });
    player.events.on("loop", () => this.placeLoop());
    takes.events.on("change", () => {
      if (!this.dragging) this.rebuild();
    });

    requestAnimationFrame(() => {
      this.fit();
    });

    /* The timeline is hidden in RECORD/TUNE modes (display:none), so the
       initial fit() above measures zero width and pps clamps to its 1.5
       fallback. When the user switches to TIME the element finally has a
       width -- refit once so the project fills the viewport. We disconnect
       after the first non-zero measurement so user-initiated zoom isn't
       overwritten by later resizes. */
    let fitted = false;
    const ro = new ResizeObserver(() => {
      if (fitted) return;
      if (this.scroll.clientWidth > 0) {
        fitted = true;
        this.fit();
        ro.disconnect();
      }
    });
    ro.observe(this.scroll);
  }

  /* ------------------------------ shell --------------------------------- */

  private buildShell(): void {
    const zoomOut = el("button", { text: "−", title: "zoom out" });
    const zoomFit = el("button", { text: "fit", title: "fit whole video" });
    const zoomIn = el("button", { text: "+", title: "zoom in" });
    zoomOut.onclick = () => this.zoom(1 / 1.5);
    zoomIn.onclick = () => this.zoom(1.5);
    zoomFit.onclick = () => this.fit();

    const addLine = el("button", {
      text: "+ line",
      title: "add a narration line at the playhead",
    });
    const addCap = el("button", {
      text: "+ caption",
      title: "add a caption at the playhead",
    });
    addLine.onclick = () => this.addText("lines");
    addCap.onclick = () => this.addText("captions");

    const toolbar = el(
      "div",
      { class: "tl-toolbar" },
      el("span", { class: "tl-title", text: "TIMELINE" }),
      zoomOut,
      zoomFit,
      zoomIn,
      el("span", { class: "tl-sep" }),
      addLine,
      addCap,
      el("span", {
        class: "tl-hint",
        text:
          "drag = move (snaps, shift = free) · ctrl+click / marquee = multi-select · del = delete · dbl-click = edit text · I/O or alt+drag = loop · ctrl+wheel = zoom",
      }),
    );

    this.scroll = el("div", { class: "tl-scroll" });
    this.canvas = el("div", { class: "tl-canvas" });
    this.playhead = el("div", { class: "tl-playhead" });
    this.snapGuide = el("div", { class: "tl-snapguide" });
    this.loopEl = el("div", { class: "tl-loop" });
    this.scroll.appendChild(this.canvas);
    this.root.append(toolbar, this.scroll);

    this.scroll.addEventListener("wheel", (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const rect = this.scroll.getBoundingClientRect();
      const x = e.clientX - rect.left + this.scroll.scrollLeft;
      const t = x / this.pps;
      this.zoom(e.deltaY < 0 ? 1.2 : 1 / 1.2);
      this.scroll.scrollLeft = t * this.pps - (e.clientX - rect.left);
    }, { passive: false });
  }

  private zoom(factor: number): void {
    this.pps = Math.max(1.5, Math.min(300, this.pps * factor));
    this.rebuild();
  }

  private fit(): void {
    this.pps = Math.max(
      1.5,
      (this.scroll.clientWidth - 40) / Math.max(1, this.player.total),
    );
    this.rebuild();
  }

  /* ------------------------------ rebuild -------------------------------- */

  rebuild(): void {
    const P = this.player;
    this.clips = [];
    this.canvas.innerHTML = "";
    this.canvas.style.width = P.total * this.pps + 60 + "px";

    this.canvas.appendChild(this.buildRuler());

    for (let i = 1; i < P.project.scenes.length; i++) {
      const line = el("div", { class: "tl-grid" });
      line.style.left = P.offsets[i] * this.pps + "px";
      this.canvas.appendChild(line);
    }

    this.canvas.appendChild(this.buildScenesTrack());
    this.canvas.appendChild(
      this.buildTextTrack("SCRIPT", "tl-script", (s) => s.lines),
    );
    this.canvas.appendChild(
      this.buildTextTrack("CAPTIONS", "tl-captions", (s) => s.captions),
    );
    /* element enter/exit is scene-local, so it lives in SCENE mode now, not on
       this global timeline (which is about scene lengths + narration sync) */
    this.canvas.appendChild(this.buildTakesTrack());

    this.canvas.append(this.loopEl, this.snapGuide, this.playhead);
    this.placeLoop();
    this.onTime();

    /* empty space: click = seek + deselect, drag = marquee select, alt+drag = loop */
    this.canvas.onpointerdown = (e) => {
      const target = e.target as HTMLElement;
      if (target.closest(".tl-clip, .tl-handle, .tl-edit")) return;
      if (e.altKey) {
        this.loopDrag(e);
        return;
      }
      if (target.closest(".tl-ruler")) {
        this.seekDrag(e);
        return;
      }
      this.marqueeOrSeek(e);
    };
  }

  private timeAt(clientX: number): number {
    const rect = this.canvas.getBoundingClientRect();
    return Math.max(
      0,
      Math.min(this.player.total, (clientX - rect.left) / this.pps),
    );
  }

  private buildRuler(): HTMLElement {
    const ruler = el("div", { class: "tl-ruler" });
    const steps = [0.5, 1, 2, 5, 10, 15, 30, 60];
    const major = steps.find((s) => s * this.pps >= 64) ?? 60;
    for (let t = 0; t <= this.player.total; t += major) {
      const tick = el("div", { class: "tl-tick", text: fmt(t) });
      tick.style.left = t * this.pps + "px";
      ruler.appendChild(tick);
    }
    const minor = major / 5;
    if (minor * this.pps >= 7) {
      for (let t = 0; t <= this.player.total; t += minor) {
        if (Math.abs(t % major) < 1e-6) continue;
        const tick = el("div", { class: "tl-tick-minor" });
        tick.style.left = t * this.pps + "px";
        ruler.appendChild(tick);
      }
    }
    return ruler;
  }

  /* ---------------------------- scenes track ----------------------------- */

  private buildScenesTrack(): HTMLElement {
    const track = el(
      "div",
      { class: "tl-track tl-scenes" },
      this.label("SCENES"),
    );
    this.player.project.scenes.forEach((scene, i) => {
      const block = el(
        "div",
        { class: "tl-clip tl-scene" },
        el("span", {
          class: "tl-scenename",
          text: `${i + 1} · ${scene.title}`,
        }),
        el("span", { class: "tl-scenelen", text: fmt(scene.len) }),
      );
      const handle = el("div", {
        class: "tl-handle tl-handle-r",
        title: "drag to change scene length",
      });
      block.appendChild(handle);

      const place = (): void => {
        block.style.left = this.player.offsets[i] * this.pps + "px";
        block.style.width = Math.max(8, scene.len * this.pps - 2) + "px";
        (block.children[1] as HTMLElement).textContent = fmt(scene.len);
      };
      this.clips.push({
        div: block,
        place,
        isCurrent: () => this.player.sceneIndex === i,
        edges:
          () => [this.player.offsets[i], this.player.offsets[i] + scene.len],
      });

      block.onpointerdown = (e) => {
        if ((e.target as HTMLElement).closest(".tl-handle")) return;
        if (e.altKey) {
          this.loopDrag(e);
          return;
        }
        this.seekDrag(e);
      };
      handle.onpointerdown = (e) => {
        e.stopPropagation();
        const orig = scene.len;
        const end = this.player.offsets[i] + orig;
        this.beginDrag(e, {
          scenes: [scene],
          excluded: new Set([block]),
          edges: [end],
          apply: (delta) => {
            scene.len = Math.max(1, round(orig + delta, FINE));
          },
        });
      };
      track.appendChild(block);
      place();
    });
    return track;
  }

  /* ------------------------- script + captions --------------------------- */

  private buildTextTrack(
    name: string,
    cls: string,
    pick: (s: SceneData) => TimedText[],
  ): HTMLElement {
    const kind = cls === "tl-script" ? "line" : "caption";
    const track = el("div", { class: `tl-track ${cls}` }, this.label(name));
    this.player.project.scenes.forEach((scene, si) => {
      pick(scene).forEach((item, idx) => {
        const key = `${scene.id}|${kind}|${idx}`;
        const clip = el(
          "div",
          { class: "tl-clip tl-text", title: item.text },
          el("span", { class: "tl-cliptext", text: item.text }),
        );
        const hl = el("div", { class: "tl-handle tl-handle-l" });
        const hr = el("div", { class: "tl-handle tl-handle-r" });
        clip.append(hl, hr);

        const place = (): void => {
          clip.style.left = (this.player.offsets[si] + item.from) * this.pps +
            "px";
          clip.style.width = Math.max(6, (item.to - item.from) * this.pps - 1) +
            "px";
        };
        const record: ClipRecord = {
          div: clip,
          place,
          key,
          scene,
          isCurrent: (time) => {
            const local = time - this.player.offsets[si];
            return local >= item.from && local < item.to;
          },
          edges: () => [
            this.player.offsets[si] + item.from,
            this.player.offsets[si] + item.to,
          ],
          beginMove: () => {
            const oF = item.from, oT = item.to;
            return (delta) => {
              const d = Math.max(-oF, Math.min(scene.len - oT, delta));
              item.from = round(oF + d, FINE);
              item.to = round(oT + d, FINE);
            };
          },
          remove: () => {
            const arr = pick(scene);
            const at = arr.indexOf(item);
            if (at >= 0) arr.splice(at, 1);
          },
        };
        this.clips.push(record);

        clip.onpointerdown = (e) => {
          e.stopPropagation();
          const target = e.target as HTMLElement;
          if (target === hl || target === hr) {
            const isL = target === hl;
            const orig = isL ? item.from : item.to;
            this.beginDrag(e, {
              scenes: [scene],
              excluded: new Set([clip]),
              edges: [this.player.offsets[si] + orig],
              apply: (delta) => {
                if (isL) {
                  item.from = Math.min(
                    item.to - 0.2,
                    Math.max(0, round(orig + delta, FINE)),
                  );
                } else {item.to = Math.max(
                    item.from + 0.2,
                    Math.min(scene.len, round(orig + delta, FINE)),
                  );}
              },
            });
          } else {
            this.dragSelection(e, record);
          }
        };
        clip.ondblclick = (e) => {
          e.stopPropagation();
          this.editText(clip, scene, item);
        };
        track.appendChild(clip);
        place();
      });
    });
    return track;
  }

  /* ----------------------------- takes track ----------------------------- */

  private buildTakesTrack(): HTMLElement {
    const P = this.player;
    const track = el(
      "div",
      { class: "tl-track tl-takes" },
      this.label("VOICE"),
    );
    /* one waveform clip per section: left = line.from, width = line length;
       dragging aligns that section's take (per-file offset). */
    P.project.scenes.forEach((scene, i) => {
      scene.lines.forEach((ln) => {
        const lineId = ln.id;
        const file = lineId ? this.takes.candidate(scene.id, lineId) : null;
        if (!lineId || !file) return;
        const sect = this.takes.section(scene.id, lineId)!;
        const span = ln.to - ln.from;
        const w = Math.max(8, Math.floor(span * this.pps) - 2);
        const dpr = Math.max(1, window.devicePixelRatio ?? 1);
        const h = 36;
        const cv = el("canvas", { class: "tl-wave" }) as HTMLCanvasElement;
        cv.width = Math.min(8192, Math.round(w * dpr));
        cv.height = Math.round(h * dpr);
        cv.style.width = w + "px";
        cv.style.height = h + "px";
        const holder = el("div", { class: "tl-clip tl-take" }, cv);
        const left = (): number => P.offsets[i] + ln.from + (sect.offset || 0);
        const place = (): void => {
          holder.style.left = left() * this.pps + "px";
          holder.title = `${file} · offset ${
            (sect.offset || 0).toFixed(2)
          }s — drag to align with the line`;
        };
        this.clips.push({ div: holder, place, edges: () => [left()] });

        holder.onpointerdown = (e) => {
          e.stopPropagation();
          const orig = sect.offset || 0;
          let timer: number | undefined;
          this.beginDrag(e, {
            scenes: [],
            excluded: new Set([holder]),
            edges: [P.offsets[i] + ln.from + orig],
            apply: (delta) => {
              sect.offset = Math.max(
                -30,
                Math.min(30, round(orig + delta, FINE)),
              );
              clearTimeout(timer);
              timer = window.setTimeout(() => {
                void api.setTakeOffset(scene.id, lineId, file, sect.offset);
              }, 400);
            },
          });
        };
        track.appendChild(holder);
        place();
        void getPeaks(takeUrl(scene.id, lineId, file)).then(
          ({ peaks, duration }) => {
            if (cv.isConnected) {
              drawWaveform(cv, peaks, duration, span, "#7ee787");
            }
          },
        );
      });
    });
    return track;
  }

  /* ----------------------------- selection ------------------------------- */

  private setSelection(keys: Iterable<string>): void {
    this.selection = new Set(keys);
    for (const c of this.clips) {
      if (c.key) c.div.classList.toggle("selected", this.selection.has(c.key));
    }
  }

  deleteSelection(): void {
    const records = this.clips.filter((c) =>
      c.key && this.selection.has(c.key) && c.remove
    );
    if (!records.length) return;
    const scenes = [...new Set(records.map((r) => r.scene!))];
    const snaps = scenes.map((s) => ({ s, before: this.history.snapshot(s) }));
    records.forEach((r) => r.remove!());
    snaps.forEach(({ s, before }) => {
      this.history.commit(s, before);
      this.sync.changed(s);
    });
    this.setSelection([]);
    this.rebuild();
  }

  /* drag one clip, or the whole selection if the clip is part of it */
  private dragSelection(e: PointerEvent, grabbed: ClipRecord): void {
    if (!this.selection.has(grabbed.key!)) {
      if (e.ctrlKey || e.metaKey) {
        const next = new Set(this.selection);
        next.add(grabbed.key!);
        this.setSelection(next);
      } else {
        this.setSelection([grabbed.key!]);
      }
    } else if (e.ctrlKey || e.metaKey) {
      const next = new Set(this.selection);
      next.delete(grabbed.key!);
      this.setSelection(next);
      return;
    }
    const moving = this.clips.filter((c) =>
      c.key && this.selection.has(c.key) && c.beginMove
    );
    const movers = moving.map((c) => c.beginMove!());
    this.beginDrag(e, {
      scenes: [...new Set(moving.map((c) => c.scene!))],
      excluded: new Set(moving.map((c) => c.div)),
      edges: grabbed.edges ? grabbed.edges() : [],
      apply: (delta) => movers.forEach((m) => m(delta)),
    });
  }

  /* ------------------------------- drags --------------------------------- */

  /** one editing drag = one undoable transaction, snapped while it runs */
  private beginDrag(e: PointerEvent, spec: {
    scenes: SceneData[];
    excluded: Set<HTMLElement>;
    edges: number[];
    apply: (delta: number) => void;
  }): void {
    this.dragging = true;
    const startX = e.clientX;
    const snaps = spec.scenes.map((s) => ({
      s,
      before: this.history.snapshot(s),
    }));
    const targets = this.snapTargets(spec.excluded);
    let moved = false;
    this.capture(e, (ev) => {
      /* sub-threshold jitter isn't a drag: skipping the rebuild on a plain
         click keeps the clip div alive so a double-click can land on it */
      if (!moved && Math.abs(ev.clientX - startX) < 3) return;
      moved = true;
      const raw = (ev.clientX - startX) / this.pps;
      const delta = this.snapDelta(raw, spec.edges, targets, ev.shiftKey);
      spec.apply(delta);
      spec.scenes.forEach((s) => this.sync.changed(s));
      this.placeAll();
    }, () => {
      this.dragging = false;
      this.snapGuide.style.display = "none";
      if (moved) {
        snaps.forEach(({ s, before }) => this.history.commit(s, before));
        this.rebuild();
      }
    });
  }

  /** snap candidates: playhead, video bounds, scene bounds, loop, clip edges */
  private snapTargets(excluded: Set<HTMLElement>): number[] {
    const P = this.player;
    const targets = [0, P.total, P.time, ...P.offsets.slice(1)];
    if (P.loop) targets.push(P.loop.start, P.loop.end);
    for (const c of this.clips) {
      if (!c.edges || excluded.has(c.div)) continue;
      targets.push(...c.edges());
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
      return round(raw, FINE);
    }
    const thresh = 8 / this.pps;
    let best: { delta: number; target: number; dist: number } | null = null;
    for (const edge of edges) {
      for (const target of targets) {
        const delta = target - edge;
        const dist = Math.abs(raw - delta);
        if (dist < thresh && (!best || dist < best.dist)) {
          best = { delta, target, dist };
        }
      }
    }
    if (best) {
      this.snapGuide.style.left = best.target * this.pps + "px";
      this.snapGuide.style.display = "block";
      return best.delta;
    }
    this.snapGuide.style.display = "none";
    return round(raw, GRID);
  }

  /* ---------------------- seek / loop / marquee drags -------------------- */

  private seekDrag(e: PointerEvent): void {
    /* Flag the timeline as `dragging` so the player's "scene" event handler
       (fired when the playhead crosses a scene boundary) does NOT rebuild the
       canvas mid-drag. A rebuild swaps out this.canvas's children, which
       drops the pointer-capture target and silently kills the drag.

       The ELEMENTS track only shows the current scene though, so if the user
       scrubbed across a boundary it would be stale until the next rebuild
       trigger. Remember the scene we started in and rebuild on drag-end if
       it changed. */
    this.dragging = true;
    const startScene = this.player.sceneIndex;
    const seek = (ev: PointerEvent): void =>
      this.player.seek(this.timeAt(ev.clientX));
    seek(e);
    this.capture(e, seek, () => {
      this.dragging = false;
      if (this.player.sceneIndex !== startScene) this.rebuild();
    });
  }

  private loopDrag(e: PointerEvent): void {
    const start = this.timeAt(e.clientX);
    this.capture(
      e,
      (ev) => this.player.setLoop({ start, end: this.timeAt(ev.clientX) }),
      () => {},
    );
  }

  private marqueeOrSeek(e: PointerEvent): void {
    const startX = e.clientX, startY = e.clientY;
    const canvasRect = this.canvas.getBoundingClientRect();
    let marquee: HTMLElement | null = null;
    const additive = e.ctrlKey || e.metaKey;
    const baseSelection = additive
      ? new Set(this.selection)
      : new Set<string>();
    this.capture(e, (ev) => {
      if (
        !marquee && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5
      ) return;
      if (!marquee) {
        marquee = el("div", { class: "tl-marquee" });
        this.canvas.appendChild(marquee);
      }
      const x1 = Math.min(startX, ev.clientX) - canvasRect.left;
      const x2 = Math.max(startX, ev.clientX) - canvasRect.left;
      const y1 = Math.min(startY, ev.clientY) - canvasRect.top;
      const y2 = Math.max(startY, ev.clientY) - canvasRect.top;
      Object.assign(marquee.style, {
        left: x1 + "px",
        top: y1 + "px",
        width: x2 - x1 + "px",
        height: y2 - y1 + "px",
      });
      const next = new Set(baseSelection);
      for (const c of this.clips) {
        if (!c.key) continue;
        const r = c.div.getBoundingClientRect();
        const cx1 = r.left - canvasRect.left, cx2 = r.right - canvasRect.left;
        const cy1 = r.top - canvasRect.top, cy2 = r.bottom - canvasRect.top;
        if (cx1 < x2 && cx2 > x1 && cy1 < y2 && cy2 > y1) next.add(c.key);
      }
      this.setSelection(next);
    }, () => {
      if (marquee) {
        marquee.remove();
      } else {
        this.player.seek(this.timeAt(startX));
        this.setSelection([]);
      }
    });
  }

  /* --------------------------- inline text edit -------------------------- */

  private editText(clip: HTMLElement, scene: SceneData, item: TimedText): void {
    if (clip.querySelector(".tl-edit")) return;
    const input = el("input", {
      class: "tl-edit",
      type: "text",
    }) as HTMLInputElement;
    input.value = item.text;
    input.onpointerdown = (e) => e.stopPropagation();
    const finish = (commit: boolean): void => {
      input.remove();
      if (!commit || input.value === item.text) {
        this.rebuild();
        return;
      }
      const before = this.history.snapshot(scene);
      item.text = input.value;
      this.history.commit(scene, before);
      this.sync.changed(scene);
      this.rebuild();
    };
    input.onblur = () => finish(true);
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
    };
    clip.appendChild(input);
    input.focus();
    input.select();
  }

  /* ------------------------------ add clips ------------------------------ */

  private addText(kind: "lines" | "captions"): void {
    const scene = this.player.scene;
    const at = Math.min(
      Math.max(0, this.player.localTime),
      Math.max(0, scene.len - 0.5),
    );
    const item: TimedText = {
      from: round(at, GRID),
      to: round(Math.min(scene.len, at + 3), GRID),
      text: kind === "lines" ? "new narration line" : "new caption",
    };
    const before = this.history.snapshot(scene);
    const arr = scene[kind];
    const insertAt = arr.findIndex((x) => x.from > item.from);
    arr.splice(insertAt < 0 ? arr.length : insertAt, 0, item);
    this.history.commit(scene, before);
    this.sync.changed(scene);
    this.rebuild();
    /* open the editor on the new clip right away */
    const idx = arr.indexOf(item);
    const key = `${scene.id}|${kind === "lines" ? "line" : "caption"}|${idx}`;
    this.setSelection([key]);
    const rec = this.clips.find((c) => c.key === key);
    if (rec) this.editText(rec.div, scene, item);
  }

  /* ------------------------------ helpers -------------------------------- */

  private label(text: string): HTMLElement {
    return el("div", { class: "tl-label", text });
  }

  private placeAll(): void {
    for (const c of this.clips) c.place();
  }

  private placeLoop(): void {
    const loop = this.player.loop;
    if (!loop) {
      this.loopEl.style.display = "none";
      return;
    }
    this.loopEl.style.display = "block";
    this.loopEl.style.left = loop.start * this.pps + "px";
    this.loopEl.style.width = (loop.end - loop.start) * this.pps + "px";
  }

  private capture(
    e: PointerEvent,
    onMove: (ev: PointerEvent) => void,
    onUp: () => void,
  ): void {
    const target = e.target as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent): void => onMove(ev);
    const up = (): void => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      onUp();
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  }

  /* ------------------------------ per tick ------------------------------- */

  private onTime(): void {
    /* The ELEMENTS track shows only the current scene, so it must follow scene
       changes — but the 'scene' event already drives that rebuild (and so do
       seeks, since they mount too). onTime stays a cheap per-frame update:
       move the playhead and refresh clip classes only. */
    const x = this.player.time * this.pps;
    this.playhead.style.left = x + "px";
    for (const c of this.clips) {
      if (c.isCurrent) {
        c.div.classList.toggle("current", c.isCurrent(this.player.time));
      }
      if (c.key) c.div.classList.toggle("selected", this.selection.has(c.key));
    }
    if (this.player.playing) {
      const left = this.scroll.scrollLeft;
      const w = this.scroll.clientWidth;
      if (x < left + 40 || x > left + w * 0.85) {
        this.scroll.scrollLeft = Math.max(0, x - w * 0.15);
      }
    }
  }
}

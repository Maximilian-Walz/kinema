import { Emitter } from '../emitter';
import type { ProjectData, SceneData } from '../types';

/* ============================================================================
   Playback engine. One global clock over all scenes; everything on the stage
   is a pure function of the clock, so scrubbing works in both directions.
   The engine owns the #scenecontent element and the per-scene <style> tag.
============================================================================ */

export interface SceneCursor {
  index: number;
  local: number;
}

export class Player {
  readonly project: ProjectData;
  readonly events = new Emitter<{
    time: [];          // after every update
    scene: [number];   // a different scene was mounted
    play: [boolean];
    timings: [];       // lens / offsets changed
    ended: [];
    loop: [];          // loop region changed
  }>();

  offsets: number[] = [];
  total = 0;

  time = 0;
  playing = false;
  loop: { start: number; end: number } | null = null;
  private mounted = -1;
  private lastFrame: number | null = null;
  private threadScroll = 0;
  /* id -> element in the mounted scene; the scene HTML is static between
     mounts, so resolving once per mount avoids a querySelector per scheduled
     element on every frame. null means "looked up, not present". */
  private elCache = new Map<string, HTMLElement | null>();
  /* "id class" pairs the schedule currently drives on; lets update() clear a
     class once no entry asks for it (e.g. an entry deleted from the schedule) */
  private driven = new Set<string>();

  private readonly content: HTMLElement;
  private readonly sceneStyle: HTMLStyleElement;

  constructor(project: ProjectData, content: HTMLElement, sceneStyle: HTMLStyleElement) {
    this.project = project;
    this.content = content;
    this.sceneStyle = sceneStyle;
    this.recomputeOffsets();
    requestAnimationFrame(this.frame);
  }

  /* ------------------------------ geometry ------------------------------ */

  recomputeOffsets(): void {
    let acc = 0;
    this.offsets = this.project.scenes.map((s) => { const o = acc; acc += s.len; return o; });
    this.total = acc;
  }

  /** call after any timing mutation (len, schedule, lines, captions) */
  refreshTimings(): void {
    this.recomputeOffsets();
    this.update(Math.min(this.time, this.total));
    this.events.emit('timings');
  }

  cursor(time = this.time): SceneCursor {
    const scenes = this.project.scenes;
    for (let i = scenes.length - 1; i >= 0; i--) {
      if (time >= this.offsets[i]) {
        return { index: i, local: Math.min(time - this.offsets[i], scenes[i].len) };
      }
    }
    return { index: 0, local: 0 };
  }

  get sceneIndex(): number { return this.cursor().index; }
  get scene(): SceneData { return this.project.scenes[this.cursor().index]; }
  get localTime(): number { return this.cursor().local; }

  /* ------------------------------ playback ------------------------------ */

  setPlaying(p: boolean): void {
    if (this.playing === p) return;
    this.playing = p;
    this.events.emit('play', p);
  }

  toggle(): void { this.setPlaying(!this.playing); }

  setLoop(loop: { start: number; end: number } | null): void {
    if (loop) {
      const start = Math.max(0, Math.min(loop.start, loop.end));
      const end = Math.min(this.total, Math.max(loop.start, loop.end));
      this.loop = end - start > 0.2 ? { start, end } : null;
    } else {
      this.loop = null;
    }
    this.events.emit('loop');
  }

  seek(time: number): void { this.update(time); }

  seekScene(index: number, local = 0): void {
    const i = Math.max(0, Math.min(this.project.scenes.length - 1, index));
    this.update(this.offsets[i] + local);
  }

  restartScene(): void {
    this.seekScene(this.cursor().index);
    this.setPlaying(true);
  }

  /* ------------------------------- update ------------------------------- */

  update(time: number): void {
    this.time = Math.max(0, Math.min(this.total, time));
    const { index, local } = this.cursor();
    if (index !== this.mounted) this.mount(index);

    const scene = this.project.scenes[index];

    // element states, derived purely from local t. Track which (id, class)
    // pairs we drive on so we can clear any we no longer own — covers an
    // entry whose window has passed (handled by the toggle below) and, more
    // importantly, an entry deleted from the schedule outright: it is simply
    // never visited here, so it drops out of `nextOn` and gets removed in the
    // reconciliation pass instead of lingering until the next remount.
    const nextOn = new Set<string>();
    for (const ev of scene.schedule) {
      const cls = ev.cls || 'on';
      const el = this.resolve(ev.id);
      if (!el) continue;
      const on = local >= ev.enter && (ev.exit === undefined || local < ev.exit);
      el.classList.toggle(cls, on);
      if (on) nextOn.add(ev.id + '\u0000' + cls);
    }
    for (const key of this.driven) {
      if (nextOn.has(key)) continue;
      const i = key.indexOf('\u0000');
      this.resolve(key.slice(0, i))?.classList.remove(key.slice(i + 1));
    }
    this.driven = nextOn;

    // caption strip (scene-owned element, may not exist)
    const capEl = this.resolve('caption');
    if (capEl) {
      const cap = scene.captions.find((c) => local >= c.from && local < c.to);
      capEl.textContent = cap ? cap.text : '';
      capEl.classList.toggle('on', !!cap);
    }

    this.events.emit('time');
  }

  private mount(index: number): void {
    this.mounted = index;
    const scene = this.project.scenes[index];
    this.sceneStyle.textContent = scene.css;
    this.content.innerHTML = scene.html;
    this.elCache.clear(); // new DOM; drop the previous scene's element lookups
    this.driven.clear();  // fresh markup carries none of the old classes
    this.threadScroll = 0;
    this.events.emit('scene', index);
  }

  /** cached `getElementById` within the mounted scene (see elCache) */
  private resolve(id: string): HTMLElement | null {
    let el = this.elCache.get(id);
    if (el === undefined) {
      el = this.content.querySelector<HTMLElement>('#' + CSS.escape(id));
      this.elCache.set(id, el);
    }
    return el;
  }

  /* ------------------------------- rAF loop ------------------------------ */

  private frame = (now: number): void => {
    if (this.lastFrame === null) this.lastFrame = now;
    const dt = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    if (this.playing) {
      const next = this.time + dt;
      if (this.loop && this.time < this.loop.end && next >= this.loop.end) {
        this.update(this.loop.start);
      } else {
        this.update(next);
      }
      if (this.time >= this.total) {
        this.setPlaying(false);
        this.events.emit('ended');
      }
    }
    this.runBehaviors();
    requestAnimationFrame(this.frame);
  };

  /* scene-declared behaviors, run every frame */
  private runBehaviors(): void {
    const scene = this.project.scenes[this.mounted];
    if (!scene) return;
    if (scene.behaviors.includes('thread-autoscroll')) this.threadAutoscroll();
  }

  /** keep the newest visible message in view (debate thread) */
  private threadAutoscroll(): void {
    const view = this.resolve('threadview');
    const col = this.resolve('threadcol');
    if (!view || !col) return;
    let bottom = 0;
    for (const child of Array.from(col.children) as HTMLElement[]) {
      if (child.classList.contains('on')) {
        bottom = Math.max(bottom, child.offsetTop + child.offsetHeight);
      }
    }
    const target = Math.min(0, view.clientHeight - bottom - 30);
    this.threadScroll += (target - this.threadScroll) * 0.12;
    col.style.transform = `translateY(${this.threadScroll}px)`;
  }
}

export const fmt = (s: number): string =>
  String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(Math.floor(s % 60)).padStart(2, '0');

export const fmtMs = (s: number): string => fmt(s) + '.' + Math.floor((s % 1) * 10);

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

    // element states, derived purely from local t
    for (const ev of scene.schedule) {
      const el = this.content.querySelector<HTMLElement>('#' + CSS.escape(ev.id));
      if (!el) continue;
      const on = local >= ev.enter && (ev.exit === undefined || local < ev.exit);
      el.classList.toggle(ev.cls || 'on', on);
    }

    // caption strip (scene-owned element, may not exist)
    const capEl = this.content.querySelector<HTMLElement>('#caption');
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
    this.threadScroll = 0;
    this.events.emit('scene', index);
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
    const view = this.content.querySelector<HTMLElement>('#threadview');
    const col = this.content.querySelector<HTMLElement>('#threadcol');
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

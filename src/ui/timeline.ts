import { takeUrl } from '../api';
import type { Takes } from '../audio/takes';
import { drawWaveform, getPeaks } from '../audio/waveform';
import { fmt, type Player } from '../engine/player';
import type { TimingSync } from '../timings';
import type { SceneData, TimedText } from '../types';
import { el } from './dom';

/* ============================================================================
   Timeline editor. Tracks, top to bottom:
     ruler      time ticks, click/drag to seek
     SCENES     one block per scene, drag the right edge to change its length
     SCRIPT     narration lines as clips — drag to move, drag edges to retime
     CAPTIONS   lower-third captions, same interactions
     ELEMENTS   the current scene's schedule (point markers fire and stay on,
                spans have an exit) — drag to retime
     TAKES      picked take waveform per scene

   All edits go through TimingSync (engine refresh + debounced write into the
   scene's scene.json). ctrl+wheel zooms, click anywhere empty seeks.
============================================================================ */

const SNAP = 0.1;
const snap = (v: number): number => Math.round(v / SNAP) * SNAP;

interface ClipRecord {
  div: HTMLElement;
  place: () => void;              // re-apply left/width from the model
  isCurrent?: (time: number) => boolean;
}

export class Timeline {
  private readonly player: Player;
  private readonly takes: Takes;
  private readonly sync: TimingSync;

  private readonly root: HTMLElement;
  private scroll!: HTMLElement;
  private canvas!: HTMLElement;
  private playhead!: HTMLElement;
  private pps = 8;                // pixels per second
  private clips: ClipRecord[] = [];
  private dragging = false;
  private builtForScene = -1;

  constructor(root: HTMLElement, player: Player, takes: Takes, sync: TimingSync) {
    this.root = root;
    this.player = player;
    this.takes = takes;
    this.sync = sync;
    this.buildShell();

    player.events.on('time', () => this.onTime());
    player.events.on('scene', () => this.rebuild());
    player.events.on('timings', () => { if (!this.dragging) this.rebuild(); });
    takes.events.on('change', () => this.rebuild());

    requestAnimationFrame(() => { this.fit(); });
  }

  /* ------------------------------ shell --------------------------------- */

  private buildShell(): void {
    const zoomOut = el('button', { text: '−', title: 'zoom out' });
    const zoomFit = el('button', { text: 'fit', title: 'fit whole video' });
    const zoomIn = el('button', { text: '+', title: 'zoom in' });
    zoomOut.onclick = () => this.zoom(1 / 1.5);
    zoomIn.onclick = () => this.zoom(1.5);
    zoomFit.onclick = () => this.fit();

    const toolbar = el('div', { class: 'tl-toolbar' },
      el('span', { class: 'tl-title', text: 'TIMELINE' }),
      zoomOut, zoomFit, zoomIn,
      el('span', { class: 'tl-hint', text: 'drag clips to retime · drag edges · ctrl+wheel zoom · click to seek' }),
    );

    this.scroll = el('div', { class: 'tl-scroll' });
    this.canvas = el('div', { class: 'tl-canvas' });
    this.playhead = el('div', { class: 'tl-playhead' });
    this.scroll.appendChild(this.canvas);
    this.root.append(toolbar, this.scroll);

    this.scroll.addEventListener('wheel', (e) => {
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
    this.pps = Math.max(1.5, (this.scroll.clientWidth - 40) / Math.max(1, this.player.total));
    this.rebuild();
  }

  /* ------------------------------ rebuild -------------------------------- */

  rebuild(): void {
    const P = this.player;
    this.clips = [];
    this.canvas.innerHTML = '';
    this.canvas.style.width = P.total * this.pps + 60 + 'px';
    this.builtForScene = P.sceneIndex;

    this.canvas.appendChild(this.buildRuler());

    /* scene boundary grid lines, behind everything */
    for (let i = 1; i < P.project.scenes.length; i++) {
      const line = el('div', { class: 'tl-grid' });
      line.style.left = P.offsets[i] * this.pps + 'px';
      this.canvas.appendChild(line);
    }

    this.canvas.appendChild(this.buildScenesTrack());
    this.canvas.appendChild(this.buildTextTrack('SCRIPT', 'tl-script', (s) => s.lines, true));
    this.canvas.appendChild(this.buildTextTrack('CAPTIONS', 'tl-captions', (s) => s.captions, false));
    this.canvas.appendChild(this.buildElementsTrack());
    this.canvas.appendChild(this.buildTakesTrack());

    this.canvas.appendChild(this.playhead);
    this.onTime();

    /* click/drag on empty space = seek */
    this.canvas.onpointerdown = (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('.tl-clip, .tl-handle, .tl-marker')) return;
      const seek = (ev: PointerEvent): void => {
        const rect = this.canvas.getBoundingClientRect();
        this.player.seek((ev.clientX - rect.left) / this.pps);
      };
      seek(e);
      this.capture(e, seek, () => {});
    };
  }

  private buildRuler(): HTMLElement {
    const ruler = el('div', { class: 'tl-ruler' });
    const steps = [0.5, 1, 2, 5, 10, 15, 30, 60];
    const major = steps.find((s) => s * this.pps >= 64) ?? 60;
    for (let t = 0; t <= this.player.total; t += major) {
      const tick = el('div', { class: 'tl-tick', text: fmt(t) });
      tick.style.left = t * this.pps + 'px';
      ruler.appendChild(tick);
    }
    const minor = major / 5;
    if (minor * this.pps >= 7) {
      for (let t = 0; t <= this.player.total; t += minor) {
        if (Math.abs(t % major) < 1e-6) continue;
        const tick = el('div', { class: 'tl-tick-minor' });
        tick.style.left = t * this.pps + 'px';
        ruler.appendChild(tick);
      }
    }
    return ruler;
  }

  /* ---------------------------- scenes track ----------------------------- */

  private buildScenesTrack(): HTMLElement {
    const track = el('div', { class: 'tl-track tl-scenes' }, this.label('SCENES'));
    this.player.project.scenes.forEach((scene, i) => {
      const block = el('div', { class: 'tl-clip tl-scene' },
        el('span', { class: 'tl-scenename', text: `${i + 1} · ${scene.title}` }),
        el('span', { class: 'tl-scenelen', text: fmt(scene.len) }),
      );
      const handle = el('div', { class: 'tl-handle tl-handle-r', title: 'drag to change scene length' });
      block.appendChild(handle);

      const place = (): void => {
        block.style.left = this.player.offsets[i] * this.pps + 'px';
        block.style.width = Math.max(8, scene.len * this.pps - 2) + 'px';
        (block.children[1] as HTMLElement).textContent = fmt(scene.len);
      };
      this.clips.push({ div: block, place, isCurrent: () => this.player.sceneIndex === i });

      /* click on the block seeks (uniform with empty space) */
      block.onpointerdown = (e) => {
        if ((e.target as HTMLElement).closest('.tl-handle')) return;
        const rect = this.canvas.getBoundingClientRect();
        this.player.seek((e.clientX - rect.left) / this.pps);
      };
      handle.onpointerdown = (e) => {
        e.stopPropagation();
        const orig = scene.len;
        this.beginDrag(e,
          (dx) => {
            scene.len = Math.max(1, snap(orig + dx));
            this.sync.changed(scene);
            this.placeAll();
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
    seekOnClick: boolean,
  ): HTMLElement {
    const track = el('div', { class: `tl-track ${cls}` }, this.label(name));
    this.player.project.scenes.forEach((scene, si) => {
      pick(scene).forEach((item) => {
        const clip = el('div', { class: 'tl-clip tl-text', title: item.text },
          el('span', { class: 'tl-cliptext', text: item.text }));
        const hl = el('div', { class: 'tl-handle tl-handle-l' });
        const hr = el('div', { class: 'tl-handle tl-handle-r' });
        clip.append(hl, hr);

        const place = (): void => {
          clip.style.left = (this.player.offsets[si] + item.from) * this.pps + 'px';
          clip.style.width = Math.max(6, (item.to - item.from) * this.pps - 1) + 'px';
        };
        this.clips.push({
          div: clip, place,
          isCurrent: (time) => {
            const local = time - this.player.offsets[si];
            return local >= item.from && local < item.to;
          },
        });

        clip.onpointerdown = (e) => {
          e.stopPropagation();
          const target = e.target as HTMLElement;
          const oFrom = item.from, oTo = item.to;
          let moved = false;
          const apply = (dx: number): void => {
            moved = moved || Math.abs(dx) > 0.04;
            if (target === hl) {
              item.from = Math.min(oTo - 0.2, Math.max(0, snap(oFrom + dx)));
            } else if (target === hr) {
              item.to = Math.max(oFrom + 0.2, Math.min(scene.len, snap(oTo + dx)));
            } else {
              const d = Math.max(-oFrom, Math.min(scene.len - oTo, dx));
              item.from = snap(oFrom + d);
              item.to = snap(oTo + d);
            }
            this.sync.changed(scene);
            this.placeAll();
          };
          this.beginDrag(e, apply, () => {
            if (!moved && seekOnClick) this.player.seek(this.player.offsets[si] + item.from);
          });
        };
        track.appendChild(clip);
        place();
      });
    });
    return track;
  }

  /* --------------------------- elements track ---------------------------- */

  private buildElementsTrack(): HTMLElement {
    const P = this.player;
    const si = P.sceneIndex;
    const scene = P.project.scenes[si];
    const track = el('div', { class: 'tl-track tl-elements' },
      this.label(`ELEMENTS · scene ${si + 1}`));

    /* greedy lane packing; point markers reserve room for their label */
    const lanes: number[] = []; // per lane: end time (in px) of last clip
    const entries = scene.schedule.map((ev) => {
      const isSpan = ev.exit !== undefined;
      const name = ev.id + (ev.cls && ev.cls !== 'on' ? '.' + ev.cls : '');
      const startPx = (P.offsets[si] + ev.enter) * this.pps;
      const widthPx = isSpan
        ? Math.max(10, (ev.exit! - ev.enter) * this.pps)
        : name.length * 6.6 + 18;
      let lane = lanes.findIndex((end) => end <= startPx + 0.5);
      if (lane < 0) { lane = lanes.length; lanes.push(0); }
      lanes[lane] = startPx + widthPx + 6;
      return { ev, isSpan, name, lane };
    });
    track.style.height = 26 + Math.max(1, lanes.length) * 20 + 'px';

    for (const { ev, isSpan, name, lane } of entries) {
      const clip = el('div', {
        class: 'tl-clip tl-element' + (isSpan ? '' : ' tl-marker'),
        title: name + ` · in ${ev.enter}s` + (isSpan ? ` · out ${ev.exit}s` : ' (stays on)'),
      }, el('span', { class: 'tl-cliptext', text: name }));
      let hl: HTMLElement | null = null, hr: HTMLElement | null = null;
      if (isSpan) {
        hl = el('div', { class: 'tl-handle tl-handle-l' });
        hr = el('div', { class: 'tl-handle tl-handle-r' });
        clip.append(hl, hr);
      }

      const place = (): void => {
        clip.style.left = (P.offsets[si] + ev.enter) * this.pps + 'px';
        clip.style.top = 24 + lane * 20 + 'px';
        if (isSpan) clip.style.width = Math.max(8, (ev.exit! - ev.enter) * this.pps - 1) + 'px';
      };
      this.clips.push({
        div: clip, place,
        isCurrent: (time) => {
          const local = time - P.offsets[si];
          return local >= ev.enter && (ev.exit === undefined || local < ev.exit);
        },
      });

      clip.onpointerdown = (e) => {
        e.stopPropagation();
        const target = e.target as HTMLElement;
        const oEnter = ev.enter, oExit = ev.exit;
        this.beginDrag(e, (dx) => {
          if (target === hl) {
            ev.enter = Math.min((oExit ?? scene.len) - 0.1, Math.max(0, snap(oEnter + dx)));
          } else if (target === hr) {
            ev.exit = Math.max(oEnter + 0.1, Math.min(scene.len, snap(oExit! + dx)));
          } else {
            const d = Math.max(-oEnter, dx);
            ev.enter = snap(oEnter + d);
            if (oExit !== undefined) ev.exit = Math.min(scene.len, snap(oExit + d));
          }
          this.sync.changed(scene);
          this.placeAll();
        });
      };
      track.appendChild(clip);
      place();
    }
    return track;
  }

  /* ----------------------------- takes track ----------------------------- */

  private buildTakesTrack(): HTMLElement {
    const P = this.player;
    const track = el('div', { class: 'tl-track tl-takes' }, this.label('VOICE'));
    P.project.scenes.forEach((scene, i) => {
      const file = this.takes.candidate(scene.id);
      if (!file) return;
      const w = Math.max(8, Math.floor(scene.len * this.pps) - 2);
      const cv = el('canvas', { class: 'tl-wave' }) as HTMLCanvasElement;
      cv.width = Math.min(8192, w);
      cv.height = 36;
      cv.style.width = w + 'px';
      const holder = el('div', { class: 'tl-clip tl-take', title: file }, cv);
      const place = (): void => { holder.style.left = P.offsets[i] * this.pps + 'px'; };
      this.clips.push({ div: holder, place });
      track.appendChild(holder);
      place();
      void getPeaks(takeUrl(scene.id, file)).then(({ peaks, duration }) => {
        if (cv.isConnected) drawWaveform(cv, peaks, duration, scene.len, '#7ee787');
      });
    });
    return track;
  }

  /* ------------------------------ helpers -------------------------------- */

  private label(text: string): HTMLElement {
    return el('div', { class: 'tl-label', text });
  }

  private placeAll(): void {
    for (const c of this.clips) c.place();
  }

  /** pointer-capture drag: cb gets dx in seconds (snapped by the caller) */
  private beginDrag(
    e: PointerEvent,
    onMove: (dxSeconds: number) => void,
    onEnd?: () => void,
  ): void {
    this.dragging = true;
    const startX = e.clientX;
    this.capture(e,
      (ev) => onMove((ev.clientX - startX) / this.pps),
      () => {
        this.dragging = false;
        onEnd?.();
        this.rebuild();
      });
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
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      onUp();
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }

  /* ------------------------------ per tick ------------------------------- */

  private onTime(): void {
    if (this.builtForScene !== this.player.sceneIndex && !this.dragging) {
      this.rebuild();
      return;
    }
    const x = this.player.time * this.pps;
    this.playhead.style.left = x + 'px';
    for (const c of this.clips) {
      if (c.isCurrent) c.div.classList.toggle('current', c.isCurrent(this.player.time));
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

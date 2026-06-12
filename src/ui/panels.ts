import * as api from '../api';
import type { Takes } from '../audio/takes';
import { fmt, type Player } from '../engine/player';
import type { History } from '../history';
import type { TimingSync } from '../timings';
import { el } from './dom';

/* ============================================================================
   Side panel: SCRIPT (teleprompter), TAKES, EXPORT tabs.
   Recording auto-switches to SCRIPT so the narration is readable while
   speaking; a red bar with the stop button stays visible.
============================================================================ */

type Tab = 'script' | 'takes' | 'export';

export class SidePanel {
  private readonly player: Player;
  private readonly takes: Takes;
  private readonly sync: TimingSync;
  private readonly history: History;
  private readonly body: HTMLElement;
  private readonly tabButtons = new Map<Tab, HTMLButtonElement>();
  private readonly recBar: HTMLElement;
  private tab: Tab = 'script';
  private pollTimer: number | undefined;

  constructor(root: HTMLElement, player: Player, takes: Takes, sync: TimingSync, history: History) {
    this.player = player;
    this.takes = takes;
    this.sync = sync;
    this.history = history;

    const nav = el('div', { class: 'sp-tabs' });
    (['script', 'takes', 'export'] as Tab[]).forEach((t) => {
      const b = el('button', { text: t.toUpperCase() });
      b.onclick = () => this.show(t);
      this.tabButtons.set(t, b);
      nav.appendChild(b);
    });

    this.recBar = el('div', { class: 'sp-recbar' },
      el('span', { class: 'sp-recdot' }), 'recording take — ');
    const stop = el('button', { text: '■ stop' });
    stop.onclick = () => takes.stopRecording();
    this.recBar.appendChild(stop);
    this.recBar.style.display = 'none';

    this.body = el('div', { class: 'sp-body' });
    root.append(nav, this.recBar, this.body);

    player.events.on('scene', () => this.render());
    player.events.on('time', () => this.tick());
    player.events.on('timings', () => { if (this.tab === 'script') this.render(); });
    takes.events.on('change', () => { if (this.tab === 'takes') this.render(); });
    takes.events.on('recording', (on) => {
      this.recBar.style.display = on ? 'flex' : 'none';
      if (on) this.show('script');
      else if (this.tab === 'takes') this.render();
    });

    this.show('script');
    this.resumeExportPollIfRunning();
  }

  show(tab: Tab): void {
    this.tab = tab;
    this.tabButtons.forEach((b, t) => b.classList.toggle('active', t === tab));
    this.render();
  }

  /* ------------------------------- render -------------------------------- */

  private render(): void {
    this.body.innerHTML = '';
    if (this.tab === 'script') this.renderScript();
    else if (this.tab === 'takes') this.renderTakes();
    else this.renderExport();
  }

  /* SCRIPT ----------------------------------------------------------------- */

  private lineEls: { div: HTMLElement; from: number; to: number }[] = [];

  private renderScript(): void {
    const scene = this.player.scene;
    const si = this.player.sceneIndex;
    this.lineEls = [];
    this.body.appendChild(el('div', { class: 'sp-scenetitle', text: `${si + 1} · ${scene.title}` }));
    const list = el('div', { class: 'sp-lines' });
    scene.lines.forEach((ln) => {
      const div = el('div', { class: 'sp-line', title: 'click = jump · double-click = edit' },
        el('span', { class: 'sp-linetime', text: `${fmt(ln.from)} – ${fmt(ln.to)}` }),
        ln.text);
      div.onclick = () => this.player.seek(this.player.offsets[si] + ln.from);
      div.ondblclick = () => {
        if (div.querySelector('textarea')) return;
        const ta = el('textarea', { class: 'sp-edit' }) as HTMLTextAreaElement;
        ta.value = ln.text;
        ta.onclick = (e) => e.stopPropagation();
        const finish = (commit: boolean): void => {
          if (commit && ta.value !== ln.text) {
            const before = this.history.snapshot(scene);
            ln.text = ta.value;
            this.history.commit(scene, before);
            this.sync.changed(scene);
          }
          this.render();
        };
        ta.onblur = () => finish(true);
        ta.onkeydown = (e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true); }
          else if (e.key === 'Escape') finish(false);
        };
        div.appendChild(ta);
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      };
      list.appendChild(div);
      this.lineEls.push({ div, from: ln.from, to: ln.to });
    });
    this.body.appendChild(list);
  }

  /* TAKES ------------------------------------------------------------------ */

  private renderTakes(): void {
    const scene = this.player.scene;
    const rec = el('button', {
      class: 'sp-rec' + (this.takes.recording ? ' live' : ''),
      text: this.takes.recording ? '■ stop recording' : '● record take (restarts scene)',
    });
    rec.onclick = async () => {
      if (this.takes.recording) { this.takes.stopRecording(); return; }
      const err = await this.takes.startRecording();
      if (err) this.status(err);
    };
    this.body.appendChild(el('div', { class: 'sp-scenetitle', text: `takes · ${scene.title}` }));
    this.body.appendChild(rec);

    const info = this.takes.map[scene.id];
    const list = el('div', { class: 'sp-takes' });
    if (!info || !info.takes.length) {
      list.appendChild(el('div', { class: 'sp-dim', text: 'no takes yet for this scene' }));
    } else {
      info.takes.forEach((tk, n) => {
        const row = el('div', { class: 'sp-take' + (tk.file === info.candidate ? ' cand' : '') });
        const play = el('button', { text: this.takes.auditioning === tk.file ? '⏸' : '▶' });
        play.onclick = () => this.takes.toggleAudition(scene.id, tk.file);
        const name = el('span', {
          class: 'sp-takename',
          text: `take ${n + 1} · ${new Date(tk.created).toLocaleTimeString()}`,
          title: tk.file,
        });
        const star = el('button', {
          class: 'sp-star',
          text: tk.file === info.candidate ? '★' : '☆',
          title: 'pick as the take used in preview and export',
        });
        star.onclick = async () => { await api.pickTake(scene.id, tk.file); await this.takes.refresh(); };
        const del = el('button', { text: '✕', title: 'move to trash' });
        del.onclick = async () => {
          if (!confirm('Move this take to trash?')) return;
          await api.deleteTake(scene.id, tk.file);
          await this.takes.refresh();
        };
        row.append(play, name, star, del);
        list.appendChild(row);
      });
    }
    this.body.appendChild(list);

    const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
    cb.checked = this.takes.previewEnabled;
    cb.onchange = () => this.takes.setPreviewEnabled(cb.checked);
    this.body.appendChild(el('label', { class: 'sp-checkbox' }, cb, ' play picked takes during playback'));
    this.body.appendChild(el('div', { class: 'sp-status' }));
  }

  /* EXPORT ----------------------------------------------------------------- */

  private renderExport(): void {
    this.body.appendChild(el('div', { class: 'sp-scenetitle', text: 'export MP4' }));

    const fps = el('select', {},
      el('option', { value: '15', text: '15 fps draft' }),
      el('option', { value: '30', text: '30 fps', selected: '' }),
      el('option', { value: '60', text: '60 fps' }),
    ) as HTMLSelectElement;

    const sceneBtn = el('button', { text: 'this scene' });
    const fullBtn = el('button', { text: 'full video' });
    sceneBtn.onclick = () => this.export(parseInt(fps.value, 10), this.player.scene.id);
    fullBtn.onclick = () => this.export(parseInt(fps.value, 10), null);

    this.body.appendChild(el('div', { class: 'sp-row' }, fps, sceneBtn, fullBtn));
    const bar = el('div', { class: 'sp-bar' }, el('i'));
    this.body.appendChild(bar);
    this.body.appendChild(el('div', { class: 'sp-status' },
      'frame-exact render via headless Chrome; picked takes are muxed in. ' +
      'Iterate with "this scene" at 15 fps.'));
  }

  private async export(fps: number, scene: string | null): Promise<void> {
    try {
      await api.startExport(fps, scene);
    } catch (e) {
      this.status('export failed to start: ' + String(e));
      return;
    }
    this.status('export starting…');
    this.pollExport();
  }

  private resumeExportPollIfRunning(): void {
    void api.exportStatus().then((s) => {
      if (s.state === 'rendering' || s.state === 'starting') this.pollExport();
    }).catch(() => {});
  }

  private pollExport(): void {
    clearInterval(this.pollTimer);
    this.pollTimer = window.setInterval(async () => {
      let s;
      try { s = await api.exportStatus(); } catch { return; }
      const bar = this.body.querySelector<HTMLElement>('.sp-bar i');
      if (s.state === 'rendering' || s.state === 'starting') {
        const pct = s.totalFrames ? Math.round(100 * (s.frame || 0) / s.totalFrames) : 0;
        if (bar) bar.style.width = pct + '%';
        this.status(`${s.phase || 'rendering'} · frame ${s.frame}/${s.totalFrames} (${pct}%)`);
      } else if (s.state === 'done') {
        clearInterval(this.pollTimer);
        if (bar) bar.style.width = '100%';
        this.status(`✓ done — <a href="${s.output}" target="_blank">open MP4</a>`);
      } else if (s.state === 'error') {
        clearInterval(this.pollTimer);
        this.status('✗ export error: ' + (s.message || '').split('\n')[0]);
      }
    }, 700);
  }

  private status(html: string): void {
    const elStatus = this.body.querySelector<HTMLElement>('.sp-status');
    if (elStatus) elStatus.innerHTML = html;
  }

  /* highlight + autoscroll the current script line ------------------------ */

  private tick(): void {
    if (this.tab !== 'script' || !this.lineEls.length) return;
    const local = this.player.localTime;
    for (const le of this.lineEls) {
      const cur = local >= le.from && local < le.to;
      le.div.classList.toggle('current', cur);
      le.div.classList.toggle('done', local >= le.to);
      if (cur && this.player.playing) {
        le.div.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  }
}

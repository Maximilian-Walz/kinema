import { fetchProjects, getProject } from '../api';
import type { Takes } from '../audio/takes';
import { fmt, fmtMs, type Player } from '../engine/player';
import type { TimingSync } from '../timings';
import { el } from './dom';
import { openProject } from './picker';

/* play/pause, scene navigation, timecode, record shortcut, clean mode */
export class Transport {
  private readonly player: Player;
  private playBtn!: HTMLButtonElement;
  private recBtn!: HTMLButtonElement;
  private timeEl!: HTMLElement;
  private sceneEl!: HTMLElement;
  private savedEl!: HTMLElement;

  constructor(root: HTMLElement, player: Player, takes: Takes, sync: TimingSync) {
    this.player = player;

    this.playBtn = el('button', { class: 't-play', text: '▶ play' });
    this.playBtn.onclick = () => player.toggle();
    const restart = el('button', { text: '⟲ scene', title: 'restart scene (R)' });
    restart.onclick = () => player.restartScene();
    const prev = el('button', { text: '⟨', title: 'previous scene ([)' });
    prev.onclick = () => player.seekScene(player.sceneIndex - 1);
    const next = el('button', { text: '⟩', title: 'next scene (])' });
    next.onclick = () => player.seekScene(player.sceneIndex + 1);

    this.sceneEl = el('span', { class: 't-scene' });
    this.timeEl = el('span', { class: 't-time' });
    this.savedEl = el('span', { class: 't-saved' });

    this.recBtn = el('button', { class: 't-rec', text: '● rec' });
    this.recBtn.onclick = async () => {
      if (takes.recording) takes.stopRecording();
      else await takes.startRecording();
    };

    const clean = el('button', { text: '◻ clean (C)', title: 'stage only — for screen capture' });
    clean.onclick = () => document.body.classList.toggle('clean');

    const picker = el('select', { class: 't-project', title: 'switch project' }) as HTMLSelectElement;
    this.fillPicker(picker);

    root.append(
      this.playBtn, restart, prev, next,
      this.sceneEl, this.timeEl, this.savedEl,
      el('span', { class: 't-spacer' }),
      picker, this.recBtn, clean,
      el('span', { class: 't-keys', text: 'SPACE play · ←/→ ±5s (shift ±1s) · [ ] scene · 1-9 jump · C clean' }),
    );

    player.events.on('time', () => this.tick());
    player.events.on('play', (p) => {
      this.playBtn.textContent = p ? '❚❚ pause' : '▶ play';
    });
    takes.events.on('recording', (on) => {
      this.recBtn.classList.toggle('live', on);
      this.recBtn.textContent = on ? '■ stop' : '● rec';
    });
    sync.events.on('saved', () => this.flashSaved('✓ saved'));
    sync.events.on('error', () => this.flashSaved('✗ save failed', true));
    this.tick();
  }

  /* populate the project switcher async; changing it reloads on that project */
  private async fillPicker(sel: HTMLSelectElement): Promise<void> {
    const projects = await fetchProjects().catch(() => []);
    const current = getProject();
    for (const proj of projects) {
      const opt = el('option', { value: proj.id, text: proj.name }) as HTMLOptionElement;
      if (proj.id === current || (!current && proj.default)) opt.selected = true;
      sel.append(opt);
    }
    sel.onchange = () => openProject(sel.value);
  }

  private savedTimer: number | undefined;
  private flashSaved(text: string, error = false): void {
    this.savedEl.textContent = text;
    this.savedEl.classList.toggle('error', error);
    clearTimeout(this.savedTimer);
    this.savedTimer = window.setTimeout(() => { this.savedEl.textContent = ''; }, 1500);
  }

  private tick(): void {
    const P = this.player;
    const { index, local } = P.cursor();
    const scene = P.project.scenes[index];
    this.sceneEl.textContent = `${index + 1}/${P.project.scenes.length} ${scene.title}`;
    this.timeEl.textContent =
      `${fmtMs(local)} / ${fmt(scene.len)}  ·  video ${fmt(P.time)} / ${fmt(P.total)}`;
  }
}

import './ui/styles.css';
import { fetchProject, getProject } from './api';
import { Takes } from './audio/takes';
import { Player } from './engine/player';
import { History } from './history';
import { bootRender } from './render-mode';
import { TimingSync } from './timings';
import { el } from './ui/dom';
import { SidePanel } from './ui/panels';
import { showPicker } from './ui/picker';
import { Timeline } from './ui/timeline';
import { Transport } from './ui/transport';

if (new URLSearchParams(location.search).has('render')) {
  bootRender();
} else if (!getProject()) {
  /* no ?project= -> let the user pick one before booting the studio */
  void showPicker();
} else {
  void bootStudio();
}

async function bootStudio(): Promise<void> {
  const project = await fetchProject();
  document.title = `${project.name} — video-studio`;

  /* content styles: theme once, scene css swapped by the engine */
  const themeStyle = document.createElement('style');
  themeStyle.textContent = project.theme;
  const sceneStyle = document.createElement('style');
  document.head.append(themeStyle, sceneStyle);

  /* ------------------------------ layout ------------------------------- */
  const content = el('div', { id: 'scenecontent' });
  const stage = el('div', { id: 'stage' }, content);
  stage.style.width = project.width + 'px';
  stage.style.height = project.height + 'px';
  const frame = el('div', { id: 'frame' }, stage);
  const hud = el('div', { id: 'hud' });
  const stagearea = el('div', { id: 'stagearea' }, frame, hud);
  const side = el('aside', { id: 'side' });
  const transport = el('div', { id: 'transport' });
  const timeline = el('div', { id: 'timeline' });

  const app = document.getElementById('app')!;
  app.append(stagearea, side, transport, timeline);

  /* ------------------------------- wiring ------------------------------- */
  const player = new Player(project, content, sceneStyle);
  const takes = new Takes(player);
  const sync = new TimingSync(player);
  const history = new History();

  new Transport(transport, player, takes, sync);
  new SidePanel(side, player, takes, sync, history);
  const tl = new Timeline(timeline, player, takes, sync, history);

  player.events.on('time', () => {
    const { index, local } = player.cursor();
    hud.textContent = `scene ${index + 1} · ${local.toFixed(1).padStart(4, '0')}s`;
  });

  /* --------------------------- stage scaling ---------------------------- */
  function rescale(): void {
    const pad = document.body.classList.contains('clean') ? 0 : 18;
    const r = stagearea.getBoundingClientRect();
    const w = Math.max(100, Math.min(r.width - pad * 2, (r.height - pad * 2) * (project.width / project.height)));
    const h = w * (project.height / project.width);
    frame.style.width = w + 'px';
    frame.style.height = h + 'px';
    stage.style.transform = `scale(${w / project.width})`;
  }
  addEventListener('resize', rescale);
  new ResizeObserver(rescale).observe(stagearea);
  rescale();

  /* ----------------------------- keyboard ------------------------------- */
  document.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    /* let inline editors type in peace */
    const tag = t.tagName;
    if (tag === 'TEXTAREA' || (tag === 'INPUT' && (t as HTMLInputElement).type === 'text')) return;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'BUTTON') t.blur();

    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      const scene = e.shiftKey ? history.redo() : history.undo();
      if (scene) sync.changed(scene);
    } else if (ctrl && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      const scene = history.redo();
      if (scene) sync.changed(scene);
    } else if (e.code === 'Space') { e.preventDefault(); player.toggle(); }
    else if (e.key === 'r' || e.key === 'R') player.restartScene();
    else if (e.key === 'c' || e.key === 'C') { document.body.classList.toggle('clean'); rescale(); }
    else if (e.key === 'i' || e.key === 'I') {
      player.setLoop({ start: player.time, end: player.loop?.end ?? player.total });
    } else if (e.key === 'o' || e.key === 'O') {
      player.setLoop({ start: player.loop?.start ?? 0, end: player.time });
    } else if (e.key === 'Delete' || e.key === 'Backspace') tl.deleteSelection();
    else if (e.key === 'ArrowRight') player.seek(player.time + (e.shiftKey ? 1 : 5));
    else if (e.key === 'ArrowLeft') player.seek(player.time - (e.shiftKey ? 1 : 5));
    else if (e.key === '[') player.seekScene(player.sceneIndex - 1);
    else if (e.key === ']') player.seekScene(player.sceneIndex + 1);
    else if (e.key >= '1' && e.key <= '9') player.seekScene(parseInt(e.key, 10) - 1);
    else if (e.key === 'Escape') {
      if (takes.recording) takes.stopRecording();
      else if (player.loop) player.setLoop(null);
    }
  });

  await takes.refresh();
  player.update(0);

  /* for the smoke tests and console debugging */
  Object.assign(window as object, { __studio: { player, takes, sync, history, timeline: tl } });
}

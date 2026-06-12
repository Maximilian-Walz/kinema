import './ui/styles.css';
import { fetchProject } from './api';
import { Takes } from './audio/takes';
import { Player } from './engine/player';
import { bootRender } from './render-mode';
import { TimingSync } from './timings';
import { el } from './ui/dom';
import { SidePanel } from './ui/panels';
import { Timeline } from './ui/timeline';
import { Transport } from './ui/transport';

if (new URLSearchParams(location.search).has('render')) {
  bootRender();
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

  new Transport(transport, player, takes, sync);
  new SidePanel(side, player, takes);
  new Timeline(timeline, player, takes, sync);

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
    if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') {
      t.blur();
      return;
    }
    if (t.tagName === 'BUTTON') t.blur();
    if (e.code === 'Space') { e.preventDefault(); player.toggle(); }
    else if (e.key === 'r' || e.key === 'R') player.restartScene();
    else if (e.key === 'c' || e.key === 'C') { document.body.classList.toggle('clean'); rescale(); }
    else if (e.key === 'ArrowRight') player.seek(player.time + (e.shiftKey ? 1 : 5));
    else if (e.key === 'ArrowLeft') player.seek(player.time - (e.shiftKey ? 1 : 5));
    else if (e.key === '[') player.seekScene(player.sceneIndex - 1);
    else if (e.key === ']') player.seekScene(player.sceneIndex + 1);
    else if (e.key >= '1' && e.key <= '9') player.seekScene(parseInt(e.key, 10) - 1);
    else if (e.key === 'Escape' && takes.recording) takes.stopRecording();
  });

  await takes.refresh();
  player.update(0);
}

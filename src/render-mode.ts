import { fetchProject } from './api';
import { Player } from './engine/player';

/* ============================================================================
   Render mode (/?render=1) — no UI, no audio. Headless Chrome drives the page
   under CDP virtual time and screenshots the bare stage at 1:1 pixels.

   Contract for server/render.mjs:
     window.__render = { ready, sceneLens(), begin(sceneIndex|null), finished() }
============================================================================ */

declare global {
  interface Window {
    __render?: {
      ready: Promise<void>;
      sceneLens: () => number[];
      begin: (sceneIndex: number | null) => void;
      finished: () => boolean;
      seek: (sceneIndex: number, local: number) => void;
    };
  }
}

export function bootRender(): void {
  document.body.classList.add('render');
  const app = document.getElementById('app')!;

  let player: Player | null = null;
  let endTime: number | null = null;

  const ready = fetchProject().then((project) => {
    const themeStyle = document.createElement('style');
    themeStyle.textContent = project.theme;
    const sceneStyle = document.createElement('style');
    document.head.append(themeStyle, sceneStyle);

    const stage = document.createElement('div');
    stage.id = 'stage';
    stage.style.width = project.width + 'px';
    stage.style.height = project.height + 'px';
    const content = document.createElement('div');
    content.id = 'scenecontent';
    stage.appendChild(content);
    app.appendChild(stage);

    player = new Player(project, content, sceneStyle);
    player.update(0);
  });

  window.__render = {
    ready,
    sceneLens: () => player!.project.scenes.map((s) => s.len),
    begin: (sceneIndex) => {
      const P = player!;
      if (sceneIndex == null) {
        endTime = null;
        P.seek(0);
      } else {
        endTime = P.offsets[sceneIndex] + P.project.scenes[sceneIndex].len;
        P.seekScene(sceneIndex);
        /* stop on the scene's last frame instead of mounting the next scene */
        P.events.on('time', () => {
          if (endTime !== null && P.time >= endTime - 0.0005 && P.playing) {
            P.setPlaying(false);
            P.update(endTime - 0.001);
          }
        });
      }
      P.setPlaying(true);
    },
    finished: () => !player!.playing,
    seek: (sceneIndex, local) => player!.seekScene(sceneIndex, local),
  };
}

/* ============================================================================
   Vite plugin: mounts the studio API into the dev server.
   One process, one port — the app, the API and the exporter share it.

   Project selection: STUDIO_PROJECT env var (path relative to the repo root),
   default projects/groupchat.
============================================================================ */
import path from 'node:path';
import { createApi } from './api.mjs';

export function studioPlugin() {
  return {
    name: 'video-studio-api',

    configureServer(server) {
      const root = server.config.root;
      const projectDir = path.resolve(root, process.env.STUDIO_PROJECT || 'projects/groupchat');
      const api = createApi({ projectDir });

      server.middlewares.use(api.middleware);

      // Scene markup/styles are fetched at runtime, so Vite's HMR doesn't see
      // them. Watch the project dir and force a reload on .html/.css changes.
      // scene.json changes are written by the app itself (timing edits), so
      // those must NOT reload the page.
      server.watcher.add(projectDir);
      server.watcher.on('change', (file) => {
        const f = path.resolve(file);
        if (!f.startsWith(projectDir)) return;
        if (api.isSelfWrite(f)) return;
        if (f.endsWith('.html') || f.endsWith('.css') || f.endsWith('project.json')) {
          server.ws.send({ type: 'full-reload' });
        }
      });

      server.httpServer?.once('listening', () => {
        const addr = server.httpServer.address();
        if (addr && typeof addr === 'object') api.setOrigin(`http://127.0.0.1:${addr.port}`);
        console.log('  studio project: ' + projectDir);
      });
    },
  };
}

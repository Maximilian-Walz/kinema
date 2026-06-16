/* ============================================================================
   Vite plugin: mounts the studio API into the dev server.
   One process, one port — the app, the API and the exporter share it.

   Project selection (multi-project):
     - In-tree: every projects/<name>/ that contains a project.json is registered,
       id = folder basename.
     - Out-of-tree: list absolute or repo-relative paths in studio.config.json at
       the repo root: { "projects": ["../my-video", "C:/work/other"] }.
     - STUDIO_PROJECT (single path, repo-relative or absolute) is kept as an
       override: it is registered too and becomes the default project.
   Default project: STUDIO_PROJECT if set, else "groupchat" if present, else the
   first registered project. The registry re-scans on demand so newly added
   in-tree projects appear without a restart.
============================================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { createApi } from './api.mjs';

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

/* Builds the id -> { id, name, path, default } registry. `scan()` rebuilds it
   from disk; `all()` / `resolve()` re-scan first so the picture is always fresh. */
export function createRegistry(root) {
  const override = process.env.STUDIO_PROJECT
    ? path.resolve(root, process.env.STUDIO_PROJECT)
    : null;

  let map = new Map();

  function scan() {
    const next = new Map();
    const add = (absPath) => {
      const abs = path.resolve(absPath);
      if (!fs.existsSync(path.join(abs, 'project.json'))) return null;
      // collapse duplicate paths to a single entry
      for (const e of next.values()) if (e.path === abs) return e;
      const proj = readJson(path.join(abs, 'project.json'), {});
      const base = path.basename(abs);
      let id = base, n = 2;
      while (next.has(id)) id = base + '-' + (n++); // keep ids unique and stable
      const entry = { id, name: proj.name || base, path: abs, default: false };
      next.set(id, entry);
      return entry;
    };

    // in-tree projects/*
    const projectsDir = path.join(root, 'projects');
    if (fs.existsSync(projectsDir)) {
      for (const d of fs.readdirSync(projectsDir).sort()) {
        const abs = path.join(projectsDir, d);
        try { if (fs.statSync(abs).isDirectory()) add(abs); } catch { /* skip */ }
      }
    }

    // out-of-tree from studio.config.json
    const cfg = readJson(path.join(root, 'studio.config.json'), null);
    if (cfg && Array.isArray(cfg.projects)) {
      for (const p of cfg.projects) add(path.resolve(root, p));
    }

    // STUDIO_PROJECT override (also the default)
    let defaultId = null;
    if (override) {
      const e = add(override);
      if (e) defaultId = e.id;
    }
    if (!defaultId && next.has('groupchat')) defaultId = 'groupchat';
    if (!defaultId && next.size) defaultId = next.keys().next().value;
    if (defaultId && next.has(defaultId)) next.get(defaultId).default = true;

    map = next;
  }

  scan();

  return {
    scan,
    all() { scan(); return [...map.values()]; },
    /* id null/'' -> default project; unknown id -> null */
    resolve(id) {
      scan();
      if (!id) return [...map.values()].find((e) => e.default) || null;
      return map.get(id) || null;
    },
    /* directories to watch for html/css/project.json changes */
    dirs() { scan(); return [...map.values()].map((e) => e.path); },
  };
}

export function studioPlugin() {
  return {
    name: 'kinema-api',

    configureServer(server) {
      const root = server.config.root;
      const registry = createRegistry(root);
      const api = createApi({ registry });

      server.middlewares.use(api.middleware);

      // Scene markup/styles are fetched at runtime, so Vite's HMR doesn't see
      // them. Watch every project dir (plus projects/ so new in-tree projects
      // are noticed) and force a reload on .html/.css/project.json changes.
      // scene.json changes are written by the app itself (timing edits), so
      // those must NOT reload the page.
      const watched = new Set(registry.dirs());
      const inTree = path.join(root, 'projects');
      if (fs.existsSync(inTree)) watched.add(inTree);
      for (const dir of watched) server.watcher.add(dir);

      server.watcher.on('change', (file) => {
        const f = path.resolve(file);
        if (![...watched].some((d) => f.startsWith(d))) return;
        if (api.isSelfWrite(f)) return;
        if (f.endsWith('.html') || f.endsWith('.css') || f.endsWith('project.json')) {
          server.ws.send({ type: 'full-reload' });
        }
      });

      server.httpServer?.once('listening', () => {
        const addr = server.httpServer.address();
        // Print the URL we actually bound to. strictPort is false, so when 4321
        // is busy Vite picks another port; show the real one, not a hardcoded 4321.
        if (addr && typeof addr === 'object') {
          const host = server.config.server.host === true ? '127.0.0.1' : (server.config.server.host || '127.0.0.1');
          const url = `http://${host}:${addr.port}/`;
          api.setOrigin(`http://127.0.0.1:${addr.port}`);
          console.log('  studio: ' + url);
        }
        const list = registry.all();
        const def = list.find((e) => e.default);
        console.log('  studio projects: ' + list.map((e) => e.id + (e.default ? '*' : '')).join(', '));
        if (def) console.log('  default: ' + def.id + ' (' + def.path + ')');
      });
    },
  };
}

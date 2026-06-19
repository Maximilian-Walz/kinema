# CLAUDE.md

Guidance for working on **Kinema** — a local studio for data-driven animation
videos. The studio is the tool in this repo; the videos are **projects** (folders
of HTML/CSS/JSON scenes) and are kept separate (see "Projects" below).

For the user-facing tour see [README.md](README.md) and [docs/](docs/). This file
is the map for editing the **studio code**.

## Architecture

Vanilla TypeScript + Vite, no UI framework. DOM is built with the tiny `el()`
helper in [src/ui/dom.ts](src/ui/dom.ts). A small Node server
([server/](server/)) is mounted into Vite as a plugin and owns all file I/O and
the MP4 export.

The studio chrome is styled by [src/ui/styles.css](src/ui/styles.css); the stage
content is styled only by the project's `theme.css` + per-scene `scene.css`.

### Workspace modes ([src/ui/workspace-mode.ts](src/ui/workspace-mode.ts))

The window re-flows per mode (`F1`–`F4`); `body.mode-*` classes drive CSS.

- **RECORD** (`F1`) — teleprompter + mic. [src/ui/record-view.ts](src/ui/record-view.ts), [src/ui/recbar.ts](src/ui/recbar.ts).
- **TUNE** (`F2`) — take-centric audition + per-line post chain + sub-take picker
  + re-length. [src/ui/tune-view.ts](src/ui/tune-view.ts), [src/audio/](src/audio/).
- **TIME** (`F3`) — the **global** timeline across all scenes (SCENES / SCRIPT /
  CAPTIONS / VOICE). Scene lengths, narration/caption timing, voice alignment.
  [src/ui/timeline.ts](src/ui/timeline.ts).
- **SCENE** (`F4`, internal id still `"stage"`) — compose **one** scene; the live
  preview is the canvas, the bottom dock is a scene-local timeline, the
  **inspector** renders into the side panel. Per-element enter/exit is
  scene-local and lives **only** here. [src/ui/stage-view.ts](src/ui/stage-view.ts).

The SCENE inspector mounts via `SidePanel.setStageInspector(...)` →
`StageView.mountInspector(host)`; SidePanel's `case "stage"` in
[src/ui/panels.ts](src/ui/panels.ts) delegates. One group shows at a time behind
a TEXT | LOOK | TIMING tab strip (`StageView.mkTabs`; active tab persists to
`localStorage["sv.tab"]`).

The player/clock is [src/engine/player.ts](src/engine/player.ts); it emits
`time` / `scene` / `timings` / `loop` events the views subscribe to.

### Where edits go (the files on disk are the source of truth)

- **text** → `scene.html` (`api.setElementText` leaf / `api.setElementHtml`
  nested); applied live via `player.replaceSceneHtml`.
- **size / colour / position** → a generated `#id{}` region in `scene.css`
  (`api.setElementStyle`); applied via `player.replaceSceneCss`.
- **timing / animation / toggle class** → the `scene.json` schedule, via
  `History` + `TimingSync.changed` (debounced ~0.5s `putTimings`).

**Undo/redo** ([src/history.ts](src/history.ts)): a `SceneSnapshot` carries
`html` + `css` + timings. Edit commits wrap `history.snapshot(before)` → edit →
`history.commit`; `main.ts` `restoreScene()` re-persists + re-applies all three.

**Server** ([server/api.mjs](server/api.mjs)): `element-text`, `element-html`
(nesting-aware), `element-style` (overrides region), raw `scene.html`/`scene.css`
writes, takes/picks, and `POST /api/export` → [server/render.mjs](server/render.mjs)
(headless Chrome under CDP virtual time → PNGs → ffmpeg, takes muxed in).

## Projects

`/projects/*` is gitignored **except** `projects/intro` (the tracked template,
shown as "Meet Kinema"). Other projects (e.g. `projects/my-video`) are their own
nested git repos with `takes/` + `exports/` on disk — their edits won't show in
this repo's `git status`; commit them in their own repo. See
[docs/project-repos.md](docs/project-repos.md) and
[docs/project-format.md](docs/project-format.md).

## Develop / verify

```
npm run dev                       # Vite + the file/export server
npm run typecheck                 # must stay clean
npm run build
npm run validate                  # validate the default project's scenes
node scripts/validate.mjs projects/<name>
```

Runtime checks need the dev server up (note the port it prints):

```
node scripts/stage-check.mjs http://127.0.0.1:<port>   # SCENE mode, targets ?project=intro
STUDIO_URL=http://127.0.0.1:<port> node scripts/smoke.mjs   # boot + render mode; default project
```

`stage-check.mjs` mutates `projects/intro`; restore with
`git checkout -- projects/intro` afterwards. The same trick (a short
`puppeteer-core` script driving the running dev server, reading state off
`window.__studio`) is the fastest way to reproduce and verify editor behaviour —
write one, run it, then delete it.

## Conventions

- Commit completed, verified work to `main` (solo workflow). Commit messages end
  with the `Co-Authored-By: Claude ...` trailer.
- Match the surrounding style: terse comments that explain *why*, the `el()` DOM
  builder, no frameworks. Keep studio chrome out of the stage content's styles.

Open work lives in [docs/backlog.md](docs/backlog.md).

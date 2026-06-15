# 02 - Project picker UI + URL param

Status: done
Depends on: 01 (multi-project server API)
Plan item: 1 (project picker, UI half)

## Goal
Let a user pick which project to open from the UI, keep the choice in the URL
(`?project=<id>`) so reloads and render mode stay on the same project, and thread the
project id through every front-end API call.

## Current state
- [src/main.ts](../../src/main.ts): `bootStudio` calls `fetchProject()` with no project
  id; `bootRender()` runs when `?render` is present.
- [src/api.ts](../../src/api.ts): all calls hit fixed paths (`/api/project`,
  `/api/takes`, `/takes/:id/:file`, `/api/export`, etc.) with no project id.
- [src/render-mode.ts](../../src/render-mode.ts): `bootRender` also calls
  `fetchProject()`.

## Scope
1. **Read project id from URL.** A single helper reads `?project=` from
   `location.search` once at boot. If absent, the server default is used (do not invent
   an id client-side).
2. **Thread id through api.ts.** Append `project=<id>` to every project-scoped request
   (`fetchProject`, `putTimings`, `fetchTakes`, `uploadTake`, `pickTake`, `deleteTake`,
   `setTakeOffset`, `takeUrl`, `startExport`, and the `/takes` and `/exports` URLs the
   audio/export code builds). Centralize so it is one place, not scattered.
3. **Picker UI.** Pick one, simplest first:
   - Start screen when no `?project=` is set: fetch `GET /api/projects`, show a list,
     clicking one sets `?project=<id>` and boots the studio.
   - Plus a small dropdown in the transport/toolbar to switch project while open
     (sets the URL param and reloads; a full reload is acceptable and simplest given how
     much state hangs off the project).
4. **Render mode keeps the param.** `?render=1&project=<id>` must load the right project
   (mostly handled by 02 threading + 01 export URL; verify the render page reads the
   param via `fetchProject`).
5. **Title and default.** Keep `document.title = project.name + ' - video-studio'`.

## Files
- src/main.ts (boot path, start screen vs studio, dropdown wiring)
- src/api.ts (project id on every request)
- src/render-mode.ts (confirm it honors the param)
- src/ui/transport.ts or panels.ts (dropdown, if added there)
- src/ui/styles.css (start screen / dropdown styling)

## Acceptance criteria
- Opening `/` with no param shows the picker (or boots default, if you choose default
  + dropdown only); document which.
- Selecting a project sets `?project=<id>`; reload stays on it.
- Editing timings, recording takes, and exporting all act on the selected project.
- Export from a non-default project produces an MP4 of that project.
- Render URL with `&project=<id>` renders the right project.
- `npm run typecheck` clean; `node scripts/smoke.mjs` passes.

## Notes
- Switching project via reload is fine; do not try to hot-swap the Player/Timeline.

## Done (2026-06-15)
- Behavior chosen: `/` with no `?project=` shows the start-screen picker
  ([src/ui/picker.ts](../../src/ui/picker.ts)); it does NOT auto-boot the default.
  Picking a project sets `?project=<id>` and reloads.
- Project id threading (scope 2) and the URL read (scope 1) already landed with
  ticket 01 in [src/api.ts](../../src/api.ts) (`getProject`/`withProject`).
- In-studio switch: a `<select class="t-project">` in the transport
  ([src/ui/transport.ts](../../src/ui/transport.ts)), populated from
  `/api/projects`; onchange reloads via `openProject`.
- `scripts/smoke.mjs` now resolves the default project and boots
  `/?project=<id>` so the structural checks still line up; passes.

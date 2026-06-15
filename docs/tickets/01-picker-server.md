# 01 - Multi-project server API

Status: done
Depends on: none
Plan item: 1 (project picker, server half)

## Out-of-tree config mechanism (decided)
`studio.config.json` at the repo root, gitignored (machine-local):
```json
{ "projects": ["../my-video", "C:/work/other-project"] }
```
Paths are absolute or repo-relative; each must contain a `project.json`. In-tree
`projects/*` are always scanned. `STUDIO_PROJECT` (single path) is kept as an
override and additionally becomes the default project. Default order: STUDIO_PROJECT,
else `groupchat`, else the first registered project. The registry re-scans on every
`/api/projects` and on every project resolution, so new in-tree projects appear
without a restart. Ids are folder basenames, suffixed (`-2`, `-3`) on collision.

## Goal
Make the server project-aware so more than one project can be served from one running
dev server, selected per request. This is the foundation the picker UI (ticket 02)
builds on. Today the API is locked to a single project resolved once from
`STUDIO_PROJECT` at startup.

## Current state
- [server/plugin.mjs](../../server/plugin.mjs): `configureServer` resolves one
  `projectDir` from `process.env.STUDIO_PROJECT || 'projects/groupchat'`, calls
  `createApi({ projectDir })`, and watches that one dir for html/css/project.json
  changes.
- [server/api.mjs](../../server/api.mjs): `createApi({ projectDir })` closes over a
  single dir for everything: `TAKES_DIR`, `EXPORTS_DIR`, `PICKS_FILE`, `loadProject`,
  `sceneIds`, `writeTimings`, export. Every route is implicitly that one project.
- [server/render.mjs](../../server/render.mjs) is driven from `startExport` in api.mjs
  with `url: origin + '/?render=1'` (no project param).

## Scope
1. **Project registry.** On server start, build a map `id -> absolutePath`:
   - Scan `projects/*` for folders containing a `project.json`. `id` = folder basename.
   - Add out-of-tree entries: `STUDIO_PROJECT` (single path, keep as override) and an
     optional list (e.g. `STUDIO_PROJECTS` env as `;`-separated paths, or a
     `studio.config.json` at repo root with `{ "projects": ["../foo", ...] }`). Pick one
     mechanism and document it. On id collision, suffix to keep ids unique and stable.
   - Expose a re-scan so newly added in-tree projects appear without a restart (re-scan
     on each `GET /api/projects` is fine).
2. **List endpoint.** `GET /api/projects` -> `[{ id, name, path }]` (name from each
   `project.json`, falling back to basename). Mark which is the default.
3. **Per-request project resolution.** Routes that are project-scoped resolve the dir
   from a `?project=<id>` query param, falling back to the default project when absent
   (so existing single-project behavior and the render page keep working). Reject
   unknown ids with 404. This means refactoring `createApi` so `TAKES_DIR`,
   `EXPORTS_DIR`, `PICKS_FILE`, `loadProject`, `sceneIds`, `writeTimings`, `listTakes`,
   take upload/pick/offset/delete, file serving and export all derive their dir from the
   resolved project rather than a closed-over constant. Cleanest shape: a
   `resolveProject(id)` returning the per-project paths/helpers, called at the top of
   `middleware` from `u.searchParams.get('project')`.
4. **Export with project param.** `startExport` must build the render URL with the
   project id: `origin + '/?render=1&project=' + id`, and load that project's scenes,
   takes and picks. The export output filename/dir stays inside that project's
   `exports/`.
5. **Watcher.** Watch every known project dir (or at least all in-tree ones) for
   html/css/project.json changes and trigger `full-reload`, preserving the existing
   self-write guard so timing writes do not reload.

## Files
- server/plugin.mjs (registry, scan, watcher, pass registry into createApi)
- server/api.mjs (per-request resolution, `/api/projects`, export URL param)
- server/render.mjs (only if it needs to read the project param off the URL; it already
  drives the page which calls `/api/project`, so confirm the param reaches the page)

## Acceptance criteria
- `GET /api/projects` lists groupchat plus any other scanned/configured project.
- `GET /api/project?project=<id>` returns that project; no param returns the default.
- Timing writes, takes, and export all hit the correct project when `?project=` is set.
- `STUDIO_PROJECT` still works as an out-of-tree override.
- Existing `node scripts/smoke.mjs` passes (dev server running). Add a project param to
  the smoke flow if needed, or keep default-project behavior intact so it passes as-is.

## Notes / out of scope
- No UI in this ticket (that is 02). Verify with curl / browser query params.
- Decide and document the out-of-tree config mechanism here so the README/docs ticket
  (05) can reference it.

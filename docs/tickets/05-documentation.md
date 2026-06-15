# 05 - Documentation

Status: done
Depends on: 04 (quickstart opens the intro project; project-format doc describes the
format the intro demonstrates)
Plan item: 3

## Goal
Docs aimed at lazy colleagues: short. Trim the README to one screen and move the
reference material into `docs/`. Interactions stay discoverable in the UI hint bar, not
in prose.

## Scope
1. **README.md to one screen.** What it is, a 3-step quickstart (`npm install`,
   `npm run dev`, open the intro project via the picker), one screenshot or GIF, and
   links out to the docs below. Remove the long UI/format/export sections (move them, do
   not duplicate).
2. **docs/workflow.md (max 1 page).** The happy path start to finish: generate a project
   with the AI skill -> tune timings -> record voice -> export MP4. Link the skill
   (ticket 06) once it exists.
3. **docs/project-format.md.** Move the current format/contract reference out of the
   README: folder-per-scene layout, `project.json`, `scene.json` fields, schedule
   semantics (pure function of t, `cls` toggles, captions band, behaviors), the
   `.el`/`.ovl` helper patterns, 1920x1080 stage, content above caption band. This file
   is also what the skill consumes, so keep it precise and current.
4. Document the picker and the out-of-tree project config mechanism chosen in ticket 01
   (briefly, in README or workflow).

## Files
- README.md (trim)
- docs/workflow.md (new)
- docs/project-format.md (new, lifted from README)
- a screenshot/GIF asset (e.g. docs/ or a media folder)

## Acceptance criteria
- README fits roughly one screen and the quickstart works for a fresh clone.
- Format reference lives in docs/project-format.md and matches the actual loader in
  [server/api.mjs](../../server/api.mjs) `loadProject` and the engine.
- No duplicated format docs between README and docs/.

## Notes
- Keys/interactions: confirm the UI hint bar covers them; if a key is undocumented in the
  UI, prefer adding it to the hint bar over writing it in docs.
- Style: short, developer-to-developer, no em-dashes.

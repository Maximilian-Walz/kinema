# 03 - scripts/validate.mjs

Status: done
Depends on: none (independent; do early, it helps author ticket 04)
Plan item: 4 (validation helper, pulled out as its own ticket)

## Goal
A small standalone validator the skill and humans can run against a project folder, no
dev server required. Catches the mistakes an AI or a human most often makes when hand-
writing scene files.

## Why separate
PLAN lists this under the skill, but it is a prerequisite for authoring the intro
project (04) and the skill consumes it (06). Building it first makes 04 and 06 easier.

## Scope
`node scripts/validate.mjs <projectDir>` (default to the resolved default project if no
arg). Read files directly from disk, mirror how
[server/api.mjs](../../server/api.mjs) `loadProject` reads them. Checks:
- `project.json` exists and parses; `scenes` resolve to real `scenes/<id>/` folders with
  `scene.html`, `scene.css`, `scene.json`.
- Each `scene.json` parses; `len` is a positive number.
- Every `schedule[].id` exists as an `#id` in that scene's `scene.html`.
- Schedule `enter`/`exit` times are within `[0, len]` and `enter <= exit`.
- `lines` and `captions` entries have `from <= to`, within `[0, len]`, and are ordered
  (warn, not fail, on overlap unless clearly wrong).
- If a scene uses captions, `scene.html` includes `<div id="caption"></div>` (warn).
- Print a per-scene summary; exit non-zero if any hard error. Errors vs warnings clearly
  separated.

## Files
- scripts/validate.mjs (new)
- Optionally a `validate` entry in package.json scripts.

## Acceptance criteria
- Runs against `projects/groupchat` with exit 0 (fix the script, not the project, if it
  false-positives).
- Introducing a bad schedule id or out-of-range time makes it exit non-zero with a clear
  message naming the scene and field.
- No dependency on a running server; pure Node + fs.

## Notes
- Keep id extraction from html simple and forgiving (regex for `id="..."` is enough; do
  not pull in a DOM parser).
- Match the style of the existing scripts in [scripts/](../../scripts/).

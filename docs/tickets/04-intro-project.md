# 04 - Example "intro" project

Status: todo
Depends on: 01, 02 (so it is selectable in the picker), 03 (to validate it)
Plan item: 2

## Goal
A small project (~4-6 scenes, ~2-3 min) that introduces video-studio itself. It doubles
as living documentation and as the template colleagues copy. It is the one project that
ships tracked in the tool repo.

## Tracking decision
`projects/` is gitignored (see [.gitignore](../../.gitignore)). The intro project must be
tracked. Pick one and apply it:
- Move it to a tracked `examples/intro/` folder, and make the picker scan `examples/*`
  too (coordinate with ticket 01's registry), OR
- Keep it at `projects/intro` and un-ignore exactly that path in `.gitignore`
  (`!/projects/intro`). Simpler; keeps all projects under one root.
Recommend the `projects/intro` un-ignore unless the picker scan makes `examples/` cheap.
Its `takes/` and `exports/` stay gitignored.

## Content (keep animations simple so scene files read as examples)
Cover briefly, one idea per scene:
1. What it is: scenes = HTML/CSS/JSON on a global timeline.
2. Playback + timeline editing: drag, snap, undo.
3. Recording voice takes + alignment.
4. Export to MP4.
Optional 5th/6th: the project format, or "make your own". Use only text, simple panels,
and a few key/icon elements driven by the `.el`/`.el.on` helper pattern in `theme.css`.
Content stays above the caption band. 1920x1080 stage.

## Craft constraints (these also seed the skill, ticket 06)
- Narration `lines` sized to speaking pace (~2.5 words/s); scene `len` derived from its
  narration, not arbitrary.
- `schedule` entries land on the narration beats.
- Captions optional; if used, include `<div id="caption"></div>`.

## Files
- projects/intro/project.json, theme.css
- projects/intro/scenes/NN-*/scene.{html,css,json}
- .gitignore (un-ignore the chosen path)

## Acceptance criteria
- Appears in `GET /api/projects` and the picker; opens and plays end to end.
- `node scripts/validate.mjs projects/intro` exits 0.
- Scene files are short and readable as copy-paste examples.
- Committed to the tool repo (not gitignored); takes/exports still ignored.

## Notes
- Narration can ship as text only; recording real voice takes is optional for the
  template. If you record, do not commit the audio.

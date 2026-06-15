# 06 - video-project skill

Status: done
Depends on: 03 (validate.mjs), 04 (intro project as reference), 05 (project-format doc
the skill consumes)
Plan item: 4

## Goal
An in-repo Claude skill (`.claude/skills/video-project/`) that teaches Claude to
generate and revise video-studio projects, so colleagues can prompt their way to a first
draft and use the AI mid-workflow to redo or add animations.

## Scope
1. **Skill files.** `.claude/skills/video-project/SKILL.md` (plus any helper templates).
   Ships in the repo so every clone has it.
2. **Teach the format.** Folder-per-scene, `scene.html/scene.css/scene.json`,
   `theme.css`, `project.json`; schedule semantics (pure function of t, `cls` toggles,
   captions band, behaviors). Reference docs/project-format.md (ticket 05) rather than
   restating it; keep the skill thin where the doc is authoritative.
3. **Teach the craft.** Narration lines sized to ~2.5 words/s; scene lengths derived from
   narration; schedule entries on the narration beats; the generic `.el`/`.ovl` helper
   patterns; 1920x1080 stage; content above the caption band.
4. **Workflows it supports.**
   - (a) Create a new project from an article/topic: script first, then scenes.
   - (b) Revise or add a single scene in an existing project.
   - (c) Retime against edited narration.
   For (b) and (c) it MUST read the user's edited `scene.json` and treat existing
   timings as the user's: do not overwrite them silently.
5. **Validation.** The skill runs `node scripts/validate.mjs <projectDir>` after writing
   and fixes what it reports.
6. **Source material.** Distill patterns from the groupchat project as reference, but do
   not bake project-specific content into the skill.

## Files
- .claude/skills/video-project/SKILL.md (new) and any templates/snippets
- (reads, does not edit) docs/project-format.md, scripts/validate.mjs, projects/intro

## Acceptance criteria
- From a topic prompt, the skill produces a valid new project that passes
  `scripts/validate.mjs` and plays in the studio.
- Asked to add/revise one scene, it edits only that scene and preserves existing
  `scene.json` timings.
- No groupchat-specific content leaks into generated projects.

## Notes
- Keep the skill focused; lean on the format doc and validator instead of duplicating
  them. Match Max's style in any prose the skill emits.

# Plan: from personal tool to team tool

> For Claude: pick this up in a fresh session. Read README.md first (formats, architecture), then work top to bottom. Max's style rules: concise, no bloat, developer-to-developer tone, no em-dashes.

## Goal

Colleagues at arconsis use video-studio to make short tech videos (based on a Medium article or standalone). Their workflow: prompt an AI to generate the project (script + scene animations) via a Claude skill, open it in the studio, fine-tune timings, record voice, export MP4. The AI is also used mid-workflow to redo or add animations.

## Work items, in order

### 1. Project picker
Prereq for the example project. Replace the env-var-only project selection:
- Server scans `projects/*` (folders with a `project.json`) and exposes `GET /api/projects`.
- Switch via UI (start screen or dropdown in the transport/toolbar) with `?project=<id>` in the URL so reloads and the render mode keep working. Render URL gets the project param too (`/?render=1&project=...`).
- Keep `STUDIO_PROJECT` env var as override for out-of-tree project folders.

### 2. Example project: "intro" (meta: the tool explains itself)
A small project (~4-6 scenes, ~2-3 min) introducing video-studio itself. Doubles as living documentation and as the template colleagues copy. Cover briefly: what it is (scenes = html/css/json), playback + timeline editing (drag, snap, undo), recording takes + alignment, export. Keep animations simple (text, panels, key icons) so the scene files are readable as examples. Ships in the tool repo (NOT gitignored: either move it to an `examples/` folder that is tracked, or un-ignore `projects/intro` explicitly).

### 3. Documentation (good = short)
Audience: lazy colleagues. Structure:
- README.md: trim to one screen. What it is, 3-step quickstart (`npm install`, `npm run dev`, open intro project), one screenshot/GIF, link out for the rest.
- `docs/workflow.md`: the happy path start to finish (generate project with AI -> tune -> record -> export), max 1 page.
- `docs/project-format.md`: move the current format/contract reference out of the README. This is also what the AI skill consumes.
- Keys/interactions stay discoverable in the UI (hint bar) instead of docs.

### 4. Claude skill for project generation
A skill (`.claude/skills/` in this repo, name e.g. `video-project`) that teaches Claude:
- The project format (folder per scene, scene.html/scene.css/scene.json, theme.css, project.json; schedule semantics: pure function of t, cls toggles, captions band, behaviors).
- The expected craft: narration lines sized to speaking pace (~2.5 words/s), scene lengths from narration, schedule entries matching the narration beats, the generic `.el`/`.ovl` helper patterns, 1920x1080 stage, content above the caption band.
- Workflows it supports: (a) create a new project from an article/topic (script first, then scenes), (b) revise or add a single scene in an existing project, (c) retime against edited narration. For (b)/(c) it must READ the user's edited scene.json (timings are the user's; don't overwrite them silently).
- Validation helper: a small `scripts/validate.mjs` the skill (and humans) can run: schedule ids exist in scene.html, times within len, lines/captions ordered, project.json scenes resolve. Also useful standalone.
- Source material for the skill: distill from the groupchat project as reference, but don't bake project-specific stuff in.

### 5. Polish for "other people's machines" (small, do last)
- `npm start` should not collide on port 4321 (strictPort already false; print the picked URL clearly).
- Friendly error screens: no project found, project.json invalid (today: console only).
- Windows + macOS path check for Chrome detection (exists, verify on a colleague's mac if possible).

## Open questions for Max (ask at session start)
- Where do team projects live: in this repo's `projects/` (gitignored, each its own repo) or anywhere on disk via picker? Affects picker scope.
- Distribution: colleagues clone this repo, or publish as an npm/internal package later? (Plan assumes clone.)
- Skill location: in-repo `.claude/skills/` (works for everyone who clones) vs. personal/global skill.

## Current state (2026-06-12, for context)
Tool repo at `video-studio` (commits through b017d7e): Vite+TS app, folder-per-scene projects, timeline editor (snapping, multi-select, undo, loop, inline text edit, take trim), per-scene takes with remux + Range serving, frame-exact MP4 export. Tests: `scripts/smoke.mjs`, `scripts/seek-test.mjs`, `scripts/compare.mjs` (dev server must run). The groupchat video project lives in `projects/groupchat` (own git repo, gitignored here). HANDOVER.md in the article folder tracks the video production itself.

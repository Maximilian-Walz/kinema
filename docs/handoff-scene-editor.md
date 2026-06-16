# Handoff — SCENE editor follow-ups

Living scratch doc for continuing the SCENE/TIME editor work. Delete items as
they land. Commit completed+verified work to `main` (solo workflow).

## Orientation (read first)

- **Modes** live in [src/ui/workspace-mode.ts](../src/ui/workspace-mode.ts).
  - **TIME** (F3) = the **global** timeline across all scenes: SCENES / SCRIPT /
    CAPTIONS / VOICE. Code: [src/ui/timeline.ts](../src/ui/timeline.ts).
  - **SCENE** (F4, internal id still `"stage"`) = compose one scene. Code:
    [src/ui/stage-view.ts](../src/ui/stage-view.ts). Element enter/exit is
    scene-local and lives **only** here (not in TIME).
- **SCENE inspector** renders into the **side panel** (`.sp-body`), not the
  bottom dock. Wiring: `SidePanel.setStageInspector(...)` →
  `StageView.mountInspector(host)`; SidePanel's `case "stage"` in
  [src/ui/panels.ts](../src/ui/panels.ts) delegates. The bottom dock
  (`#stageview`) is a full-width scene-local timeline (ruler + read-only SCRIPT
  lane + element lanes).
- **Where edits go:**
  - text → `scene.html` (`api.setElementText` leaf / `api.setElementHtml`
    nested); engine applies live via `player.replaceSceneHtml`.
  - size/colour/position → a generated `#id{}` region in `scene.css`
    (`api.setElementStyle`); engine applies via `player.replaceSceneCss`.
  - timing/animation/class → `scene.json` schedule, undoable via `History` +
    `TimingSync.changed`.
- **Server endpoints**: [server/api.mjs](../server/api.mjs) — `element-text`,
  `element-html` (nesting-aware), `element-style` (overrides region).
- **Tests / verify loop:**
  - `npm run typecheck` (must be clean), `npm run build`,
    `node scripts/validate.mjs projects/intro`.
  - SCENE runtime: start `npm run dev`, then
    `node scripts/stage-check.mjs http://127.0.0.1:<port>` (25 assertions,
    targets `?project=intro`). It mutates intro files then restore with
    `git checkout -- projects/intro`.
  - `scripts/smoke.mjs` needs the **groupchat** default (start `npm run dev`
    with no `STUDIO_PROJECT`), then `STUDIO_URL=... node scripts/smoke.mjs`.
- `projects/groupchat` is an in-tree but **untracked/gitignored** demo project
  (9 scenes) — edits there won't show in `git status` / commits.

## Open items

### 1. Properties panel tabs  ✅ DONE (Option B)
The inspector now shows one group at a time behind a TEXT | LOOK | TIMING tab
strip (`StageView.mkTabs` / `.sv-tabs` in [styles.css](../src/ui/styles.css)),
replacing the collapsible `<details>` cards. Active tab persists to localStorage
(`sv.tab`, `StageView.TAB_KEY`). TEXT dims (`.sv-tab-empty`) when the element
has no editable text but stays clickable (shows the empty note). The old
`.sv-card*` rules and `mkCard` were removed. stage-check gained a `selectTab()`
helper and switches to the relevant tab before querying group DOM.

Future: a 4th SCENE/global tab is now a one-liner if we want scene-level props.
Option C (icon rail) was deferred — only worth it at 5+ groups with reusable
icons, and the repo has no icon vocabulary yet.

### 2. In-place text edit: caret invisible + unclear edit mode  ✅ DONE
`startInlineEdit` now adds a `.sv-editing` class to the node (removed in
`cleanup()`): explicit `caret-color:var(--st-mode)!important` fixes the
inherited-fill-vanishing caret, plus a dashed outline + tinted background +
`min-width:.4ch` signal edit mode. The selection overlay box is hidden on edit
start (`positionBox(selBox, null)`) and restored in `cleanup()` via
`repositionBoxes()`, so it no longer competes with the editing outline.

### 3. Drag leaves the highlight box behind  (one-liner)  ✅ DONE
The `beginElementDrag` move handler now calls `this.positionBox(this.selBox,
node)` right after setting `node.style.translate` (and hides the hover box), so
the selection box tracks the node during a paused drag.

### 4. Undo/redo for text & style edits  (T28, the meaty one)
Today `History` ([src/history.ts](../src/history.ts)) snapshots only the
`scene.json` fields (`len/schedule/captions/lines`). Text writes `scene.html`
and style writes `scene.css`, so neither is undoable.
Plan:
- Extend `SceneSnapshot` with `html` + `css`; `snapshot()` reads
  `scene.html/scene.css`, `apply()` restores them.
- Add raw write endpoints `PUT /api/scenes/:id/html` and `/css` in
  [server/api.mjs](../server/api.mjs) (overwrite the file; track as self-write),
  plus `api.putSceneHtml/putSceneCss` clients.
- Wrap SCENE text/style/position commits in `history.snapshot(before)` →
  edit → `history.commit`. (They already write to disk immediately; snapshot
  BEFORE the edit captures the prior html/css.)
- In [main.ts](../src/main.ts) undo/redo: after `history.undo()` returns the
  scene, persist whichever of timings/html/css changed and refresh the engine
  (`replaceSceneHtml` / `replaceSceneCss` / `refreshTimings`). Simplest: always
  persist+apply all three on undo/redo of a scene.
- Add a stage-check assertion: edit text → ctrl+Z restores `scene.html`.

## Where to go from here (after 1–4)

- **Editable element labels** (`data-label`) via the HTML patch — names are
  read-only/derived today.
- **Auto-assign an id** when scheduling an element that has none (the one gap in
  pick-from-stage; needs a small HTML attribute write).
- **Per-element transition duration/easing** — expose a `--fx-dur` the presets
  read, set via the scene.css override (pairs with the fx presets).
- **Scene-level ops in the UI**: duplicate / reorder scenes (currently a
  `project.json` hand-edit), duplicate a schedule entry.
- **SCENE multi-select + arrow-key nudge** for element timing/position; copy/paste.
- **Jump-to-entrance** key on a selected element (replay its animation quickly).

## Conventions
- Always commit completed+verified work (don't push unless asked); commit
  messages end with the `Co-Authored-By: Claude ...` trailer.
- Match surrounding code style (terse comments explaining *why*, `el()` DOM
  builder, no frameworks).

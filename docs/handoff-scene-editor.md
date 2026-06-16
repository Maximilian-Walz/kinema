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
  lane + element lanes). The inspector shows one group at a time behind a
  TEXT | LOOK | TIMING tab strip (`StageView.mkTabs`; active tab persists to
  `localStorage["sv.tab"]`).
- **Where edits go:**
  - text → `scene.html` (`api.setElementText` leaf / `api.setElementHtml`
    nested); engine applies live via `player.replaceSceneHtml`.
  - size/colour/position → a generated `#id{}` region in `scene.css`
    (`api.setElementStyle`); engine applies via `player.replaceSceneCss`.
  - timing/animation/class → `scene.json` schedule, undoable via `History` +
    `TimingSync.changed`.
- **Undo/redo** for SCENE edits: `SceneSnapshot` carries `html` + `css` +
  timings ([src/history.ts](../src/history.ts)). Text/style/position commits
  wrap `history.snapshot(before)` → edit → `history.commit`; `main.ts`
  `restoreScene()` re-persists + re-applies all three on undo/redo. Raw writes:
  `PUT /api/scenes/:id/html` and `/css` (`api.putSceneHtml` / `putSceneCss`).
- **Server endpoints**: [server/api.mjs](../server/api.mjs) — `element-text`,
  `element-html` (nesting-aware), `element-style` (overrides region), plus the
  raw html/css writes above.
- **Tests / verify loop:**
  - `npm run typecheck` (must be clean), `npm run build`,
    `node scripts/validate.mjs projects/intro`.
  - SCENE runtime: start `npm run dev`, then
    `node scripts/stage-check.mjs http://127.0.0.1:<port>` (targets
    `?project=intro`). It mutates intro files then restore with
    `git checkout -- projects/intro`.
  - `scripts/smoke.mjs` needs the **groupchat** default (start `npm run dev`
    with no `STUDIO_PROJECT`), then `STUDIO_URL=... node scripts/smoke.mjs`.
- `projects/groupchat` is an in-tree but **untracked/gitignored** demo project
  (its own nested git repo, with `takes/` on disk) — edits there won't show in
  the studio repo's `git status`. See [project-repos.md](project-repos.md).

## Recently landed

- Inspector TEXT | LOOK | TIMING tabs (replaced the `<details>` cards).
- Undo/redo for SCENE text & style edits (T28).
- Selection box tracks the node during a paused drag.
- **Edit-mode caret now always visible.** Root cause: Blink derives the caret
  from `-webkit-text-fill-color`, so transparent-fill / gradient text painted a
  transparent caret on *some* elements. Fix in `.sv-editing,.sv-editing *`
  ([styles.css](../src/ui/styles.css) ~460): force `caret-color`, `color`, and
  `-webkit-text-fill-color` opaque + `background-clip:border-box` while editing.
  **Tradeoff:** edited text is recoloured amber during the edit (fill-independent
  way to guarantee the caret). If WYSIWYG colour-while-editing is wanted, switch
  to a JS per-element computed-colour approach instead.
- **Off-screen selection no longer leaves a stale highlight box.** `highlight()`
  now applies the same `isOnScreen(id)` gate that `repositionBoxes()` uses, so
  selecting an element that isn't visible at the current playhead hides the box
  immediately instead of only on the next playhead move
  ([stage-view.ts](../src/ui/stage-view.ts) ~497).
- **Line recording — sub-take picker (overrun).** Recording no longer hard-stops
  at the line's slot end (`Takes.overrun` gates the old auto-stop in
  [takes.ts](../src/audio/takes.ts)); you can capture a longer take, then in TUNE
  drag a fixed-length window (= the line's duration) over the take's waveform to
  pick which slice plays. New per-file `inPoint` persists in `takes.json`
  (`inPoints` map; route `POST /api/takes/:sid/:lid/:file/inpoint`), honored in
  preview (`Takes.sync` adds `inPoint`) and export (`render.mjs` uses
  `winLen = ln.to-ln.from`, `audible = winLen - max(0,off)` so existing exports
  are unchanged for inPoint=0). Picker overlay: `TakeStrip` window box, mounted
  on the candidate strip in [tune-view.ts](../src/ui/tune-view.ts). No ripple;
  the line's duration is unchanged. Chain-mode auto-advance keys off whether the
  playhead actually passed `line.to` at manual-stop time.
  **Still needs a manual ear/export check** (record past a slot, drag the window,
  export, compare preview vs MP4). Length-redefinition + ripple remains deferred.

### Backlog
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

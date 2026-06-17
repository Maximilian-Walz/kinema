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
- **Edit-mode caret — custom caret (real root cause).** The native caret is a
  1px line; inside the scaled `#stage` (`main.ts` `transform:scale()`) it lands
  on/off a rasterised pixel column at different sub-pixel x, so it vanishes at
  some caret positions, consistently per text/font. (An earlier amber-fill fix
  was wrong — it's geometry, not colour.) Now the native caret is hidden
  (`caret-color:transparent`) and `StageView.positionCaret()` draws a custom
  `.sv-caret` in the `#stagearea` chrome at the selection focus rect (post-scale
  `getClientRects()`, same basis as `positionBox`), updated on
  `selectionchange`/`input`/`keyup`/`pointerup`. Text keeps its real colour.
- **Off-screen selection no longer leaves a stale highlight box.** `highlight()`
  now applies the same `isOnScreen(id)` gate that `repositionBoxes()` uses, so
  selecting an element that isn't visible at the current playhead hides the box
  immediately instead of only on the next playhead move
  ([stage-view.ts](../src/ui/stage-view.ts) ~497).
- **Recording modes: CHAIN | FOCUS** (toggle in [record-view.ts](../src/ui/record-view.ts),
  `rv.chainMode`; the non-chain mode is labelled "◎ focus" in the UI — internally
  still `chainMode === false`). CHAIN hard-stops each take at `line.to` and
  auto-advances to the next line (prompter scrolls along). FOCUS never auto-stops
  at the slot — recording rolls on so you can read long; the prompter freezes on
  the line you started, and you pick/extend afterwards. While focus-recording the
  playhead is pinned inside the scene (`player.maxTime`), so an overrun — even on
  the last line — never crosses into the next scene (which would otherwise stop
  the take and advance the view). The mode now drives the slot-end auto-stop in
  `Takes` (was a separate `overrun` flag). A per-line **progress
  bar** (RecBar + the current prompter line, [recbar.ts](../src/ui/recbar.ts) /
  `RecordView.updateLineProgress`) fills across the line's duration and pulses
  red on overrun. On **stop**, FOCUS mode clamps the playhead back inside the
  recorded line (`Takes.onstop` seeks to `lineTo - ε` when it overran), so an
  overtime stop ends on the same line as an in-time stop — no phantom advance.
- **Line recording — sub-take picker.** Capture a longer take, then drag a
  fixed-length window (= the line's duration) over the take waveform to pick
  which slice plays. Per-file `inPoint` persists in `takes.json` (`inPoints`
  map; route `POST /api/takes/:sid/:lid/:file/inpoint`), honored in preview
  (`Takes.sync` adds `inPoint`) and export (`render.mjs` uses `winLen = ln.to-ln.from`,
  `audible = winLen - max(0,off)` so existing exports are unchanged for
  inPoint=0). Picker overlay: `TakeStrip` window box ([tune-view.ts](../src/ui/tune-view.ts)).
  The picker drag is **fixed** (window-level listeners in `TakeStrip`; audition +
  persist on release). It lives in **TUNE** and should stay there — reviewing
  recordings inside record mode felt wrong. Needs a manual ear/export check too.

- **TUNE = take-centric audition transport + re-length.** TUNE
  ([tune-view.ts](../src/ui/tune-view.ts)) no longer plays the global timeline.
  One take is **selected** (default = the pick); **Space** plays/pauses *that*
  take (routed in [main.ts](../src/main.ts) when `mode === "tune"`, leaving the
  player paused). A **sticky playhead** (`startAt`) is where playback begins and
  replays from — clicking the waveform sets it (no auto-play), `Home` / dbl-click
  resets it to the window start. Playback is **windowed** to the picked sub-take
  slice by default; the **window/whole** toggle (button or `w`) hears the whole
  recording. Audio: `Takes.scrubAudition(...,endSec)` bounds the buffer source to
  the slice (`source.start(0, from, dur)`); `pauseAudition()` stops it; the strip
  cursor follows `auditionPosition()` while playing and parks on `startAt` when
  not. Selection click handling: row click selects; the `TakeStrip` stops its own
  clicks bubbling so scrubbing doesn't reset the playhead.
- **Re-length (landed).** Drag either edge of the picked take's `TakeStrip`
  window to re-length the line; the body still slips the in-point (no ripple).
  Transform (line L, Δ = newLen − oldLen, anchor = old `L.to`, **start pinned**):
  `L.to += Δ`; every later line `from/to += Δ`; `scene.len += Δ`; each schedule
  entry `enter/exit += Δ` when `>= anchor`; each caption `from/to += Δ` when
  `>= anchor`. Pure in-memory mutation of one `SceneData` →
  `history.snapshot`/commit + `sync.changed(scene)` (debounced `putTimings`); left
  edge also persists the new `inPoint`. Undoable via the normal Ctrl+Z path.
  `TuneView` now takes `sync` + `history` + `mode`. Clamp: `newLen ∈ [0.2s,
  takeDuration]`. Still wants a manual ear/export check.

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

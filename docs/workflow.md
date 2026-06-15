# Workflow

The happy path, start to finish. The format every step touches is in
[project-format.md](project-format.md).

## 1. Draft the project with the AI

Ask Claude (the in-repo `video-project` skill teaches it the format) for a first
draft from an article, a topic, or an outline. It writes the narration script
first, sizes scenes to the narration, lays markup/CSS per scene, and runs
`node scripts/validate.mjs` on the result.

You can also point the skill at one existing scene to redo or add an animation,
or to retime a scene after you have edited its narration. It treats timings
already in `scene.json` as yours and will not silently overwrite them.

No AI handy? Copy `projects/intro`, rename the folder, and edit a scene at a
time. Each scene is three small files (see [project-format.md](project-format.md)).

## 2. Pick a workspace mode

The studio has three top-level modes (`F1` / `F2` / `F3`, also clickable in the
transport bar). The whole window re-flows per mode so only the surfaces you
need for the job are on screen:

- **RECORD** (`F1`) — teleprompter at the bottom with the current line large,
  prev/next dimmed; a pinned bar with arm/disarm mic, live waveform, level
  meter and a big "rec this line" button. Side panel shows the last takes for
  the line under the cursor.
- **TUNE** (`F2`) — bottom dock becomes a take comparator: a section
  navigator (one button per script line) on the left, and one wide
  scrubbable waveform per take on the right (▶ audition, ★ pick, ✕ trash).
  Side panel shows the playback meter, the "match all takes" button, and the
  collapsible post chain (high-pass / gate / compressor / gain) for whichever
  line the cursor is on.
- **TIME** (`F3`) — full timeline at the bottom (scenes / script / captions /
  elements / voice), side panel is just the script teleprompter. Drag the
  divider at the top of the dock to resize it.

The line under the playhead is the implicit selection across all three modes,
so clicking a section in the TUNE navigator or a line in the RECORD prompter
just seeks — and the side panel updates in lock-step.

## 3. Tune timings (TIME mode)

`npm run dev`, open the project from the picker, and play it. The timeline is
one global clock across all scenes:

- Drag clips to move them, drag edges to retime, drag a scene block's right
  edge to change its length. Drags snap to the playhead, scene bounds, loop
  edges, and other clips.
- Double-click a script or caption clip to edit its text; `+ line / + caption
  / + element` insert at the playhead.
- Set a loop region with `I` / `O` to iterate on one stretch.

Every edit is undoable and written straight back into the scene's `scene.json`
(debounced ~0.5s). The hint bar in the transport and button tooltips list the
mode-specific keys.

## 4. Record voice (RECORD mode)

Press `F1` to switch to RECORD. Arm the mic from the bar at the top of the
prompter dock, watch the level / clip indicator while you read. Press `r`
(or click "rec this line") to record the line under the cursor with a 3-2-1
count-in; recording auto-stops at the line end and the new take is auto-picked.
A top-of-app red banner stays visible while recording, regardless of mode.

## 5. Compare and pick takes (TUNE mode)

Press `F2` to switch to TUNE. The section navigator lists every line in the
scene; click one to seek to it. The comparator on the right shows every take
for the selected line with a scrubbable waveform — click anywhere on the
waveform to jump audition to that point. `★ pick` sets the take used in
preview and export. The post-chain cards in the side panel adjust the chosen
take's high-pass, gate, compressor, and gain (changes apply live to preview
and audition; "normalize" / "match all takes" target -18 dBFS RMS).

If mic latency pushed a take out of sync, switch to TIME mode and drag its
waveform in the VOICE track to align it; that offset is used in both preview
and export.

## 6. Export MP4

Click `⤓ export` in the transport bar, pick fps and scope ("this scene" /
"full video"). The render is frame-exact: headless Chrome drives the stage
under frozen virtual time (so CSS transitions land on identical frames every
run), PNGs are piped to ffmpeg, and the picked takes are muxed in at their
scene offsets plus alignment offsets. Iterate on one scene at 15 fps; render
the final at 30 or 60. Expect roughly 5-10 captured frames per second of wall
time. Closing the dialog keeps the export running; a small badge in the
transport shows the percentage.

Chrome/Edge is auto-detected (override with `CHROME_PATH`); ffmpeg ships via
`ffmpeg-static` with a PATH fallback.

## Choosing a project

Opening `/` with no project shows the picker, which lists every registered
project; the transport bar also has a switcher to hop between them. Projects come
from two places:

- **In-tree:** any `projects/<name>/` with a `project.json`. The id is the folder
  name.
- **Out-of-tree:** absolute or repo-relative paths listed in `studio.config.json`
  at the repo root:

  ```json
  { "projects": ["../my-video", "C:/work/other-video"] }
  ```

`STUDIO_PROJECT=<path> npm run dev` registers one more path and makes it the
default. Otherwise the default is `groupchat` if present, else the first project.

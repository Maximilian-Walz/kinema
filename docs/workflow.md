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

## 2. Tune timings in the studio

`npm run dev`, open the project from the picker, and play it. The timeline is one
global clock across all scenes:

- Drag clips to move them, drag edges to retime, drag a scene block's right edge
  to change its length. Drags snap to the playhead, scene bounds, loop edges, and
  other clips.
- Double-click a script or caption clip to edit its text; `+ line / + caption /
  + element` insert at the playhead.
- Set a loop region with `I` / `O` to iterate on one stretch.

Every edit is undoable and written straight back into the scene's `scene.json`
(debounced ~0.5s). The hint bar above the timeline and the button tooltips list
the keys; there is nothing to memorize from docs.

## 3. Record voice

The SCRIPT tab is a teleprompter for the current scene. On the TAKES tab, record
restarts the scene so the take aligns with scene `t=0` and stops at the scene
boundary. The newest take is auto-picked; `★` re-picks an older one. If mic
latency pushed a take out of sync, drag its waveform in the VOICE track to align
it; that offset is used in both preview and export.

## 4. Export MP4

The EXPORT tab renders a frame-exact MP4: headless Chrome drives the stage under
frozen virtual time (so CSS transitions land on identical frames every run), PNGs
are piped to ffmpeg, and the picked takes are muxed in at their scene offsets plus
alignment offsets. Iterate on one scene at 15 fps with "this scene"; render the
final at 30 or 60. Expect roughly 5-10 captured frames per second of wall time.

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

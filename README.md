# video-studio

A local studio for data-driven animation videos: play and scrub HTML/CSS scenes on a global timeline, edit every timing by dragging clips, read the narration off a synced teleprompter, record per-scene voice takes, and export a frame-exact MP4 with the takes muxed in.

The studio is strictly separated from the content. A video is a **project**: a folder of scenes where each scene is plain HTML + CSS + a JSON file with timings and narration. The app never contains content; the content never contains player code. Humans and AIs edit one scene without touching anything else, and the files on disk are the single source of truth (no localStorage, no override layers).

## Setup

Requires Node.js and an installed Chrome or Edge (for export).

```
npm install
npm run dev
```

Open http://127.0.0.1:4321/. The GroupChat video loads by default; pick another project with:

```
STUDIO_PROJECT=projects/my-video npm run dev    # PowerShell: $env:STUDIO_PROJECT='...'
```

## UI

```
┌──────────────────────────────────┬──────────────┐
│                                  │ SCRIPT       │
│          STAGE (16:9)            │ TAKES        │
│                                  │ EXPORT       │
├──────────────────────────────────┴──────────────┤
│ ▶ play ⟲ ⟨ ⟩   timecode      ● rec  ◻ clean    │
├─────────────────────────────────────────────────┤
│ ruler      00:00      01:00      02:00     ...  │
│ SCENES    │ 1 │  2  │  3  │  4  │  5      │ ... │
│ SCRIPT     ▭▭▭ ▭▭▭▭ ▭▭▭ ▭▭▭▭▭                   │
│ CAPTIONS     ▭▭   ▭▭▭                           │
│ ELEMENTS   ◤s1win ◤s1q  ▭▭▭▭ (current scene)    │
│ VOICE      ▂▅▃▆▂▁   ▃▆▅▂  (picked takes)        │
└─────────────────────────────────────────────────┘
```

- **Timeline**: one global timeline across all scenes. Drag clips to move them, drag edges to retime, drag a scene block's right edge to change its length. Drags snap magnetically to the playhead, scene bounds, loop edges and other clips (hold `shift` for free placement). Click selects, `ctrl+click` toggles, dragging empty space draws a marquee; dragging any selected clip moves the whole selection; `del` deletes. Double-click a script/caption clip to edit its text; `+ line / + caption / + element` insert at the playhead (dragging a marker's right edge gives it an exit). Every edit is undoable (`ctrl+Z` / `ctrl+shift+Z`) and written back into the scene's `scene.json` (debounced, ~0.5s). Click anywhere to seek, `ctrl+wheel` to zoom, − / fit / + buttons.
- **Loop region**: `I`/`O` set the in/out point at the playhead (or `alt+drag` on the ruler); playback loops inside it; `esc` clears.
- **SCRIPT tab**: teleprompter for the current scene; the current line highlights and autoscrolls during playback; click a line to seek, double-click to edit its text.
- **TAKES tab**: record restarts the current scene so the take aligns with scene t=0 and stops at the scene boundary. All takes are kept (delete = move to `takes/<scene>/trash/`); the newest is auto-picked, ★ re-picks. Picked takes play in sync during playback. Drag the take's waveform in the VOICE track to align the recording against the scene (mic latency); the offset is used in preview and export.
- **EXPORT tab**: frame-exact MP4 (headless Chrome under CDP virtual time → ffmpeg, picked takes muxed at scene offsets + alignment offsets). Iterate with "this scene" at 15 fps; final at 30/60.
- **Recording** auto-switches to SCRIPT so you can read while speaking; a red bar with stop stays visible.

Keys: `SPACE` play/pause · `R` restart scene · `←/→` ±5s (`shift` ±1s) · `[` `]` scene · `1-9` jump · `I`/`O` loop in/out · `del` delete selection · `ctrl+Z` undo · `C` clean mode (stage only, for screen capture) · `ESC` stop recording / clear loop.

## Project format

```
projects/<name>/
├── project.json          # name, stage size, scene order
├── theme.css             # shared styles for all scenes
├── scenes/
│   └── 01-intro/
│       ├── scene.html    # stage markup (mounted into #scenecontent)
│       ├── scene.css     # scene-scoped styles
│       └── scene.json    # title, len, schedule, captions, lines
├── takes.json            # picked take per scene (written by the app)
├── takes/                # recorded voice takes (runtime, gitignored)
└── exports/              # rendered MP4s (runtime, gitignored)
```

`scene.json`:

```jsonc
{
  "title": "INTRO",
  "len": 35,                  // seconds
  "behaviors": [],            // optional engine behaviors, e.g. "thread-autoscroll"
  "schedule": [               // element enter/exit times (seconds, scene-local)
    { "id": "logo", "enter": 0.4 },                       // fires and stays on
    { "id": "card", "enter": 3.0, "exit": 9.5 },          // on for a window
    { "id": "card", "enter": 5.0, "cls": "hl" }           // custom class toggle
  ],
  "captions": [ { "from": 4, "to": 9, "text": "lower-third caption" } ],
  "lines":    [ { "from": 0, "to": 8, "text": "narration line…" } ]
}
```

Rules for scene markup:
- Everything on the stage is a pure function of the clock: the engine toggles `cls` (default `"on"`) on `#id` per the schedule, so scrubbing works in both directions. Use CSS transitions for the actual motion (the generic `.el`/`.el.on` helper pattern lives in `theme.css`).
- The stage is `project.json`'s `width`×`height` (1920×1080); scene markup mounts into `#scenecontent` which fills it.
- Include `<div id="caption"></div>` in the scene if it uses captions.
- Changes to `scene.html` / `scene.css` / `project.json` on disk auto-reload the app; `scene.json` timing edits flow the other way (UI → disk).

## Export

`/?render=1` boots a bare stage and exposes `window.__render`; `server/render.mjs` drives it in headless Chrome with frozen virtual time, advancing exactly `1000/fps` ms per captured frame, so CSS transitions land on identical frames every run. PNGs are piped to ffmpeg (libx264 crf 18, yuv420p), then picked takes are muxed at their scene offsets (AAC 192k, trimmed to scene length). Chrome/Edge is auto-detected; override with `CHROME_PATH`. ffmpeg comes from `ffmpeg-static` with PATH fallback.

Expect roughly 5–10 captured frames per second of wall time.

## Smoke test

With the dev server running:

```
node scripts/smoke.mjs
```

Boots the studio and render mode in headless Chrome and checks mounting, schedule application, timeline build, timings round-trip, and the render contract.

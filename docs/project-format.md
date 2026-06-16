# Project format

A video is a **project**: a folder of scenes. The studio never holds content and
the content never holds player code, so a human or an AI can edit one scene
without touching anything else. The files on disk are the single source of truth
(no localStorage, no override layers).

This is the contract the loader ([server/api.mjs](../server/api.mjs) `loadProject`),
the engine ([src/engine/player.ts](../src/engine/player.ts)) and the validator
([scripts/validate.mjs](../scripts/validate.mjs)) all agree on. Keep it precise:
the AI skill consumes this doc too.

## Layout

```
projects/<name>/
├── project.json          # name, stage size, scene order
├── theme.css             # shared styles, loaded once before any scene css
├── scenes/
│   └── 01-intro/
│       ├── scene.html    # stage markup, mounted into #scenecontent
│       ├── scene.css     # scene-scoped styles
│       └── scene.json    # title, len, schedule, captions, lines
├── takes.json            # picked take + alignment per section (written by the app)
├── takes/                # recorded voice takes, takes/<sceneId>/<lineId>/ (runtime, gitignored)
└── exports/              # rendered MP4s (runtime, gitignored)
```

A scene id must match `[\w.-]+` (it becomes a folder name and a route segment).
Scene order is whatever `project.json` lists, not alphabetical.

## project.json

```jsonc
{
  "name": "Meet video-studio",  // shown in the picker; defaults to the folder name
  "width": 1920,                // stage size, defaults to 1920x1080
  "height": 1080,
  "scenes": ["01-what", "02-timeline", "03-takes"]   // order = timeline order
}
```

## scene.json

```jsonc
{
  "title": "WHAT IT IS",       // label on the timeline; defaults to the scene id
  "len": 28,                   // scene length in seconds (positive number, required)
  "behaviors": [],             // optional engine behaviors, see below
  "schedule": [                // element enter/exit times, seconds, scene-local
    { "id": "title", "enter": 0.4 },                  // turns on and stays on
    { "id": "card",  "enter": 3.0, "exit": 9.5 },     // on only for a window
    { "id": "card",  "enter": 5.0, "cls": "hl" },     // toggle a custom class
    { "id": "note",  "enter": 6.0, "fx": "up" }       // entrance animation preset
  ],
  "captions": [ { "from": 4, "to": 9, "text": "lower-third caption" } ],
  "lines":    [ { "id": "ln-x1", "from": 0, "to": 8, "text": "narration line read on the prompter" } ]
}
```

`title`, `behaviors`, and any fields the app does not manage are preserved on
write. The app only writes back `len`, `schedule`, `captions`, and `lines` (the
draggable timing fields), so you can keep extra keys in `scene.json` safely.

### schedule

Everything on the stage is a pure function of the scene clock `t`, so scrubbing
works in both directions. For each entry the engine toggles a class on the
element with that `#id`:

- on when `t >= enter` and (no `exit`, or `t < exit`); off otherwise.
- the class is `cls` if given, else `"on"`.
- multiple entries can target the same id (e.g. one to reveal it, another to add
  a highlight class over a window).
- `fx` (optional) names an **entrance-animation preset**. When set, the engine
  keeps a `fx-<name>` base class on the element for the whole scene (so it sits
  in the preset's hidden "before" state) and toggles `cls` to animate it in. The
  theme defines the `.fx-<name>` / `.fx-<name>.on` rules (see `theme.css`:
  `fade`, `up`, `down`, `left`, `right`, `pop`). The SCENE-mode editor sets this
  from a dropdown, so you can pick an entrance animation without editing CSS.

The engine never animates directly. It only flips classes. Put the motion in CSS
transitions so a class change looks the same played forward or scrubbed backward.

### captions

A scene with captions must include `<div id="caption"></div>` in its markup. The
engine fills it with the active caption's text and toggles `.on`; at most one
caption shows at a time (the first whose `[from, to)` contains `t`). The caption
band is a reserved lower third, so keep scene content above it.

### lines

Narration for the teleprompter. The current line highlights and autoscrolls
during playback, and exports do not use the line text. Aim for ~2.5 words/second
when sizing a line's `[from, to)` window against the spoken take.

Each line is also a **section**: the unit a voice take covers. A take records
one line and is keyed by that line's **stable `id`** (a string matching
`[\w.-]+`, unique within the scene). The id is what survives edits, inserts and
reorders so a recorded take stays bound to its line. Write a short id per line
(e.g. `"id": "ln-1"`); the validator checks ids are unique within a scene when
present. Lines authored without an `id` still load: the app fills any missing
id on first load and persists it back into `scene.json`, so older projects keep
working. Captions do not carry an id. Merging two lines in the UI keeps the
first line's id (and its takes) and drops the second.

## Scene markup rules

- Markup mounts into `#scenecontent`, which fills the `width`x`height` stage
  (1920x1080 by default). `theme.css` styles `#scenecontent` and resets its
  descendants.
- Use ids for everything the schedule drives; the validator flags a `schedule`
  entry whose `id` has no matching `#id` in `scene.html`.
- Include `<div id="caption"></div>` if the scene uses captions.
- `scene.html` / `scene.css` / `project.json` changes on disk auto-reload the
  app. `scene.json` timing edits flow the other way (UI to disk, debounced ~0.5s).
- SCENE mode can edit on-screen text — a leaf element's own text is patched into
  `scene.html` byte-faithfully; text nested inside an animated div is edited per
  text run (the element's inner HTML is rewritten, the rest of the file intact).
- SCENE mode also writes per-element **visual overrides** (font size, colour,
  position) into a generated region of `scene.css`, delimited by
  `/* studio:overrides … */ … /* studio:overrides:end */`, one `#id{}` rule each.
  Edit elsewhere in `scene.css` freely; the studio only rewrites that region.
  Position uses the `translate` property so it composes with the entrance
  animation's `transform` instead of fighting it.

## theme.css helpers

`theme.css` loads once before any scene CSS. Two helper patterns are worth
reusing across scenes (see [projects/intro/theme.css](../projects/intro/theme.css)):

- `.el` — starts hidden and shifted down; `.el.on` fades and slides it into
  place. Give a scheduled element `.el` and it animates in when its entry fires.
- `.ovl` — a full-stage overlay that fades in on `.on`. Stack several and toggle
  between them for full-frame beats.

## behaviors

`behaviors` lists per-scene engine routines that run every frame (beyond the pure
class toggling). Currently the engine implements one:

- `thread-autoscroll` — keeps the newest visible message in view inside
  `#threadview` / `#threadcol` (used by the groupchat debate scene).

Add new behaviors in `runBehaviors` in [src/engine/player.ts](../src/engine/player.ts).

## Validate

```
node scripts/validate.mjs projects/<name>
```

Reads the project straight off disk (no dev server) and checks the mistakes
people and AIs make by hand: missing files, bad `len`, schedule ids with no
matching element, enter/exit outside `[0, len]` or `exit < enter`. Span ordering,
overlaps, out-of-range captions/lines, and a missing caption div are warnings.
Errors exit non-zero; warnings do not.

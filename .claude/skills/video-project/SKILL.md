---
name: video-project
description: >
  Create or revise a Kinema project (a folder of HTML/CSS/JSON scenes on a
  global timeline). Use when the user wants to draft a new video from a topic,
  article, or outline; add or revise a single scene in an existing project; or
  retime a scene against narration they have edited. Scaffolds with
  scripts/new-project.mjs, reads docs/project-format.md, validates with
  scripts/validate.mjs.
---

# video-project

Generate and revise Kinema projects. The studio plays plain web files on one
timeline; a video is a folder of scenes, each scene three files. You write those
files — the user then records real voice over them and fine-tunes in the studio.
The format is the contract; the craft is what makes it watchable.

## Read first

The file format is authoritative in **docs/project-format.md** (layout,
`project.json`, `scene.json`, schedule/captions/lines semantics, `theme.css`
helpers, behaviors). Read it before writing anything. This skill does not restate
it; it adds the craft and the workflows.

**projects/intro** is the reference for *patterns*, not for scale: its
`theme.css` carries the palette, the `.el`/`.ovl` helpers and the canonical
`.fx-*` preset block, and its scene.json files show schedule entries landing on
narration beats. But its scenes are a produced tour that mocks the studio's own
UI — don't take them as the template for an ordinary content scene, and don't
copy their markup. A typical scene is far smaller: a heading, a few elements, a
caption div.

## The craft

What separates a valid project from a watchable one:

- **Script first, then everything else.** Write the full narration before laying out
  a single scene. The script decides the scenes, their order, and their lengths.
  The user will read this script aloud, line by line, into a mic — write lines
  that a person can actually say (short sentences, no nested clauses, no
  citations mid-sentence).
- **Pace narration at ~2.5 words/second.** A `lines` window of `[from, to)` should
  hold about `2.5 * (to - from)` words. A 5-second line is ~12 words. This is how
  you size both the line windows and the scene.
- **Derive scene `len` from its narration**, never pick a round number. Sum the
  line windows, add ~0.5-1s of breathing room at the end. A scene with 60 words of
  narration is ~24s, not "30 because 30 is tidy".
- **Land schedule entries on the narration beats.** An element appears when the line
  that introduces it starts. Read the `from` of the relevant line and set `enter`
  to match (or a beat before).
- **Motion lives in CSS, the engine only toggles classes.** Never animate from
  JavaScript. A class change must look identical played forward or scrubbed
  backward, so use CSS transitions, not keyframe animations tied to wall time.
- **Two ways to animate; prefer the `fx` preset for new work.** Set `fx` in the
  schedule (`up`/`fade`/`down`/`left`/`right`/`pop`) and the theme's `.fx-*` rules
  animate it — fully driven by the SCENE editor's animation dropdown, no scene CSS.
  Class-based (`.el` etc.) is the alternative for bespoke motion, but the dropdown
  can't see it (reads "none"). **A new project's `theme.css` must contain the
  `.fx-*` block** (the scaffold below brings it along) or the dropdown does
  nothing. `.el` is just the class-based equivalent of `fx: "up"`.
- **Overlays dissolve; nothing gets left `on`.** For full-frame beats, stack
  `.ovl` overlays: the first carries `class="ovl on"` in markup plus a schedule
  entry `{ "enter": 0, "exit": t }`, and the next enters at that same `t`. An
  overlay without an exit stays fully lit underneath and bleeds through the
  incoming fade.
- **One element, two on-windows → two class names.** Schedule entries sharing an
  `id` *and* `cls` are last-wins per frame (see project-format.md), so a second
  appearance window silently blanks the first. Give it a distinct class with the
  same CSS (e.g. `.bar.on, .bar.replay { … }`).
- **1920x1080 stage. Keep content above the caption band.** The lower third is
  reserved for captions. If a scene uses captions, include `<div id="caption"></div>`
  and keep real content out of the bottom band.
- **Captions are optional and sparse.** They are short on-screen paraphrases of the
  key narration beats, a lower-third reinforcement, not a transcript. At most one
  shows at a time.
- **Give every scheduled element an `id`.** The validator flags a schedule entry
  whose `id` has no matching `#id` in `scene.html`.
- **Give every narration line a stable `id`.** A voice take covers one line (a
  "section") and is keyed by that line's `id`. Emit one per line, matching
  `[\w.-]+` and unique within the scene (e.g. `"id": "ln-1"`, `"ln-2"`). The
  validator flags duplicate or malformed ids. When you revise a scene, keep each
  surviving line's existing `id` so its recorded take stays attached; only new
  lines need a fresh id.

## Workflows

### (a) New project from a topic, article, or outline

1. **Script.** Write the narration as prose first, broken into scenes. One idea per
   scene. Confirm the script with the user before building if the topic is open-ended.
2. **Plan scenes.** For each scene, split the script into `lines` and size each window
   at ~2.5 w/s. Sum them to get `len`.
3. **Scaffold.** Run `node scripts/new-project.mjs <name> "Display Name"`. It copies
   the intro as a template (minus takes/exports). Then make it yours: delete the
   intro's scene folders, write your own, list them in `project.json`, and trim
   `theme.css` — keep the palette, `.el`/`.ovl`/`.fx-*` helpers and `#caption`,
   delete the marked "mock studio chrome" section (it exists only for the intro's
   own tour).
4. **Build each scene.** `scene.html` (markup with ids, `#caption` if used),
   `scene.css` (scene-scoped look), `scene.json` (`title`, `len`, `schedule`,
   `captions`, `lines`). Put schedule entries on the line beats.
5. **Validate** (see below) and fix everything it reports.

### (b) Revise or add one scene in an existing project

1. **Read the existing scene first**, all three files. For an added scene, read a
   neighbor and the project's `theme.css` so the new scene matches the house style.
2. Edit only that scene's files (and add its id to `project.json` `scenes` if new).
   Do not touch other scenes.
3. **Preserve the user's timings.** Treat the existing `len`, `schedule`, `captions`,
   and `lines` in `scene.json` as the user's own work. Do not silently overwrite them.
   If a change forces a retime, say so and propose it; do not just rewrite the numbers.
4. Validate and fix.

### (c) Retime a scene against edited narration

1. **Read the edited `scene.json`.** The user has changed `lines` text (and maybe
   the script). Their existing windows and schedule are the starting point, not a
   blank slate.
2. Re-size each line window to ~2.5 w/s for the new text, shift later lines to keep
   them sequential, adjust `len` to fit, and move `schedule` / `captions` entries so
   they still land on their beats.
3. **Show the diff in timings and confirm** before writing. The user edited these by
   hand for a reason; explain any window you move.
4. Validate and fix.

## Validate, then look at it

After writing or editing, always run:

```
node scripts/validate.mjs projects/<name>
```

It checks missing files, bad `len`, schedule ids with no matching element, and
enter/exit out of `[0, len]` (errors, exit non-zero); span ordering, overlaps,
out-of-range captions/lines, and a missing caption div are warnings. Fix every error
and look at each warning. Re-run until clean.

Validation can't see layout. With the dev server up (`npm run dev`, note the
port), open `http://localhost:<port>/?project=<name>` — or, headlessly, drive
that page with puppeteer-core, `window.__studio.player.seek(t)` to each scene's
key beats, and screenshot the stage (press `c` first for clean mode). Look at
the frames: overlapping text, content in the caption band, and mistimed
entrances only show up visually.

Two live-studio caveats: `scene.html`/`scene.css` hot-reload on save, but
`scene.json` flows the other way (studio → disk, debounced) — after editing
timings on disk while the studio is open, reload the browser tab, and don't
edit timings on disk while the user is dragging clips.

## Don't

- Don't bake another project's content (the intro's copy, a sample scene's text) into a
  generated project. Distill the patterns, not the words.
- Don't animate from JavaScript or add engine behaviors casually. `behaviors` are
  per-scene engine routines listed in project-format.md; only use one that exists.
- Don't pick scene lengths or line windows by feel. Derive them from word count.
- Don't overwrite a user's hand-tuned `scene.json` timings without telling them.
- Don't leave the intro's mock-studio CSS or scenes in a scaffolded project.

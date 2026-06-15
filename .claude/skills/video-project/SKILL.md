---
name: video-project
description: >
  Create or revise a video-studio project (a folder of HTML/CSS/JSON scenes on a
  global timeline). Use when the user wants to draft a new video from a topic,
  article, or outline; add or revise a single scene in an existing project; or
  retime a scene against narration they have edited. Reads docs/project-format.md
  and validates with scripts/validate.mjs.
---

# video-project

Generate and revise video-studio projects. The studio plays plain web files on one
timeline; a video is a folder of scenes, each scene three files. You write those
files. The format is the contract; the craft is what makes it watchable.

## Read first

The file format is authoritative in **docs/project-format.md** (layout,
`project.json`, `scene.json`, schedule/captions/lines semantics, `theme.css`
helpers, behaviors). Read it before writing anything. This skill does not restate
it; it adds the craft and the workflows.

**projects/intro** is the reference project. Its `theme.css` has the `.el` / `.ovl`
helpers worth reusing, and its scenes are deliberately small so they read as
examples. Copy patterns from it, not content.

## The craft

What separates a valid project from a watchable one:

- **Script first, then everything else.** Write the full narration before laying out
  a single scene. The script decides the scenes, their order, and their lengths.
- **Pace narration at ~2.5 words/second.** A `lines` window of `[from, to)` should
  hold about `2.5 * (to - from)` words. A 5-second line is ~12 words. This is how
  you size both the line windows and the scene.
- **Derive scene `len` from its narration**, never pick a round number. Sum the
  line windows, add ~0.5-1s of breathing room at the end. A scene with 60 words of
  narration is ~24s, not "30 because 30 is tidy".
- **Land schedule entries on the narration beats.** An element appears when the line
  that introduces it starts. Read the `from` of the relevant line and set `enter`
  to match (or a beat before). The intro and groupchat scenes show this: every
  `enter` lines up with a `lines[].from`.
- **Motion lives in CSS, the engine only toggles classes.** Give an element `.el`
  and it fades + slides in on `.on`; schedule it and it animates when its `enter`
  fires. Use `.ovl` for full-frame beats; stack overlays and let an opaque one cover
  the previous (no `exit` needed). Never animate from JavaScript. A class change must
  look identical played forward or scrubbed backward.
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
  lines need a fresh id. (Lines authored without an id still load, but emitting
  them keeps takes stable from the start.)

## Workflows

### (a) New project from a topic, article, or outline

1. **Script.** Write the narration as prose first, broken into scenes. One idea per
   scene. Confirm the script with the user before building if the topic is open-ended.
2. **Plan scenes.** For each scene, split the script into `lines` and size each window
   at ~2.5 w/s. Sum them to get `len`.
3. **Scaffold.** Create `projects/<name>/` with `project.json` (name, scene order,
   1920x1080), a `theme.css` (start from projects/intro/theme.css so `.el`/`.ovl`
   exist), and `scenes/<id>/` folders. Scene ids match `[\w.-]+`.
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

## Validate

After writing or editing, always run:

```
node scripts/validate.mjs projects/<name>
```

It checks missing files, bad `len`, schedule ids with no matching element, and
enter/exit out of `[0, len]` (errors, exit non-zero); span ordering, overlaps,
out-of-range captions/lines, and a missing caption div are warnings. Fix every error
and look at each warning. Re-run until clean.

## Don't

- Don't bake project-specific content (groupchat's agents, the intro's copy) into a
  generated project. Distill the patterns, not the words.
- Don't animate from JavaScript or add engine behaviors casually. `behaviors` are
  per-scene engine routines listed in project-format.md; only use one that exists.
- Don't pick scene lengths or line windows by feel. Derive them from word count.
- Don't overwrite a user's hand-tuned `scene.json` timings without telling them.

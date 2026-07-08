# Backlog

Open ideas for the SCENE/TIME editor. Architecture orientation lives in
[../CLAUDE.md](../CLAUDE.md). Delete items as they land.

- **Editable element labels** (`data-label`) via the HTML patch — names are
  read-only/derived today.
- **Per-element transition duration/easing** — expose a `--fx-dur` the presets
  read, set via the `scene.css` override (pairs with the fx presets).
- **Scene-level ops in the UI**: duplicate / reorder scenes (currently a
  `project.json` hand-edit), duplicate a schedule entry.
- **Jump-to-entrance** key on a selected element (replay its animation quickly).

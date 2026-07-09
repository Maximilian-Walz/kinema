# Projects and git — recommended setup

A **project** (a folder of scenes) is a *document*, not part of the Kinema tool.
So the studio repo deliberately does **not** track your videos: [.gitignore](../.gitignore)
ignores `/projects/*` with one exception — `projects/intro`, which ships tracked
as the onboarding template.

That separation is the point: the tool's history stays about the tool, and each
video keeps its own history (script revisions, retimes, recorded takes) where it
belongs — with the video.

## Recommended: each project is its own git repo

Make every real project an independent repository. Two layouts work; pick by
whether you want the files sitting inside the checkout.

### A. In-tree, nested repo (simplest)

Keep the project under `projects/` and `git init` it there. Because `projects/*`
is gitignored, the studio repo never sees it — the two histories never collide.

```sh
cd projects/my-video
git init
git add -A && git commit -m "first cut"
git remote add origin <your-remote>
```

The studio repo shows nothing for `projects/my-video` in `git status`; the
project repo shows nothing about the tool. Commit project work *in the project
repo* (`cd projects/my-video && git ...`). It's a plain nested repo, **not** a
submodule — the studio neither tracks nor pins it, so you can move or clone the
folder into any other checkout's `projects/` and it just works.

Ignore generated artifacts inside the project repo (the studio already excludes
them from the *studio* repo, but the *project* repo should too):

```gitignore
# recorded voice .webm/.wav — large, regenerable per take
takes/
# rendered MP4s
exports/
```

(Keep each comment on its own line — a `.gitignore` has no inline comments, so
`takes/ # …` would be read as a literal pattern and ignore nothing.)

### B. Out-of-tree, referenced by config

Keep the project anywhere on disk (its own repo, a synced folder, a sibling
checkout) and point the studio at it via `studio.config.json` in the repo root
(read by [server/plugin.mjs](../server/plugin.mjs)). This is machine-local and
gitignored. Use it when you'd rather not have the files inside the checkout at
all, or want them on a different drive.

## Why not submodules?

Submodules make the studio repo *pin a specific project commit* — useful for code
dependencies, wrong for documents. You'd be coupling tool releases to video
edits, and every project change would dirty the studio repo. Independent repos
(A or B) keep the two concerns fully decoupled.

## The `intro` exception

`projects/intro` is tracked **inside** the studio repo as the canonical demo, so
a fresh clone has something to open. Treat it as part of the tool: edit it via
normal studio commits, not a nested repo.

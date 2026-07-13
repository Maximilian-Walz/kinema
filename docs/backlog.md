# Backlog

Open work for Kinema. Architecture orientation lives in
[../CLAUDE.md](../CLAUDE.md). Delete items as they land.

## Repo / public-facing (repo is public: github.com/Maximilian-Walz/kinema)

Suggested first batch: items 1–3 together (contributor docs, roadmap grooming,
tag `v0.1.0`).

1. **Contributor docs** — `CONTRIBUTING.md` distilling CLAUDE.md for humans:
   dev setup, the check suite (`typecheck` / `validate` / `smoke` /
   `stage-check`), and the "write a small puppeteer script against the dev
   server, verify, delete" pattern. Plus issue/PR templates.
2. **Groom this file as the public roadmap** (or mirror it into GitHub issues)
   so visitors see direction and what's up for grabs.
3. **First release** — tag `v0.1.0` with a short changelog; establish a cadence.
4. **Unit tests for the server patchers** — `element-text/html/id/label` and
   `nthElementChild` in [server/api.mjs](../server/api.mjs) are regex-based
   HTML surgery over strings; test weird markup, comments, nested same tags,
   self-closing SVG. CI only hits happy paths via stage-check today.
5. **Security/scope note + supply chain** — README paragraph: the dev server is
   a local, trusted tool (binds 127.0.0.1, writes files by design), don't
   expose it; all endpoints gate ids through `safeName`. Add Dependabot.
6. **CI matrix** — add `windows-latest` (dev happens on Windows, CI is Ubuntu;
   make the coverage deliberate: paths, ffmpeg/chrome discovery).
7. **Media weight** — `docs/media` (~3.5 MB) churns whenever the demo MP4 is
   re-exported and history only grows; move the video to GitHub Releases or
   LFS before re-exports become a habit.

## Features

1. **Music/SFX track** — the biggest capability gap: only one audio lane
   (voice). A music-bed lane with auto-ducking under narration (Web Audio
   preview + ffmpeg `sidechaincompress` on export).
2. **Loudness leveling across takes** — normalize takes to a target (e.g.
   −16 LUFS) at export; `src/audio/loudness.ts` already exists. Fixes
   "each take recorded at a different distance" with zero UI.
3. **Recording ergonomics** — input-device picker (default mic only today);
   punch-in flow (re-record just the tail of a take).
4. **Exit animations** — fx presets are entrance-only; add a symmetric exit
   preset dropdown (exits currently = whatever CSS does on class removal).
5. **Export options** — draft-quality/low-fps fast export for review cycles;
   time-range export UI (single-scene export exists server-side).
6. **In-UI project management** — new-project scaffold from the picker
   (currently `scripts/new-project.mjs`); cleanup tool for orphan scene
   folders left by soft-delete / duplicate-undo.
7. **Lean into the AI angle** — `docs/ai-workflow.md` showing an agent building
   a video with the `video-project` skill, or package that as an MCP server;
   it's the differentiator the end card already sells.

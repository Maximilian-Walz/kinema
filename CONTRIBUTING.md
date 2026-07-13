# Contributing to Kinema

Contributions are welcome, from humans and from AI agents driven by humans.
This file is the process; the code map (architecture, where edits persist, the
verify loop) is [AGENTS.md](AGENTS.md).

## Dev setup

Node 22+ and a Chromium-based browser (the export path finds an installed
Chrome/Edge, or downloads one).

```
npm ci
npm run dev      # Vite + the file/export server; note the port it prints
```

## Picking work

Open work lives in [GitHub Issues](https://github.com/Maximilian-Walz/kinema/issues)
and the [roadmap board](https://github.com/users/Maximilian-Walz/projects/1).

- No label = scoped and ready to implement.
  [`good first issue`](https://github.com/Maximilian-Walz/kinema/labels/good%20first%20issue)
  marks self-contained entry points.
- [`needs refinement`](https://github.com/Maximilian-Walz/kinema/labels/needs%20refinement)
  = the scope or design is still open. These are not ready to implement, but
  they are good targets for a *refinement* contribution: propose a design,
  ask the questions that pin the scope down, sketch trade-offs in the issue
  thread. Agents are good at this; point one at the issue and let it interview
  you. The label drops when the issue is implementable.

## Before you open a PR: verify

```
npm run check    # typecheck + validate + build (the same static gates CI runs)
```

Runtime checks need the dev server up:

```
node scripts/stage-check.mjs http://127.0.0.1:<port>       # SCENE-mode editor checks
STUDIO_URL=http://127.0.0.1:<port> node scripts/smoke.mjs  # boot + render mode
```

`stage-check.mjs` mutates `projects/intro` by design; restore with
`git checkout -- projects/intro` afterwards.

For editor behaviour beyond what those scripts cover, the house pattern is a
throwaway `puppeteer-core` script that drives the running dev server and reads
state off `window.__studio`: write one, run it, confirm the behaviour, delete
it. CI (typecheck, validate, build, smoke, stage-check) runs on every PR, but
green CI is the floor, not the bar: exercise the flow you changed.

## Pull requests

- Keep PRs small and scoped; one issue per PR where possible, referenced with
  `fixes #N`.
- Fill in the **How verified** section of the PR template. Say what you ran
  and what you observed, not just that checks pass.
- Match the surrounding style: vanilla TypeScript, the `el()` DOM builder from
  [src/ui/dom.ts](src/ui/dom.ts), no frameworks, terse comments that explain
  *why*. Keep studio chrome out of the stage content's styles.
- No em-dashes in prose (docs, issue text, commit messages); rephrase with a
  colon, semicolon, or parentheses.

## Working with AI agents

Most contributors will work with an agent; that's encouraged and how much of
this repo is built. To keep it efficient:

- **Point your agent at [AGENTS.md](AGENTS.md).** Most tools (Claude Code,
  Codex, Cursor, Gemini CLI, Copilot) pick it up automatically. It contains
  the architecture map and the verify loop, so the agent doesn't rediscover
  them from scratch.
- **The verify loop is the contract.** Have the agent run `npm run check` and
  the runtime scripts, and reproduce the behaviour it changed (the throwaway
  puppeteer script pattern above). Then write the PR's "How verified" section
  from what actually ran.
- **You own the PR.** Agent-written or not, the human opening it is
  responsible for having seen the change work end-to-end.
- **Use agents for refinement too.** On a `needs refinement` issue, an agent
  that reads the codebase and asks the maintainer the right questions in the
  issue thread is a valuable contribution on its own; no code required.

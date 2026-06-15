# Tickets: personal tool to team tool

Breakdown of PLAN.md into session-sized tickets. Each file is self-contained: read
the repo README.md first (formats, architecture), then the ticket. Work them in
order unless a ticket says otherwise. Style: concise, developer-to-developer, no
em-dashes.

## Decisions (settled 2026-06-15)
- **Project location: both.** Scan `projects/*` in this repo (each its own git repo,
  gitignored here) AND allow out-of-tree folders via config / `STUDIO_PROJECT`.
- **Distribution: clone the repo.** Skill and docs ship in-repo.
- **Skill location: in-repo `.claude/skills/`.**

## Order and dependencies

| # | Ticket | Depends on | Plan item |
|---|--------|-----------|-----------|
| 01 | [Multi-project server API](01-picker-server.md) | - | 1 |
| 02 | [Project picker UI](02-picker-ui.md) | 01 | 1 |
| 03 | [validate.mjs](03-validate-script.md) | - | 4 |
| 04 | [Example "intro" project](04-intro-project.md) | 01, 02, 03 | 2 |
| 05 | [Documentation](05-documentation.md) | 04 | 3 |
| 06 | [video-project skill](06-skill.md) | 03, 04, 05 | 4 |
| 07 | [Polish for other machines](07-polish.md) | 01 | 5 |

03 is independent of the picker and can be done in any early session. 04 onward
assume the picker exists so the intro project is selectable.

## Status legend
`todo` / `in-progress` / `done`. Update the status line at the top of each ticket as
you go.

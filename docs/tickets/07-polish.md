# 07 - Polish for other machines

Status: todo
Depends on: 01 (server changes touch the same files)
Plan item: 5 (small, do last)

## Goal
Make the tool behave on a colleague's machine: clean port handling, friendly error
screens, cross-platform Chrome detection.

## Scope
1. **Port.** `npm start`/`npm run dev` use Vite with `strictPort: false` already (see
   [vite.config.ts](../../vite.config.ts)), so it will pick another port if 4321 is
   taken. Make the picked URL print clearly on startup (the plugin already logs in the
   `listening` handler in [server/plugin.mjs](../../server/plugin.mjs); ensure the actual
   URL, not a hardcoded 4321, is shown).
2. **Friendly error screens.** Today failures are console-only. Show an in-page message
   for: no project found / empty registry, and `project.json` invalid or scene files
   missing. The API throws (see `loadProject` in [server/api.mjs](../../server/api.mjs));
   surface those as a readable screen in the front-end boot path
   ([src/main.ts](../../src/main.ts)) instead of a blank stage or unhandled rejection.
3. **Chrome detection cross-platform.** Export auto-detects Chrome/Edge with a
   `CHROME_PATH` override (see [server/render.mjs](../../server/render.mjs) and README
   Export section). Verify the detection paths cover Windows and macOS; if possible test
   on a colleague's Mac. Make the failure message name `CHROME_PATH` as the fix.

## Files
- server/plugin.mjs (startup URL log)
- src/main.ts (error screen on boot failure)
- src/api.ts (surface API errors with usable messages)
- server/render.mjs (Chrome path coverage, clear failure message)
- src/ui/styles.css (error screen styling)

## Acceptance criteria
- Starting with 4321 busy prints the real URL it bound to.
- Pointing at a missing/invalid project shows a readable in-page error, not a blank page
  or console-only failure.
- Export on a machine without Chrome on PATH gives a message that names `CHROME_PATH`.
- Chrome detection confirmed on Windows; macOS verified if a Mac is available (note the
  result).

## Notes
- Keep it small. This is the last ticket; do not gold-plate.

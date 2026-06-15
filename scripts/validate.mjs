/* ============================================================================
   Standalone project validator — no dev server required.

     node scripts/validate.mjs [projectDir]

   With no arg it validates the resolved default project (same rules as the
   server: STUDIO_PROJECT, else groupchat, else the first projects/*). Reads
   files straight off disk the way server/api.mjs loadProject does, and checks
   the mistakes a human or an AI most often makes hand-writing scene files:

     - project.json parses; every scene resolves to scenes/<id>/ with
       scene.html, scene.css, scene.json
     - each scene.json parses; len is a positive number
     - every schedule[].id exists as an #id in that scene's scene.html
     - schedule enter/exit are within [0, len] and enter <= exit
     - lines/captions have from <= to, sit within [0, len], and are ordered
       (overlap / out-of-range here is a warning, not a failure)
     - a scene using captions includes <div id="caption"></div> (warning)

   Errors fail the run (exit 1); warnings are printed but exit 0.
============================================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRegistry } from '../server/plugin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/* forgiving id scrape — no DOM parser, just every id="..."/id='...' */
function htmlIds(html) {
  const ids = new Set();
  const re = /\bid\s*=\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(html))) ids.add(m[1]);
  return ids;
}

/* a single scene's findings; round times for readable messages */
function checkScene(sid, dir) {
  const errors = [];
  const warnings = [];
  const e = (msg) => errors.push(msg);
  const w = (msg) => warnings.push(msg);
  const num = (n) => (Math.round(n * 100) / 100);

  for (const f of ['scene.html', 'scene.css', 'scene.json']) {
    if (!fs.existsSync(path.join(dir, f))) e(`missing ${f}`);
  }
  if (errors.length) return { errors, warnings }; // nothing more to check

  let data;
  try { data = readJson(path.join(dir, 'scene.json')); }
  catch (err) { e(`scene.json does not parse: ${err.message}`); return { errors, warnings }; }

  const len = data.len;
  if (typeof len !== 'number' || !(len > 0)) {
    e(`len must be a positive number (got ${JSON.stringify(len)})`);
  }
  const max = typeof len === 'number' && len > 0 ? len : Infinity;
  const maxs = num(max);

  const ids = htmlIds(fs.readFileSync(path.join(dir, 'scene.html'), 'utf8'));

  for (const [i, s] of (data.schedule || []).entries()) {
    const where = `schedule[${i}] (id="${s.id}")`;
    if (!s.id) { e(`${where}: missing id`); continue; }
    if (!ids.has(s.id)) e(`${where}: no #${s.id} in scene.html`);
    if (typeof s.enter !== 'number') { e(`${where}: enter must be a number`); continue; }
    if (s.enter < 0 || s.enter > max) e(`${where}: enter ${num(s.enter)} outside [0, ${maxs}]`);
    if (s.exit !== undefined) {
      if (typeof s.exit !== 'number') e(`${where}: exit must be a number`);
      else {
        if (s.exit < 0 || s.exit > max) e(`${where}: exit ${num(s.exit)} outside [0, ${maxs}]`);
        if (s.exit < s.enter) e(`${where}: exit ${num(s.exit)} < enter ${num(s.enter)}`);
      }
    }
  }

  /* lines/captions: from<=to is a hard error; out-of-range / overlap warns */
  const checkSpans = (label, arr, htmlNeedsCaption) => {
    let prevTo = -Infinity;
    for (const [i, sp] of (arr || []).entries()) {
      const where = `${label}[${i}]`;
      if (typeof sp.from !== 'number' || typeof sp.to !== 'number') {
        e(`${where}: from/to must be numbers`); continue;
      }
      if (sp.to < sp.from) { e(`${where}: to ${num(sp.to)} < from ${num(sp.from)}`); continue; }
      if (sp.from < 0 || sp.to > max) w(`${where}: ${num(sp.from)}-${num(sp.to)} outside [0, ${maxs}]`);
      if (sp.from < prevTo) w(`${where}: starts at ${num(sp.from)}, before previous end ${num(prevTo)}`);
      prevTo = sp.to;
    }
    if (htmlNeedsCaption && (arr || []).length && !ids.has('caption')) {
      w('uses captions but scene.html has no <div id="caption"></div>');
    }
  };
  checkSpans('lines', data.lines, false);
  checkSpans('captions', data.captions, true);

  return { errors, warnings };
}

/* ------------------------------- run --------------------------------- */
const arg = process.argv[2];
let projectDir;
if (arg) {
  projectDir = path.resolve(arg);
} else {
  const def = createRegistry(root).resolve(null);
  if (!def) {
    console.error('no project given and no default project found');
    process.exit(1);
  }
  projectDir = def.path;
}

console.log(`validating ${projectDir}\n`);

let proj;
try { proj = readJson(path.join(projectDir, 'project.json')); }
catch (err) {
  console.error(`project.json not found or invalid: ${err.message}`);
  process.exit(1);
}

let totalErrors = 0;
let totalWarnings = 0;
for (const sid of proj.scenes || []) {
  const dir = path.join(projectDir, 'scenes', sid);
  const { errors, warnings } = fs.existsSync(dir)
    ? checkScene(sid, dir)
    : { errors: [`scene folder scenes/${sid}/ does not exist`], warnings: [] };

  const status = errors.length ? 'FAIL' : warnings.length ? 'warn' : '  ok';
  console.log(`${status}  ${sid}`);
  for (const m of errors) console.log(`        error: ${m}`);
  for (const m of warnings) console.log(`        warn:  ${m}`);
  totalErrors += errors.length;
  totalWarnings += warnings.length;
}

console.log(`\n${proj.scenes?.length || 0} scenes, ${totalErrors} errors, ${totalWarnings} warnings`);
process.exit(totalErrors ? 1 : 0);

/* Scaffold a new project from the bundled intro template:
     node scripts/new-project.mjs <folder-name> ["Display Name"]
   Copies projects/intro minus its runtime artifacts (takes/, exports/,
   takes.json), then sets the display name in project.json. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const name = process.argv[2];
const display = process.argv[3] || name;

if (!name || !/^[\w-]+$/.test(name)) {
  console.error('usage: node scripts/new-project.mjs <folder-name> ["Display Name"]');
  console.error('folder-name must match [A-Za-z0-9_-]+ (it becomes projects/<folder-name>)');
  process.exit(1);
}

const src = path.join(root, 'projects', 'intro');
const dst = path.join(root, 'projects', name);
if (fs.existsSync(dst)) {
  console.error(`projects/${name} already exists`);
  process.exit(1);
}

fs.cpSync(src, dst, {
  recursive: true,
  filter: (p) => {
    const rel = path.relative(src, p);
    return !/^(takes|exports)([\\/]|$)/.test(rel) && rel !== 'takes.json';
  },
});

const projFile = path.join(dst, 'project.json');
const proj = JSON.parse(fs.readFileSync(projFile, 'utf8'));
proj.name = display;
fs.writeFileSync(projFile, JSON.stringify(proj, null, 2) + '\n');

console.log(`created projects/${name} ("${display}") from the intro template`);
console.log(`  npm run dev, then open http://localhost:4321/?project=${name}`);
console.log('  projects/* is gitignored by design; give your video its own repo (docs/project-repos.md)');

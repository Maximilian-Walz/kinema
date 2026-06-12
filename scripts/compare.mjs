/* Renders the same scene+time in the OLD player.html (file://) and the NEW
   studio render mode and saves screenshot pairs for visual comparison.
   CSS transitions/animations are disabled so each frame is the pure layout
   for that clock value (no virtual time needed). Usage:
     node scripts/compare.mjs <path-to-old-player.html>
   (dev server must be running on 4321) */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';
import { findChrome } from '../server/render.mjs';

const OLD = process.argv[2];
if (!OLD) { console.error('usage: node scripts/compare.mjs <old-player.html>'); process.exit(1); }
const BASE = 'http://127.0.0.1:4321';
const SHOTS = [
  { scene: 0, t: 14 },   // cold open: chat window + bullets
  { scene: 1, t: 48 },   // one agent: cards + FAILED stamp
  { scene: 3, t: 42 },   // anatomy: boxes + human message
  { scene: 4, t: 40 },   // debate: pragmatist bill
  { scene: 6, t: 12 },   // code: highlight region 1
  { scene: 7, t: 28 },   // when-to-use: cost curve
];
const KILL = '*{transition:none!important;animation:none!important}';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: ['--no-sandbox', '--mute-audio', '--force-device-scale-factor=1',
         '--hide-scrollbars', '--font-render-hinting=none',
         '--disable-renderer-backgrounding', '--disable-background-timer-throttling'],
  defaultViewport: { width: 1920, height: 1080 },
});

/* new studio render mode */
const np = await browser.newPage();
await np.goto(BASE + '/?render=1', { waitUntil: 'networkidle0' });
await np.evaluate(() => window.__render.ready);
await np.addStyleTag({ content: KILL });
for (const { scene, t } of SHOTS) {
  await np.evaluate((s, tt) => window.__render.seek(s, tt), scene, t);
  await sleep(1200); // let the (real-time) thread autoscroll easing settle
  await np.screenshot({ path: `scripts/cmp-s${scene + 1}-t${t}-new.png`, clip: { x: 0, y: 0, width: 1920, height: 1080 } });
  console.log(`new: scene ${scene + 1} @ ${t}s`);
}
await np.close();

/* old player, clean mode */
const op = await browser.newPage();
await op.goto(pathToFileURL(path.resolve(OLD)).href, { waitUntil: 'networkidle0' });
await op.evaluate(() => {
  localStorage.clear();
  document.body.classList.add('clean');
  rescale();
});
await op.addStyleTag({ content: KILL });
for (const { scene, t } of SHOTS) {
  await op.evaluate((s, tt) => { loadScene(s, false); update(tt); }, scene, t);
  await sleep(1200);
  await op.screenshot({ path: `scripts/cmp-s${scene + 1}-t${t}-old.png`, clip: { x: 0, y: 0, width: 1920, height: 1080 } });
  console.log(`old: scene ${scene + 1} @ ${t}s`);
}
await op.close();

await browser.close();

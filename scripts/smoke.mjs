/* boots the studio UI and the render mode in headless Chrome and checks the
   essentials: project loads, scenes mount, schedule applies, timeline builds,
   timings PUT round-trips. Run with the dev server up: node scripts/smoke.mjs */
import puppeteer from 'puppeteer-core';
import { findChrome } from '../server/render.mjs';

const BASE = process.env.STUDIO_URL || 'http://127.0.0.1:4321';
let failures = 0;
const ok = (cond, name) => {
  console.log((cond ? '  ok ' : 'FAIL ') + name);
  if (!cond) failures++;
};

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: ['--no-sandbox', '--mute-audio'],
  defaultViewport: { width: 1600, height: 900 },
});

try {
  /* ---------------- studio UI ---------------- */
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE + '/', { waitUntil: 'networkidle0', timeout: 30000 });
  await page.waitForSelector('#scenecontent', { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 800));

  ok((await page.$('#s1win')) !== null, 'scene 1 mounted');
  ok(await page.$eval('#s1win', (el) => !el.classList.contains('on')), 'schedule: s1win off at t=0');
  await page.evaluate(() => { /* seek via keyboard: 2 = scene 2 */ });
  ok((await page.$$('.tl-track')).length === 5, 'timeline: 5 tracks');
  ok((await page.$$('.tl-scene')).length === 9, 'timeline: 9 scene blocks');
  ok((await page.$$('.sp-line')).length === 4, 'script panel: 4 lines for scene 1');

  await page.keyboard.press('5');
  await new Promise((r) => setTimeout(r, 400));
  ok((await page.$('#threadcol')) !== null, 'key 5 jumps to debate scene');
  await page.keyboard.press('ArrowRight'); // +5s -> round1 + adv1 on
  await new Promise((r) => setTimeout(r, 300));
  ok(await page.$eval('#adv1', (el) => el.classList.contains('on')), 'schedule applies at t=5 in scene 5');
  await page.keyboard.press('c');
  await new Promise((r) => setTimeout(r, 200));
  ok(await page.evaluate(() => document.body.classList.contains('clean')), 'clean mode toggles');
  ok(errors.length === 0, 'no page errors (studio)' + (errors.length ? ': ' + errors[0] : ''));

  /* ---------------- timings PUT round-trip ---------------- */
  const put = await page.evaluate(async () => {
    const proj = await (await fetch('/api/project')).json();
    const scene = proj.scenes[0];
    const r = await fetch('/api/scenes/' + scene.id + '/timings', {
      method: 'PUT',
      body: JSON.stringify({ len: scene.len, schedule: scene.schedule, captions: scene.captions, lines: scene.lines }),
    });
    const back = await (await fetch('/api/project')).json();
    return r.ok && back.scenes[0].len === scene.len && back.scenes[0].title === scene.title;
  });
  ok(put, 'timings PUT round-trips and preserves title');

  /* ---------------- render mode ---------------- */
  const rp = await browser.newPage();
  const rerrors = [];
  rp.on('pageerror', (e) => rerrors.push(String(e)));
  await rp.goto(BASE + '/?render=1', { waitUntil: 'networkidle0', timeout: 30000 });
  ok(await rp.evaluate(() => !!window.__render), 'render mode exposes __render');
  await rp.evaluate(() => window.__render.ready);
  const lens = await rp.evaluate(() => window.__render.sceneLens());
  ok(lens.length === 9 && Math.round(lens.reduce((a, b) => a + b, 0)) === 470, 'sceneLens = 9 scenes / 470s');
  await rp.evaluate(() => window.__render.begin(4));
  await new Promise((r) => setTimeout(r, 300));
  ok(await rp.evaluate(() => !window.__render.finished()), 'begin(4) starts playback');
  ok(await rp.$('#threadcol') !== null, 'render mode mounted scene 5');
  ok(rerrors.length === 0, 'no page errors (render)' + (rerrors.length ? ': ' + rerrors[0] : ''));
} finally {
  await browser.close();
}

console.log(failures ? `\n${failures} FAILURES` : '\nall good');
process.exit(failures ? 1 : 0);

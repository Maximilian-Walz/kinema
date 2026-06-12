/* End-to-end check of the take seek fix: records a MediaRecorder webm (no
   duration header) from an oscillator, uploads it via /api/takes (server
   remuxes), and asserts the served file has a finite duration and seeks.
   Cleans up after itself. Dev server must be running. */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { findChrome } from '../server/render.mjs';

const BASE = 'http://127.0.0.1:4321';
const SCENE = '09-close';
const PROJECT = path.resolve('projects/groupchat');
let failures = 0;
const ok = (cond, name) => { console.log((cond ? '  ok ' : 'FAIL ') + name); if (!cond) failures++; };

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});

try {
  const page = await browser.newPage();
  await page.goto(BASE + '/?render=1', { waitUntil: 'networkidle0' });

  const result = await page.evaluate(async (scene) => {
    /* 1. record ~3s of tone, exactly like the studio records the mic */
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    const osc = ctx.createOscillator();
    osc.connect(dest);
    osc.start();
    const rec = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus' });
    const chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    const stopped = new Promise((r) => { rec.onstop = r; });
    rec.start();
    await new Promise((r) => setTimeout(r, 3000));
    rec.stop();
    await stopped;
    osc.stop();
    const blob = new Blob(chunks, { type: 'audio/webm' });

    /* 2. the raw blob must be the broken case: Infinity duration */
    const probe = async (src) => {
      const a = new Audio(src);
      await new Promise((r, j) => { a.onloadedmetadata = r; a.onerror = j; });
      const rawDuration = a.duration;
      a.currentTime = 1.5;
      await new Promise((r) => setTimeout(r, 300));
      return { rawDuration, seekedTo: a.currentTime };
    };
    const before = await probe(URL.createObjectURL(blob));

    /* 3. upload -> server remux -> fetch back */
    const up = await fetch(`/api/takes/${scene}?ext=webm`, { method: 'POST', body: blob });
    const { file } = await up.json();
    const after = await probe(`/takes/${scene}/${file}?nocache=` + Date.now());
    return { before, after, file, blobSize: blob.size };
  }, SCENE);

  ok(result.blobSize > 1000, `recorded a real blob (${result.blobSize} bytes)`);
  ok(isFinite(result.after.rawDuration) && Math.abs(result.after.rawDuration - 3) < 1,
    `served take has finite duration (${result.after.rawDuration?.toFixed(2)}s)`);
  ok(Math.abs(result.after.seekedTo - 1.5) < 0.3,
    `seeking works on served take (currentTime ${result.after.seekedTo?.toFixed(2)} after seek to 1.5)`);

  /* also probe every real picked take (e.g. takes recorded before the fix) */
  const picked = await page.evaluate(async () => {
    const takes = await (await fetch('/api/takes')).json();
    const out = [];
    for (const [scene, info] of Object.entries(takes)) {
      if (!info.candidate || scene === '09-close') continue;
      const a = new Audio(`/takes/${scene}/${info.candidate}`);
      await new Promise((r, j) => { a.onloadedmetadata = r; a.onerror = j; });
      const target = Math.min(10, (isFinite(a.duration) ? a.duration : 10) / 2);
      a.currentTime = target;
      await new Promise((r) => setTimeout(r, 400));
      out.push({ scene, duration: a.duration, target, seekedTo: a.currentTime });
    }
    return out;
  });
  for (const t of picked) {
    ok(isFinite(t.duration) && Math.abs(t.seekedTo - t.target) < 0.3,
      `real take ${t.scene}: duration ${t.duration?.toFixed(1)}s, seek to ${t.target.toFixed(1)} → ${t.seekedTo?.toFixed(1)}`);
  }
} finally {
  await browser.close();
  /* cleanup: remove test takes + the pick they created */
  fs.rmSync(path.join(PROJECT, 'takes', SCENE), { recursive: true, force: true });
  const picksFile = path.join(PROJECT, 'takes.json');
  try {
    const picks = JSON.parse(fs.readFileSync(picksFile, 'utf8'));
    delete picks[SCENE];
    fs.writeFileSync(picksFile, JSON.stringify(picks, null, 2));
  } catch { /* no picks file */ }
}

console.log(failures ? `\n${failures} FAILURES` : '\nall good');
process.exit(failures ? 1 : 0);

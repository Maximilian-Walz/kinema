/* ============================================================================
   FRAME-EXACT MP4 EXPORT
   Drives the app's render mode (/?render=1) in headless Chrome under CDP
   virtual time: the page's requestAnimationFrame clock advances exactly
   1000/fps ms per captured frame, so CSS transitions and the scene schedule
   land on identical frames every run. PNGs are piped straight into ffmpeg
   (libx264), then the picked voice takes are muxed in at their scene offsets.

   Page contract (render mode): window.__render =
     { ready: Promise, sceneLens(): number[], begin(sceneIndex|null), finished(): bool }
============================================================================ */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import puppeteer from 'puppeteer-core';

const require = createRequire(import.meta.url);

/* ----------------------------- ffmpeg ---------------------------------- */
export function ffmpegPath() {
  try {
    const p = require('ffmpeg-static');
    if (p && fs.existsSync(p)) return p;
  } catch { /* not installed; fall through */ }
  return 'ffmpeg'; // hope it's on PATH
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath(), args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    ff.stderr.on('data', (d) => { err += d; if (err.length > 60000) err = err.slice(-30000); });
    ff.on('error', reject);
    ff.on('close', (code) => code === 0 ? resolve() : reject(new Error('ffmpeg exited ' + code + '\n' + err.slice(-2500))));
  });
}

/* --------------------------- find chrome ------------------------------- */
export function findChrome(explicit) {
  const env = process.env;
  const candidates = [
    explicit, env.CHROME_PATH,
    // Windows
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    // Linux
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('Chrome not found. Set CHROME_PATH to a Chrome or Edge executable '
    + '(e.g. chrome.exe on Windows, "Google Chrome" on macOS).');
}

/* ----------------------- virtual time stepping ------------------------- */
function advanceVirtualTime(client, ms) {
  return new Promise((resolve, reject) => {
    const onExpired = () => { client.off('Emulation.virtualTimeBudgetExpired', onExpired); resolve(); };
    client.on('Emulation.virtualTimeBudgetExpired', onExpired);
    client.send('Emulation.setVirtualTimePolicy', {
      policy: 'advance', budget: ms, maxVirtualTimeTaskStarvationCount: 100000,
    }).catch(reject);
  });
}

/* ------------------------------ export --------------------------------- */
/**
 * opts: { url, fps, scene (sceneId|null), sceneIds, width, height, outFile,
 *         chromePath, takesDir, picks, offsets ({"sceneId/file": s}),
 *         onProgress(partialJobFields) }
 */
export async function exportVideo(opts) {
  const { url, fps, scene, sceneIds, width, height, outFile, onProgress } = opts;
  const progress = (p) => { try { onProgress(p); } catch { /* ignore */ } };
  const chrome = findChrome(opts.chromePath);
  const sceneIndex = scene ? sceneIds.indexOf(scene) : null;
  if (scene && sceneIndex < 0) throw new Error('unknown scene: ' + scene);
  const tmpVideo = path.join(os.tmpdir(), 'studio-render-' + Date.now() + '.mp4');

  progress({ state: 'starting', phase: 'launching chrome' });
  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: [
      '--no-sandbox', '--disable-dev-shm-usage',
      '--run-all-compositor-stages-before-draw',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--mute-audio',
      '--force-device-scale-factor=1',
      '--hide-scrollbars',
      '--font-render-hinting=none',
    ],
    defaultViewport: { width, height },
  });

  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
    if (!(await page.evaluate(() => !!window.__render))) {
      throw new Error('page did not expose __render (did /?render=1 boot correctly?)');
    }
    await page.evaluate(() => window.__render.ready);

    const lens = await page.evaluate(() => window.__render.sceneLens());
    const duration = sceneIndex == null
      ? lens.reduce((a, b) => a + b, 0)
      : lens[sceneIndex];
    if (!duration) throw new Error('invalid scene ' + scene);
    const totalFrames = Math.ceil(duration * fps);

    /* freeze the clock, then start playback inside frozen time */
    const client = await page.createCDPSession();
    await client.send('Emulation.setVirtualTimePolicy', { policy: 'pause' });
    await page.evaluate((s) => window.__render.begin(s), sceneIndex);

    progress({ state: 'rendering', phase: 'rendering frames', frame: 0, totalFrames });

    /* ffmpeg consuming PNGs on stdin */
    let ffDone, ffFail;
    const ffExit = new Promise((res, rej) => { ffDone = res; ffFail = rej; });
    const ff = spawn(ffmpegPath(), [
      '-y', '-f', 'image2pipe', '-framerate', String(fps), '-i', 'pipe:0',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', tmpVideo,
    ], { stdio: ['pipe', 'ignore', 'pipe'] });
    let ffErr = '';
    ff.stderr.on('data', (d) => { ffErr += d; if (ffErr.length > 60000) ffErr = ffErr.slice(-30000); });
    ff.on('error', ffFail);
    ff.on('close', (code) => code === 0 ? ffDone() : ffFail(new Error('ffmpeg exited ' + code + '\n' + ffErr.slice(-2500))));

    const frameMs = 1000 / fps;
    for (let f = 0; f < totalFrames; f++) {
      await advanceVirtualTime(client, frameMs);
      const png = await page.screenshot({
        type: 'png',
        clip: { x: 0, y: 0, width, height },
      });
      if (!ff.stdin.write(png)) await once(ff.stdin, 'drain');
      if (f % 15 === 0 || f === totalFrames - 1) {
        progress({ state: 'rendering', phase: 'rendering frames', frame: f + 1, totalFrames });
      }
    }
    ff.stdin.end();
    await ffExit;
    await browser.close();

    /* ------------------------- mux voice takes ------------------------- */
    /* a take's user-set offset shifts its audio against the scene:
       positive -> plays later (delay), negative -> head is trimmed off */
    const offsets = opts.offsets || {};
    const addTake = (takes, id, sceneOffset, len) => {
      const file = opts.picks[id];
      if (!file || !fs.existsSync(path.join(opts.takesDir, id, file))) return;
      const off = offsets[id + '/' + file] || 0;
      takes.push({
        path: path.join(opts.takesDir, id, file),
        delay: sceneOffset + Math.max(0, off),
        trimStart: Math.max(0, -off),
        audible: Math.max(0.05, len - Math.max(0, off)),
      });
    };
    const takes = [];
    if (sceneIndex == null) {
      let offset = 0;
      sceneIds.forEach((id, i) => { addTake(takes, id, offset, lens[i]); offset += lens[i]; });
    } else {
      addTake(takes, scene, 0, lens[sceneIndex]);
    }

    if (!takes.length) {
      fs.copyFileSync(tmpVideo, outFile);
    } else {
      progress({ state: 'rendering', phase: 'muxing ' + takes.length + ' voice take(s)',
                 frame: totalFrames, totalFrames });
      const args = ['-y', '-i', tmpVideo];
      takes.forEach((tk) => args.push('-i', tk.path));
      const parts = takes.map((tk, i) =>
        `[${i + 1}:a]atrim=${tk.trimStart}:${tk.trimStart + tk.audible},` +
        `asetpts=PTS-STARTPTS,adelay=${Math.round(tk.delay * 1000)}:all=1[a${i}]`);
      const mixIn = takes.map((_, i) => `[a${i}]`).join('');
      const filter = parts.join(';') + ';' + mixIn +
        `amix=inputs=${takes.length}:duration=longest:dropout_transition=0:normalize=0[aout]`;
      args.push('-filter_complex', filter,
        '-map', '0:v', '-map', '[aout]',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
        '-t', String(duration), outFile);
      await runFfmpeg(args);
    }
    fs.rmSync(tmpVideo, { force: true });
    progress({ state: 'rendering', phase: 'finished', frame: totalFrames, totalFrames });
  } catch (err) {
    await browser.close().catch(() => {});
    fs.rmSync(tmpVideo, { force: true });
    throw err;
  }
}

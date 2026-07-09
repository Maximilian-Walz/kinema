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
import {
  Browser,
  detectBrowserPlatform,
  getInstalledBrowsers,
  install,
  resolveBuildId,
} from "@puppeteer/browsers";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

const require = createRequire(import.meta.url);

/* Cache for the render-only browser (chrome-headless-shell). Kept out of the
   repo and out of the user's normal Chrome/Edge profile on purpose. */
const RENDER_CACHE = path.join(os.homedir(), ".cache", "kinema-browser");

/* Best-effort delete of a temp file. fs.rmSync's `force` swallows ENOENT but
   NOT EPERM/EACCES/EBUSY — on Windows a virus scanner or a media player holding
   the just-written file briefly locks it, and a throw here would fail an export
   whose output MP4 was already produced. The OS reaps tmpdir anyway. */
function safeUnlink(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* leave it for the OS */
  }
}

/* Best-effort recursive delete of a temp dir (the per-export browser profile).
   Same Windows-lock caveat as safeUnlink; tmpdir gets reaped regardless. */
function safeRmrf(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* OS reaps tmpdir */
  }
}

/* ----------------------------- ffmpeg ---------------------------------- */
export function ffmpegPath() {
  try {
    const p = require("ffmpeg-static");
    if (p && fs.existsSync(p)) return p;
  } catch {
    /* not installed; fall through */
  }
  return "ffmpeg"; // hope it's on PATH
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath(), args, { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    ff.stderr.on("data", (d) => {
      err += d;
      if (err.length > 60000) err = err.slice(-30000);
    });
    ff.on("error", reject);
    ff.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error("ffmpeg exited " + code + "\n" + err.slice(-2500))),
    );
  });
}

/* ----------------------- audio chain -> filter ------------------------- */
/* Turn a take's audio chain into ffmpeg filter tokens, mirroring buildChain in
   the Web Audio renderer (src/audio/takes.ts) so preview, audition and export
   sound identical. Returns a list of filter strings (one per active effect, in
   apply order) to splice between asetpts and adelay: effects act on the content,
   delay/trim place it. An identity chain returns []. Grow it one entry per later
   effect (highpass, gate, comp); do not add parallel wiring. */
export function chainFilters(chain) {
  const out = [];
  /* high-pass is the chain head -- emitted first to match Web Audio graph order */
  if (
    chain &&
    chain.highpass &&
    typeof chain.highpass.freq === "number" &&
    chain.highpass.freq > 0
  ) {
    out.push("highpass=f=" + chain.highpass.freq);
  }
  /* noise gate sits after highpass and before the compressor (same order as
     buildChain). Unit conversions vs. the model (dB/seconds):
       threshold: dB -> linear amplitude 10^(dB/20), clamped to agate's range
       range:     dB of attenuation -> linear floor gain 10^(-rangeDb/20),
                  clamped 0..1 (default 0.06, about -24 dB; the model default of
                  60 dB attenuation maps to 0.001)
       attack/release: seconds -> milliseconds (multiply by 1000) */
  if (chain && chain.gate && typeof chain.gate.threshold === "number") {
    const g = chain.gate;
    const threshLin = Math.max(0, Math.min(1, Math.pow(10, g.threshold / 20)));
    const rangeDb = typeof g.range === "number" ? g.range : 60;
    const rangeLin = Math.max(0, Math.min(1, Math.pow(10, -rangeDb / 20)));
    const attackMs = Math.max(
      0.01,
      Math.min(9000, (typeof g.attack === "number" ? g.attack : 0.005) * 1000),
    );
    const releaseMs = Math.max(
      0.01,
      Math.min(9000, (typeof g.release === "number" ? g.release : 0.15) * 1000),
    );
    out.push(
      "agate=threshold=" +
        threshLin.toFixed(6) +
        ":range=" +
        rangeLin.toFixed(6) +
        ":attack=" +
        attackMs.toFixed(3) +
        ":release=" +
        releaseMs.toFixed(3),
    );
  }
  /* compressor sits after the gate and before volume (same order as buildChain).
     Unit conversions vs. Web Audio:
       threshold: Web Audio dB -> ffmpeg linear amplitude: 10^(dB/20), clamped to 0.00097563..1
       attack/release: Web Audio seconds -> ffmpeg milliseconds: multiply by 1000
         (attack clamped 0.01..2000 ms, release clamped 0.01..9000 ms)
       ratio: same scale in both (1..20) */
  if (chain && chain.comp) {
    const c = chain.comp;
    const threshLin = Math.max(
      0.00097563,
      Math.min(1, Math.pow(10, c.threshold / 20)),
    );
    const attackMs = Math.max(0.01, Math.min(2000, c.attack * 1000));
    const releaseMs = Math.max(0.01, Math.min(9000, c.release * 1000));
    const ratio = Math.max(1, Math.min(20, c.ratio));
    out.push(
      "acompressor=threshold=" +
        threshLin.toFixed(6) +
        ":ratio=" +
        ratio +
        ":attack=" +
        attackMs.toFixed(3) +
        ":release=" +
        releaseMs.toFixed(3),
    );
  }
  const gainDb = chain && typeof chain.gainDb === "number" ? chain.gainDb : 0;
  if (gainDb !== 0) out.push("volume=" + gainDb + "dB");
  return out;
}

/* --------------------------- find chrome ------------------------------- */
export function findChrome(explicit) {
  const env = process.env;
  const candidates = [
    explicit,
    env.CHROME_PATH,
    // Windows
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    env.LOCALAPPDATA &&
      path.join(env.LOCALAPPDATA, "Google\\Chrome\\Application\\chrome.exe"),
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    // macOS
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    // Linux
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error(
    "Chrome not found. Set CHROME_PATH to a Chrome or Edge executable " +
      '(e.g. chrome.exe on Windows, "Google Chrome" on macOS).',
  );
}

/* ----------------------- virtual time stepping ------------------------- */
function advanceVirtualTime(client, ms) {
  return new Promise((resolve, reject) => {
    const onExpired = () => {
      client.off("Emulation.virtualTimeBudgetExpired", onExpired);
      resolve();
    };
    client.on("Emulation.virtualTimeBudgetExpired", onExpired);
    client
      .send("Emulation.setVirtualTimePolicy", {
        policy: "advance",
        budget: ms,
        maxVirtualTimeTaskStarvationCount: 100000,
      })
      .catch(reject);
  });
}

/* ---------------------------- launch chrome ---------------------------- */
/* Resolve a browser binary to render with.

   PRIMARY: chrome-headless-shell — a dedicated headless-only Chromium build with
   no window, no OS-level launcher, and no single-instance machinery. It is
   downloaded once (~150 MB) into RENDER_CACHE and reused. This deliberately does
   NOT use the user's installed Chrome/Edge: on Windows, launching the everyday
   Edge routes through its "startup boost" background process, which hijacks the
   launch, pops blank windows, and drops us with "Code: 0" / "already running" —
   no headless flag or fresh profile reliably avoids it because the handoff is at
   the .exe level, before our flags are read.

   OVERRIDE: CHROME_PATH still forces a specific binary for anyone who wants one.
   FALLBACK: if the shell can't be fetched (offline/blocked) we drop to a system
   browser under OLD headless — better than new headless, but subject to the
   startup-boost caveat above. */
async function resolveRenderBrowser(explicit, progress) {
  if (explicit) return { executablePath: explicit, shell: false };

  const platform = detectBrowserPlatform();
  if (!platform) return { executablePath: findChrome(), shell: false };

  /* reuse an already-downloaded shell first, so repeat exports work offline */
  try {
    const found = (await getInstalledBrowsers({ cacheDir: RENDER_CACHE })).find(
      (b) => b.browser === Browser.CHROMEHEADLESSSHELL,
    );
    if (found && fs.existsSync(found.executablePath)) {
      return { executablePath: found.executablePath, shell: true };
    }
  } catch {
    /* nothing cached yet — fall through to install */
  }

  /* Outside Windows, prefer an installed Chrome/Edge over the 150 MB shell
     download: the startup-boost handoff that forces the shell is Windows-only,
     and everyday Chrome renders fine here under old headless. This keeps the
     first export from hanging on a slow/blocked download when a perfectly good
     browser is already on the machine. Windows still downloads the shell. */
  if (process.platform !== "win32") {
    try {
      return { executablePath: findChrome(), shell: false };
    } catch {
      /* no system browser found — fall through to download */
    }
  }

  /* download once */
  try {
    const buildId = await resolveBuildId(
      Browser.CHROMEHEADLESSSHELL,
      platform,
      "stable",
    );
    progress({
      state: "starting",
      phase: "downloading headless browser (first run, ~150 MB)",
    });
    const installed = await install({
      browser: Browser.CHROMEHEADLESSSHELL,
      buildId,
      cacheDir: RENDER_CACHE,
    });
    return { executablePath: installed.executablePath, shell: true };
  } catch {
    /* offline / blocked download — last-resort system browser */
    return { executablePath: findChrome(), shell: false };
  }
}

/* Launch the resolved browser. chrome-headless-shell (shell:true) is inherently
   windowless and immune to the startup-boost handoff, so it just works; a system
   fallback is forced into OLD headless. Each attempt gets a brand-new profile
   dir — once a stray window locks one it stays poisoned, so a retry must not
   reuse it. Returns the browser plus its live profile dir for the caller to
   reap. */
async function launchBrowser(resolved, viewport) {
  const baseArgs = [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--run-all-compositor-stages-before-draw",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--mute-audio",
    "--force-device-scale-factor=1",
    "--hide-scrollbars",
    "--font-render-hinting=none",
    "--no-first-run",
    "--no-default-browser-check",
  ];
  const args = resolved.shell ? baseArgs : ["--headless=old", ...baseArgs];
  const mkOpts = (userDataDir) => ({
    executablePath: resolved.executablePath,
    headless: resolved.shell ? "shell" : false,
    userDataDir,
    args,
    defaultViewport: viewport,
  });
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "kinema-render-"),
    );
    try {
      return {
        browser: await puppeteer.launch(mkOpts(userDataDir)),
        userDataDir,
      };
    } catch (err) {
      lastErr = err;
      safeRmrf(userDataDir);
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  const why = String((lastErr && lastErr.message) || lastErr).split("\n")[0];
  throw new Error(
    "Could not launch a browser for export (" +
      why +
      ").\n" +
      "Tried " +
      path.basename(resolved.executablePath) +
      ". If this machine is offline, the headless browser can't download; " +
      "connect once so it can cache, or set CHROME_PATH to a Chrome/Edge executable.",
  );
}

/* ------------------------------ export --------------------------------- */
/**
 * opts: { url, fps, scene (sceneId|null), sceneIds, sceneLines, width, height,
 *         outFile, chromePath, takesDir,
 *         picks ({ sceneId: { lineId: file } }),
 *         offsets ({ "sceneId/lineId/file": s }),
 *         chains ({ "sceneId/lineId/file": TakeChain }),
 *         onProgress(partialJobFields) }
 */
export async function exportVideo(opts) {
  const { url, fps, scene, sceneIds, width, height, outFile, onProgress } =
    opts;
  const progress = (p) => {
    try {
      onProgress(p);
    } catch {
      /* ignore */
    }
  };
  const sceneIndex = scene ? sceneIds.indexOf(scene) : null;
  if (scene && sceneIndex < 0) throw new Error("unknown scene: " + scene);
  const tmpVideo = path.join(
    os.tmpdir(),
    "studio-render-" + Date.now() + ".mp4",
  );

  progress({ state: "starting", phase: "launching browser" });
  const resolved = await resolveRenderBrowser(opts.chromePath, progress);
  const { browser, userDataDir } = await launchBrowser(resolved, {
    width,
    height,
  });

  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle0", timeout: 60000 });
    if (!(await page.evaluate(() => !!window.__render))) {
      throw new Error(
        "page did not expose __render (did /?render=1 boot correctly?)",
      );
    }
    await page.evaluate(() => window.__render.ready);

    const lens = await page.evaluate(() => window.__render.sceneLens());
    const duration =
      sceneIndex == null ? lens.reduce((a, b) => a + b, 0) : lens[sceneIndex];
    if (!duration) throw new Error("invalid scene " + scene);
    const totalFrames = Math.ceil(duration * fps);

    /* freeze the clock, then start playback inside frozen time */
    const client = await page.createCDPSession();
    await client.send("Emulation.setVirtualTimePolicy", { policy: "pause" });
    await page.evaluate((s) => window.__render.begin(s), sceneIndex);

    progress({
      state: "rendering",
      phase: "rendering frames",
      frame: 0,
      totalFrames,
    });

    /* ffmpeg consuming PNGs on stdin */
    let ffDone, ffFail;
    const ffExit = new Promise((res, rej) => {
      ffDone = res;
      ffFail = rej;
    });
    const ff = spawn(
      ffmpegPath(),
      [
        "-y",
        "-f",
        "image2pipe",
        "-framerate",
        String(fps),
        "-i",
        "pipe:0",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        tmpVideo,
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    let ffErr = "";
    ff.stderr.on("data", (d) => {
      ffErr += d;
      if (ffErr.length > 60000) ffErr = ffErr.slice(-30000);
    });
    ff.on("error", ffFail);
    ff.on("close", (code) =>
      code === 0
        ? ffDone()
        : ffFail(
            new Error("ffmpeg exited " + code + "\n" + ffErr.slice(-2500)),
          ),
    );

    /* A screenshot under --run-all-compositor-stages-before-draw advances
       virtual time by a whole compositor flush (~50 ms here), NOT by one output
       frame — so the naive "advance frameMs, screenshot" loop walks content
       forward ~50 ms per captured frame and the video plays fast (e.g. 1.5x at
       30 fps, 2x at 60 fps), finishing early. Instead, capture frames at that
       natural cadence, read each frame's true content time, and resample to the
       requested constant fps by content time (nearest neighbour) — so the video
       plays at real speed and stays in sync with the absolutely-placed audio.
       Streaming, O(1) memory: keep the last two captures and emit dups/drops. */
    const frameMs = 1000 / fps;
    const base =
      sceneIndex == null
        ? 0
        : lens.slice(0, sceneIndex).reduce((a, b) => a + b, 0);
    /* local content time (seconds) of the current capture; player.now() is the
       global clock, so subtract the scene's offset for a single-scene export */
    const grab = async () => {
      await advanceVirtualTime(client, frameMs); // nudge; the screenshot does the bulk advance
      /* read the clock BEFORE the screenshot: the screenshot's own compositor
         flush advances virtual time another ~50 ms, but the pixels it returns
         are the state from before that flush. Stamping after the screenshot
         dated every capture ~50 ms ahead of its content, which smeared the
         final frame of a scene 1-2 output frames past the cut. */
      const t = (await page.evaluate(() => window.__render.now())) - base;
      const png = await page.screenshot({
        type: "png",
        clip: { x: 0, y: 0, width, height },
      });
      return { png, t };
    };
    let prev = await grab();
    let cur = prev;
    for (let out = 0; out < totalFrames; out++) {
      const targetT = out / fps;
      /* advance the capture until it reaches (or passes) the target content
         time, or the clock plateaus at the end */
      while (cur.t < targetT && cur.t < duration - 1e-3) {
        prev = cur;
        cur = await grab();
        if (cur.t <= prev.t + 1e-4) break; // clock stopped advancing — avoid spinning
      }
      /* emit whichever of the bracketing captures is closer to the target */
      const frame =
        Math.abs(prev.t - targetT) <= Math.abs(cur.t - targetT)
          ? prev.png
          : cur.png;
      if (!ff.stdin.write(frame)) await once(ff.stdin, "drain");
      if (out % 15 === 0 || out === totalFrames - 1) {
        progress({
          state: "rendering",
          phase: "rendering frames",
          frame: out + 1,
          totalFrames,
        });
      }
    }
    ff.stdin.end();
    await ffExit;
    await browser.close();

    /* ------------------------- mux voice takes ------------------------- */
    /* one input per picked section take, placed at its line's in-scene offset.
       A take's user-set offset shifts its audio against the line:
       positive -> plays later (delay), negative -> head is trimmed off.
       The audible window runs to the next line's start so a take recorded
       slightly past its `to` does not bleed into the following section. */
    const offsets = opts.offsets || {};
    const inPoints = opts.inPoints || {};
    const picks = opts.picks || {};
    const chains = opts.chains || {};
    const sceneLines = opts.sceneLines || [];
    const linesOf = (id) => sceneLines.find((s) => s.id === id)?.lines || [];
    const addScene = (takes, sceneId, sceneOffset) => {
      const picked = picks[sceneId];
      if (!picked) return;
      const lines = linesOf(sceneId);
      lines.forEach((ln) => {
        const file = picked[ln.id];
        if (
          !file ||
          !fs.existsSync(path.join(opts.takesDir, sceneId, ln.id, file))
        )
          return;
        const key = sceneId + "/" + ln.id + "/" + file;
        const off = offsets[key] || 0;
        const inp = inPoints[key] || 0;
        /* The audible window is the line's OWN duration (not the inter-line
           span): the overrun sub-take picker chooses WHICH winLen-long slice of
           a longer take plays here, starting at `inp` seconds in. A positive
           latency `off` delays placement, so the window is shortened by that
           much to stay inside the line slot (never bleeding into the next
           line) — same as the old `span - max(0,off)`. For a contiguous next
           line (next.from === ln.to) with inPoint=0 this equals the old result
           for ANY offset, so existing exports are unchanged. */
        const winLen = Math.max(0.05, ln.to - ln.from);
        const trimStart = inp + Math.max(0, -off);
        const audible = Math.max(0.05, winLen - Math.max(0, off));
        takes.push({
          path: path.join(opts.takesDir, sceneId, ln.id, file),
          delay: sceneOffset + ln.from + Math.max(0, off),
          trimStart,
          audible,
          filters: chainFilters(chains[key]),
        });
      });
    };
    const takes = [];
    if (sceneIndex == null) {
      let offset = 0;
      sceneIds.forEach((id, i) => {
        addScene(takes, id, offset);
        offset += lens[i];
      });
    } else {
      addScene(takes, scene, 0);
    }

    if (!takes.length) {
      fs.copyFileSync(tmpVideo, outFile);
    } else {
      progress({
        state: "rendering",
        phase: "muxing " + takes.length + " voice take(s)",
        frame: totalFrames,
        totalFrames,
      });
      const args = ["-y", "-i", tmpVideo];
      takes.forEach((tk) => args.push("-i", tk.path));
      const parts = takes.map((tk, i) => {
        /* atrim,asetpts -> chain effects (act on content) -> adelay (places it) */
        const chain = tk.filters.length ? tk.filters.join(",") + "," : "";
        return (
          `[${i + 1}:a]atrim=${tk.trimStart}:${tk.trimStart + tk.audible},` +
          `asetpts=PTS-STARTPTS,${chain}adelay=${Math.round(tk.delay * 1000)}:all=1[a${i}]`
        );
      });
      const mixIn = takes.map((_, i) => `[a${i}]`).join("");
      const filter =
        parts.join(";") +
        ";" +
        mixIn +
        `amix=inputs=${takes.length}:duration=longest:dropout_transition=0:normalize=0[aout]`;
      args.push(
        "-filter_complex",
        filter,
        "-map",
        "0:v",
        "-map",
        "[aout]",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-t",
        String(duration),
        outFile,
      );
      await runFfmpeg(args);
    }
    safeUnlink(tmpVideo);
    safeRmrf(userDataDir);
    progress({
      state: "rendering",
      phase: "finished",
      frame: totalFrames,
      totalFrames,
    });
  } catch (err) {
    await browser.close().catch(() => {});
    safeUnlink(tmpVideo);
    safeRmrf(userDataDir);
    throw err;
  }
}

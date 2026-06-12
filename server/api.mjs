/* ============================================================================
   Studio API — plain Node request handlers (no framework), used as connect
   middleware by the Vite plugin.

   Routes:
     GET    /api/project                    project + all scenes (data, html, css)
     PUT    /api/scenes/:id/timings         write len/schedule/captions/lines back
                                            into the scene's scene.json
     GET    /api/takes                      all takes + candidate per scene
     POST   /api/takes/:sceneId?ext=webm    upload a take (auto-picked)
     POST   /api/takes/:sceneId/:file/pick  pick as candidate
     DELETE /api/takes/:sceneId/:file       soft delete (moved to trash/)
     GET    /takes/:sceneId/:file           serve a take
     POST   /api/export {fps, scene}        start MP4 export (scene id or null)
     GET    /api/export/status              poll the single export job
     GET    /exports/:file                  serve an exported MP4
============================================================================ */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.webm': 'audio/webm', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4',
};

const safeName = (s) => typeof s === 'string' && /^[\w.-]+$/.test(s) && !s.includes('..');

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 200 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* MediaRecorder blobs lack duration/cue headers, which makes them unseekable
   in <audio>. A stream-copy remux through ffmpeg writes proper headers. */
async function remux(src, dst) {
  const { ffmpegPath } = await import('./render.mjs');
  return new Promise((resolve) => {
    const ff = spawn(ffmpegPath(), ['-y', '-i', src, '-c', 'copy', dst], { stdio: 'ignore' });
    ff.on('error', () => resolve(false));
    ff.on('close', (code) => resolve(code === 0 && fs.existsSync(dst) && fs.statSync(dst).size > 0));
  });
}

/* media files need Range support: <audio>/<video> can't seek without it */
function sendFile(res, file, range) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); res.end('not found'); return;
  }
  const size = fs.statSync(file).size;
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
  if (m && (m[1] !== '' || m[2] !== '')) {
    const start = m[1] !== '' ? parseInt(m[1], 10) : Math.max(0, size - parseInt(m[2], 10));
    const end = m[1] !== '' && m[2] !== '' ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return;
    }
    res.writeHead(206, {
      'Content-Type': type, 'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
    });
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, {
    'Content-Type': type, 'Content-Length': size,
    'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
}

export function createApi({ projectDir }) {
  const TAKES_DIR = path.join(projectDir, 'takes');
  const EXPORTS_DIR = path.join(projectDir, 'exports');
  const PICKS_FILE = path.join(projectDir, 'takes.json');

  let origin = 'http://127.0.0.1:4321';

  /* files we wrote ourselves recently — the plugin's watcher must ignore them */
  const selfWrites = new Map();
  function writeFileTracked(file, data) {
    selfWrites.set(path.resolve(file), Date.now());
    fs.writeFileSync(file, data);
  }

  function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
  }
  function readText(file, fallback = '') {
    try { return fs.readFileSync(file, 'utf8'); } catch { return fallback; }
  }

  /* ----------------------------- project -------------------------------- */
  function loadProject() {
    const proj = readJson(path.join(projectDir, 'project.json'), null);
    if (!proj) throw new Error('project.json not found in ' + projectDir);
    const scenes = (proj.scenes || []).map((id) => {
      if (!safeName(id)) throw new Error('bad scene id: ' + id);
      const dir = path.join(projectDir, 'scenes', id);
      const data = readJson(path.join(dir, 'scene.json'), null);
      if (!data) throw new Error('scene.json missing for scene ' + id);
      return {
        id,
        title: data.title || id,
        len: data.len,
        behaviors: data.behaviors || [],
        schedule: data.schedule || [],
        captions: data.captions || [],
        lines: data.lines || [],
        html: readText(path.join(dir, 'scene.html')),
        css: readText(path.join(dir, 'scene.css')),
      };
    });
    return {
      id: path.basename(projectDir),
      name: proj.name || path.basename(projectDir),
      width: proj.width || 1920,
      height: proj.height || 1080,
      theme: readText(path.join(projectDir, 'theme.css')),
      scenes,
    };
  }

  function sceneIds() {
    const proj = readJson(path.join(projectDir, 'project.json'), { scenes: [] });
    return proj.scenes || [];
  }

  /* writes the editable timing fields back into scene.json, preserving
     everything else (title, behaviors, future fields) */
  function writeTimings(id, body) {
    const file = path.join(projectDir, 'scenes', id, 'scene.json');
    const data = readJson(file, null);
    if (!data) throw new Error('scene not found: ' + id);
    if (typeof body.len === 'number' && body.len > 0) data.len = body.len;
    if (Array.isArray(body.schedule)) data.schedule = body.schedule;
    if (Array.isArray(body.captions)) data.captions = body.captions;
    if (Array.isArray(body.lines)) data.lines = body.lines;
    writeFileTracked(file, JSON.stringify(data, null, 2) + '\n');
  }

  /* ------------------------------ takes --------------------------------- */
  const sceneTakesDir = (id) => path.join(TAKES_DIR, id);

  function listTakes() {
    const picks = readJson(PICKS_FILE, {});
    const out = {};
    if (!fs.existsSync(TAKES_DIR)) return out;
    for (const d of fs.readdirSync(TAKES_DIR)) {
      const dir = path.join(TAKES_DIR, d);
      if (!fs.statSync(dir).isDirectory() || !safeName(d)) continue;
      const takes = fs.readdirSync(dir)
        .filter((f) => /\.(webm|ogg|wav|mp3|m4a)$/i.test(f))
        .map((f) => {
          const st = fs.statSync(path.join(dir, f));
          return { file: f, size: st.size, created: st.mtimeMs };
        })
        .sort((a, b) => a.created - b.created);
      out[d] = { candidate: picks[d] || null, takes };
    }
    return out;
  }

  /* ------------------------------ export -------------------------------- */
  let job = null; // { state, phase, frame, totalFrames, message, output }

  async function startExport({ fps, scene }) {
    if (job && (job.state === 'rendering' || job.state === 'starting')) {
      throw new Error('an export is already running');
    }
    job = { state: 'starting', phase: 'launching chrome', frame: 0, totalFrames: 0,
            message: '', output: null, startedAt: Date.now() };
    const { exportVideo } = await import('./render.mjs');
    fs.mkdirSync(EXPORTS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const name = (scene ? scene + '-' : 'full-') + stamp + '.mp4';
    const outFile = path.join(EXPORTS_DIR, name);
    const project = loadProject();
    exportVideo({
      url: origin + '/?render=1',
      fps,
      scene,                       // scene id or null = full video
      sceneIds: project.scenes.map((s) => s.id),
      width: project.width,
      height: project.height,
      outFile,
      chromePath: process.env.CHROME_PATH || null,
      takesDir: TAKES_DIR,
      picks: readJson(PICKS_FILE, {}),
      onProgress: (p) => Object.assign(job, p),
    }).then(() => {
      job.state = 'done';
      job.phase = 'done';
      job.output = '/exports/' + name;
    }).catch((err) => {
      job.state = 'error';
      job.message = String(err.stack || err);
      console.error('[export]', err);
    });
  }

  /* ---------------------------- middleware ------------------------------ */
  async function middleware(req, res, next) {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    try {
      if (req.method === 'GET' && p === '/api/project') {
        json(res, 200, loadProject());

      } else if (req.method === 'PUT' && /^\/api\/scenes\/[\w-]+\/timings$/.test(p)) {
        const id = p.split('/')[3];
        if (!sceneIds().includes(id)) { json(res, 404, { error: 'unknown scene' }); return; }
        const body = JSON.parse((await readBody(req)).toString('utf8'));
        writeTimings(id, body);
        json(res, 200, { ok: true });

      } else if (req.method === 'GET' && p === '/api/takes') {
        json(res, 200, listTakes());

      } else if (req.method === 'POST' && /^\/api\/takes\/[\w-]+$/.test(p)) {
        const id = p.split('/')[3];
        if (!sceneIds().includes(id)) { json(res, 404, { error: 'unknown scene' }); return; }
        const ext = (u.searchParams.get('ext') || 'webm').replace(/[^a-z0-9]/gi, '');
        const body = await readBody(req);
        if (!body.length) { json(res, 400, { error: 'empty body' }); return; }
        const dir = sceneTakesDir(id);
        fs.mkdirSync(dir, { recursive: true });
        const file = 'take-' + new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19) + '.' + ext;
        const raw = path.join(dir, 'raw-' + file);
        fs.writeFileSync(raw, body);
        if (await remux(raw, path.join(dir, file))) {
          fs.rmSync(raw, { force: true });
        } else {
          fs.renameSync(raw, path.join(dir, file)); // keep the recording even if ffmpeg fails
        }
        const picks = readJson(PICKS_FILE, {});
        picks[id] = file; // newest take becomes the candidate
        writeFileTracked(PICKS_FILE, JSON.stringify(picks, null, 2));
        json(res, 200, { ok: true, file, candidate: file });

      } else if (req.method === 'POST' && /^\/api\/takes\/[\w-]+\/[\w.-]+\/pick$/.test(p)) {
        const [, , , id, file] = p.split('/');
        if (!safeName(file) || !fs.existsSync(path.join(sceneTakesDir(id), file))) {
          json(res, 404, { error: 'take not found' }); return;
        }
        const picks = readJson(PICKS_FILE, {});
        picks[id] = file;
        writeFileTracked(PICKS_FILE, JSON.stringify(picks, null, 2));
        json(res, 200, { ok: true });

      } else if (req.method === 'DELETE' && /^\/api\/takes\/[\w-]+\/[\w.-]+$/.test(p)) {
        const [, , , id, file] = p.split('/');
        const src = path.join(sceneTakesDir(id), file);
        if (!safeName(file) || !fs.existsSync(src)) { json(res, 404, { error: 'take not found' }); return; }
        const trash = path.join(sceneTakesDir(id), 'trash');
        fs.mkdirSync(trash, { recursive: true });
        fs.renameSync(src, path.join(trash, Date.now() + '-' + file));
        const picks = readJson(PICKS_FILE, {});
        if (picks[id] === file) {
          /* auto-pick the newest remaining take */
          const left = listTakes()[id];
          if (left && left.takes.length) picks[id] = left.takes[left.takes.length - 1].file;
          else delete picks[id];
        }
        writeFileTracked(PICKS_FILE, JSON.stringify(picks, null, 2));
        json(res, 200, { ok: true, candidate: picks[id] || null });

      } else if (req.method === 'GET' && /^\/takes\/[\w-]+\/[\w.-]+$/.test(p)) {
        const [, , id, file] = p.split('/');
        if (!safeName(id) || !safeName(file)) { res.writeHead(404); res.end(); return; }
        sendFile(res, path.join(TAKES_DIR, id, file), req.headers.range);

      } else if (req.method === 'POST' && p === '/api/export') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const fps = Math.max(5, Math.min(60, parseInt(body.fps, 10) || 30));
        const scene = typeof body.scene === 'string' && sceneIds().includes(body.scene)
          ? body.scene : null;
        if (req.headers.host) origin = 'http://' + req.headers.host;
        await startExport({ fps, scene });
        json(res, 200, { ok: true });

      } else if (req.method === 'GET' && p === '/api/export/status') {
        json(res, 200, job || { state: 'idle' });

      } else if (req.method === 'GET' && /^\/exports\/[\w.-]+$/.test(p)) {
        const file = p.split('/')[2];
        if (!safeName(file)) { res.writeHead(404); res.end(); return; }
        sendFile(res, path.join(EXPORTS_DIR, file), req.headers.range);

      } else {
        next();
      }
    } catch (err) {
      console.error('[studio-api]', req.method, p, err);
      json(res, 500, { error: String(err.message || err) });
    }
  }

  return {
    middleware,
    setOrigin: (o) => { origin = o; },
    isSelfWrite: (file) => {
      const ts = selfWrites.get(path.resolve(file));
      return ts !== undefined && Date.now() - ts < 2000;
    },
  };
}

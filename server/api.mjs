/* ============================================================================
   Studio API — plain Node request handlers (no framework), used as connect
   middleware by the Vite plugin.

   Multi-project: every project-scoped route reads ?project=<id> and falls back
   to the default project when absent; an unknown id is a 404. The registry is
   passed in by the plugin (server/plugin.mjs).

   Takes are per section: a section is one script line, keyed by its stable
   line id. Recordings live under takes/<sceneId>/<lineId>/take-*.webm; picks,
   offsets and chains are keyed by section (offsets/chains stay per file).

   Routes:
     GET    /api/projects                            [{ id, name, path, default }]
     GET    /api/project[?project=<id>]              project + all scenes (data, html, css)
     PUT    /api/scenes/:id/timings                  write len/schedule/captions/lines back
                                                     into the scene's scene.json
     GET    /api/takes                                takes + candidate per section
     POST   /api/takes/:sceneId/:lineId?ext=webm     upload a take (auto-picked)
     POST   /api/takes/:sceneId/:lineId/:file/pick   pick as candidate
     POST   /api/takes/:sceneId/:lineId/:file/offset set the alignment offset
     POST   /api/takes/:sceneId/:lineId/:file/chain  set the audio chain (gain etc.)
     DELETE /api/takes/:sceneId/:lineId/:file        soft delete (moved to trash/)
     GET    /takes/:sceneId/:lineId/:file            serve a take
     POST   /api/export {fps, scene}                 start MP4 export (scene id or null)
     GET    /api/export/status                       poll the single export job
     GET    /exports/:file                           serve an exported MP4
============================================================================ */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.webm': 'audio/webm', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4',
};

const safeName = (s) => typeof s === 'string' && /^[\w.-]+$/.test(s) && !s.includes('..');

/* stable line id: short, unique within a scene, matches safeName so it can be a
   path segment. Format: "ln-" + a few base36 chars. */
let idSeq = 0;
function newLineId() {
  return 'ln-' + Date.now().toString(36) + (idSeq++).toString(36);
}

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

export function createApi({ registry }) {
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

  /* ----------------------- per-project context -------------------------- */
  /* Everything project-scoped derives its paths/helpers from one resolved
     project, so a single createApi serves all of them. */
  function projectCtx(id, projectDir) {
    const TAKES_DIR = path.join(projectDir, 'takes');
    const EXPORTS_DIR = path.join(projectDir, 'exports');
    const PICKS_FILE = path.join(projectDir, 'takes.json');

    function loadProject() {
      const proj = readJson(path.join(projectDir, 'project.json'), null);
      if (!proj) throw new Error('project.json not found in ' + projectDir);
      const scenes = (proj.scenes || []).map((sid) => {
        if (!safeName(sid)) throw new Error('bad scene id: ' + sid);
        const dir = path.join(projectDir, 'scenes', sid);
        const data = readJson(path.join(dir, 'scene.json'), null);
        if (!data) throw new Error('scene.json missing for scene ' + sid);
        /* fill any missing line ids and persist them so takes keyed by line id
           are stable across sessions. Scenes authored without ids still load;
           this is the "filled on first write" point for them. */
        const lines = data.lines || [];
        const seen = new Set();
        let filled = false;
        for (const ln of lines) {
          if (!ln.id || !safeName(ln.id) || seen.has(ln.id)) { ln.id = newLineId(); filled = true; }
          seen.add(ln.id);
        }
        if (filled) {
          data.lines = lines;
          writeFileTracked(path.join(dir, 'scene.json'), JSON.stringify(data, null, 2) + '\n');
        }
        return {
          id: sid,
          title: data.title || sid,
          len: data.len,
          behaviors: data.behaviors || [],
          schedule: data.schedule || [],
          captions: data.captions || [],
          lines,
          html: readText(path.join(dir, 'scene.html')),
          css: readText(path.join(dir, 'scene.css')),
        };
      });
      return {
        id,
        name: proj.name || id,
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

    /* the stable line ids of one scene, straight off disk (no id-fill write) */
    function lineIds(sid) {
      const data = readJson(path.join(projectDir, 'scenes', sid, 'scene.json'), null);
      return data && Array.isArray(data.lines)
        ? data.lines.map((ln) => ln.id).filter((id) => safeName(id))
        : [];
    }

    /* writes the editable timing fields back into scene.json, preserving
       everything else (title, behaviors, future fields). Every line gets a
       stable id: existing ids are kept, gaps are filled, so takes keyed by line
       id survive edits, inserts and reorders. */
    function ensureLineIds(lines, seen) {
      for (const ln of lines) {
        if (!ln.id || !safeName(ln.id) || seen.has(ln.id)) ln.id = newLineId();
        seen.add(ln.id);
      }
      return lines;
    }
    function writeTimings(sid, body) {
      const file = path.join(projectDir, 'scenes', sid, 'scene.json');
      const data = readJson(file, null);
      if (!data) throw new Error('scene not found: ' + sid);
      if (typeof body.len === 'number' && body.len > 0) data.len = body.len;
      if (Array.isArray(body.schedule)) data.schedule = body.schedule;
      if (Array.isArray(body.captions)) data.captions = body.captions;
      if (Array.isArray(body.lines)) data.lines = ensureLineIds(body.lines, new Set());
      writeFileTracked(file, JSON.stringify(data, null, 2) + '\n');
    }

    /* Overwrite a scene's whole scene.html / scene.css. Unlike element-text /
       element-style (targeted, structure-preserving patches), these replace the
       file outright -- used by undo/redo to restore a prior snapshot. Tracked as
       a self-write so the dev watcher doesn't bounce the page. */
    function putSceneHtml(sid, html) {
      if (!safeName(sid)) throw new Error('bad scene id');
      writeFileTracked(path.join(projectDir, 'scenes', sid, 'scene.html'), html);
    }
    function putSceneCss(sid, css) {
      if (!safeName(sid)) throw new Error('bad scene id');
      writeFileTracked(path.join(projectDir, 'scenes', sid, 'scene.css'), css);
    }

    const VOID_TAGS = new Set([
      'img', 'br', 'hr', 'input', 'meta', 'link', 'source', 'area',
      'base', 'col', 'embed', 'param', 'track', 'wbr',
    ]);

    /* Patch only the inner text of the element with #elId in scene.html, leaving
       the rest of the file byte-for-byte intact (so hand-authored formatting is
       preserved). The studio keeps scene.html as the single source of truth for
       on-screen text; this is a targeted text replacement, not an HTML rewrite.

       Restricted to LEAF elements (no child markup): we find the element's open
       tag by its id, reject void/self-closing tags, take the run up to the first
       matching close tag, and refuse it if that run contains any '<' (i.e. the
       element has children) -- those must still be edited in the file. Returns
       the updated HTML. */
    function setElementText(sid, elId, text) {
      if (!safeName(sid)) throw new Error('bad scene id');
      if (!safeName(elId)) throw new Error('bad element id');
      const file = path.join(projectDir, 'scenes', sid, 'scene.html');
      let html;
      try { html = fs.readFileSync(file, 'utf8'); } catch { throw new Error('scene.html not found'); }

      /* find the id="elId" attribute (whitespace before `id` avoids matching a
         substring like data-grid="...") */
      const idRe = /\sid\s*=\s*("([^"]*)"|'([^']*)')/g;
      let m, hit = null;
      while ((m = idRe.exec(html))) {
        const val = m[2] !== undefined ? m[2] : m[3];
        if (val === elId) { hit = m; break; }
      }
      if (!hit) throw new Error('no #' + elId + ' in scene.html');

      const open = html.lastIndexOf('<', hit.index);
      const openEnd = html.indexOf('>', hit.index);
      if (open < 0 || openEnd < 0) throw new Error('malformed markup near #' + elId);
      const openTag = html.slice(open, openEnd + 1);
      const tagMatch = /^<\s*([a-zA-Z][\w-]*)/.exec(openTag);
      if (!tagMatch) throw new Error('malformed tag near #' + elId);
      const tag = tagMatch[1].toLowerCase();
      if (VOID_TAGS.has(tag) || /\/\s*>$/.test(openTag)) {
        throw new Error('#' + elId + ' has no text content (void/self-closing element)');
      }

      const innerStart = openEnd + 1;
      const rest = html.slice(innerStart);
      const closeRe = new RegExp('</\\s*' + tag + '\\s*>', 'i');
      const cm = closeRe.exec(rest);
      if (!cm) throw new Error('no closing </' + tag + '> for #' + elId);
      const inner = rest.slice(0, cm.index);
      if (inner.includes('<')) {
        throw new Error('#' + elId + ' contains child markup; edit it in scene.html');
      }

      const escaped = String(text)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const next = html.slice(0, innerStart) + escaped + rest.slice(cm.index);
      writeFileTracked(file, next);
      return next;
    }

    /* Locate #elId's inner-content range in an html string, matching the close
       tag with depth counting so nested same-tag elements are handled. Returns
       { innerStart, innerEnd, tag }; throws for missing / void / self-closing. */
    function locateElementInner(html, elId) {
      const idRe = /\sid\s*=\s*("([^"]*)"|'([^']*)')/g;
      let m, hit = null;
      while ((m = idRe.exec(html))) {
        const val = m[2] !== undefined ? m[2] : m[3];
        if (val === elId) { hit = m; break; }
      }
      if (!hit) throw new Error('no #' + elId + ' in scene.html');
      const open = html.lastIndexOf('<', hit.index);
      const openEnd = html.indexOf('>', hit.index);
      if (open < 0 || openEnd < 0) throw new Error('malformed markup near #' + elId);
      const openTag = html.slice(open, openEnd + 1);
      const tm = /^<\s*([a-zA-Z][\w-]*)/.exec(openTag);
      if (!tm) throw new Error('malformed tag near #' + elId);
      const tag = tm[1].toLowerCase();
      if (VOID_TAGS.has(tag) || /\/\s*>$/.test(openTag)) {
        throw new Error('#' + elId + ' is a void/self-closing element');
      }
      const tagRe = new RegExp('<\\s*(/?)\\s*' + tag + '\\b[^>]*>', 'gi');
      tagRe.lastIndex = openEnd + 1;
      let depth = 1, mm;
      while ((mm = tagRe.exec(html))) {
        if (mm[1] === '/') {
          if (--depth === 0) return { innerStart: openEnd + 1, innerEnd: mm.index, tag };
        } else if (!/\/\s*>$/.test(mm[0])) {
          depth++;
        }
      }
      throw new Error('no matching </' + tag + '> for #' + elId);
    }

    /* Replace the entire inner HTML of #elId, preserving the rest of scene.html
       byte-for-byte. Used for nested edits where the client serialised the
       element's new inner markup (e.g. changed the text inside one child). */
    function setElementHtml(sid, elId, html) {
      if (!safeName(sid)) throw new Error('bad scene id');
      if (!safeName(elId)) throw new Error('bad element id');
      const file = path.join(projectDir, 'scenes', sid, 'scene.html');
      let src;
      try { src = fs.readFileSync(file, 'utf8'); } catch { throw new Error('scene.html not found'); }
      const { innerStart, innerEnd } = locateElementInner(src, elId);
      const next = src.slice(0, innerStart) + String(html) + src.slice(innerEnd);
      writeFileTracked(file, next);
      return next;
    }

    /* Per-element visual overrides live in a generated region of scene.css, one
       `#id{...}` rule each, so the studio can tweak size/colour/position without
       touching hand-authored CSS. We parse the region, upsert this id's
       declarations (merge; a null/empty value drops a property; an empty rule is
       removed), and rewrite only the region — the rest of scene.css is intact. */
    const OV_START = '/* studio:overrides — generated; edit via the STAGE inspector */';
    const OV_END = '/* studio:overrides:end */';
    const STYLE_PROPS = new Set([
      'font-size', 'color', 'background', 'background-color', 'translate',
      'text-align', 'letter-spacing', 'line-height', 'opacity', 'font-weight',
    ]);
    function parseDeclString(s) {
      const out = {};
      for (const part of (s || '').split(';')) {
        const i = part.indexOf(':');
        if (i < 0) continue;
        const k = part.slice(0, i).trim();
        const v = part.slice(i + 1).trim();
        if (k && v) out[k] = v;
      }
      return out;
    }
    function setElementStyle(sid, elId, decls) {
      if (!safeName(sid)) throw new Error('bad scene id');
      if (!safeName(elId)) throw new Error('bad element id');
      const file = path.join(projectDir, 'scenes', sid, 'scene.css');
      let css = '';
      try { css = fs.readFileSync(file, 'utf8'); } catch { css = ''; }

      let head = css, region = '', tail = '';
      const s = css.indexOf(OV_START);
      if (s >= 0) {
        const e = css.indexOf(OV_END, s);
        head = css.slice(0, s).replace(/\s*$/, '');
        region = css.slice(s + OV_START.length, e >= 0 ? e : css.length);
        tail = e >= 0 ? css.slice(e + OV_END.length) : '';
      }
      const rules = new Map();
      const ruleRe = /#([\w.-]+)\s*\{([^}]*)\}/g;
      let rm;
      while ((rm = ruleRe.exec(region))) rules.set(rm[1], parseDeclString(rm[2]));

      const cur = rules.get(elId) || {};
      for (const [k, v] of Object.entries(decls || {})) {
        const prop = String(k).toLowerCase();
        if (!STYLE_PROPS.has(prop)) continue;
        const val = v == null ? '' : String(v).trim();
        if (!val) delete cur[prop];
        else if (/^[^{}<>;]+$/.test(val)) cur[prop] = val; // reject CSS-breaking chars
      }
      if (Object.keys(cur).length) rules.set(elId, cur);
      else rules.delete(elId);

      let out = head.replace(/\s*$/, '');
      if (rules.size) {
        out += '\n\n' + OV_START + '\n';
        for (const [id, d] of rules) {
          out += `#${id}{${Object.entries(d).map(([k, v]) => `${k}:${v}`).join(';')}}\n`;
        }
        out += OV_END + '\n';
      }
      out += tail;
      writeFileTracked(file, out);
      return out;
    }

    /* recordings live one folder deeper than before: per section, not per scene */
    const sectionTakesDir = (sid, lid) => path.join(TAKES_DIR, sid, lid);
    const sectionKey = (sid, lid, file) => sid + '/' + lid + '/' + file;

    /* takes.json: {
         picks:   { sceneId: { lineId: file } },
         offsets: { "sceneId/lineId/file": seconds },
         chains:  { "sceneId/lineId/file": ... }   // per file, owned by tickets 03-08
       }
       Per-scene picks were disposable test data; there is no migration. */
    function readTakesState() {
      const raw = readJson(PICKS_FILE, {});
      return {
        picks: raw.picks && typeof raw.picks === 'object' ? raw.picks : {},
        offsets: raw.offsets || {},
        inPoints: raw.inPoints || {},
        chains: raw.chains || {},
      };
    }
    function writeTakesState(state) {
      writeFileTracked(PICKS_FILE, JSON.stringify(state, null, 2));
    }

    /* list one section's recordings, oldest first */
    function listSection(sid, lid) {
      const dir = sectionTakesDir(sid, lid);
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
      return fs.readdirSync(dir)
        .filter((f) => /\.(webm|ogg|wav|mp3|m4a)$/i.test(f))
        .map((f) => {
          const st = fs.statSync(path.join(dir, f));
          return { file: f, size: st.size, created: st.mtimeMs };
        })
        .sort((a, b) => a.created - b.created);
    }

    /* takes grouped by scene then by line id (section). Walks the on-disk
       takes/<sceneId>/<lineId>/ tree; trash/ and stray files are ignored. */
    function listTakes() {
      const { picks, offsets, inPoints, chains } = readTakesState();
      const out = {};
      if (!fs.existsSync(TAKES_DIR)) return out;
      for (const sd of fs.readdirSync(TAKES_DIR)) {
        const sceneDir = path.join(TAKES_DIR, sd);
        if (!safeName(sd) || !fs.statSync(sceneDir).isDirectory()) continue;
        const sections = {};
        for (const ld of fs.readdirSync(sceneDir)) {
          const lineDir = path.join(sceneDir, ld);
          if (!safeName(ld) || !fs.statSync(lineDir).isDirectory()) continue;
          const takes = listSection(sd, ld);
          if (!takes.length) continue;
          const candidate = (picks[sd] && picks[sd][ld]) || null;
          const chain = candidate ? chains[sectionKey(sd, ld, candidate)] : undefined;
          sections[ld] = {
            candidate,
            offset: candidate ? offsets[sectionKey(sd, ld, candidate)] || 0 : 0,
            inPoint: candidate ? inPoints[sectionKey(sd, ld, candidate)] || 0 : 0,
            ...(chain ? { chain } : {}),
            takes,
          };
        }
        if (Object.keys(sections).length) out[sd] = sections;
      }
      return out;
    }

    return {
      id, projectDir, TAKES_DIR, EXPORTS_DIR, PICKS_FILE,
      loadProject, sceneIds, lineIds, writeTimings, setElementText,
      setElementHtml, setElementStyle, putSceneHtml, putSceneCss,
      sectionTakesDir, sectionKey,
      readTakesState, writeTakesState, listTakes, listSection,
    };
  }

  /* ------------------------------ export -------------------------------- */
  let job = null; // { state, phase, frame, totalFrames, message, output, project }

  async function startExport(ctx, { fps, scene }) {
    if (job && (job.state === 'rendering' || job.state === 'starting')) {
      throw new Error('an export is already running');
    }
    job = { state: 'starting', phase: 'launching chrome', frame: 0, totalFrames: 0,
            message: '', output: null, project: ctx.id, startedAt: Date.now() };
    const { exportVideo } = await import('./render.mjs');
    fs.mkdirSync(ctx.EXPORTS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const name = (scene ? scene + '-' : 'full-') + stamp + '.mp4';
    const outFile = path.join(ctx.EXPORTS_DIR, name);
    const project = ctx.loadProject();
    const takesState = ctx.readTakesState();
    exportVideo({
      url: origin + '/?render=1&project=' + encodeURIComponent(ctx.id),
      fps,
      scene,                       // scene id or null = full video
      sceneIds: project.scenes.map((s) => s.id),
      /* per-scene lines (id + window) so the muxer can place each section take */
      sceneLines: project.scenes.map((s) => ({
        id: s.id,
        lines: s.lines.map((ln) => ({ id: ln.id, from: ln.from, to: ln.to })),
      })),
      width: project.width,
      height: project.height,
      outFile,
      chromePath: process.env.CHROME_PATH || null,
      takesDir: ctx.TAKES_DIR,
      picks: takesState.picks,
      offsets: takesState.offsets,
      inPoints: takesState.inPoints,
      chains: takesState.chains,
      onProgress: (p) => Object.assign(job, p),
    }).then(() => {
      job.state = 'done';
      job.phase = 'done';
      job.output = '/exports/' + name + '?project=' + encodeURIComponent(ctx.id);
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
      /* resolve the project for project-scoped routes: ?project=<id>, falling
         back to the default when absent. Unknown id -> ctx is null -> 404. */
      const entry = registry.resolve(u.searchParams.get('project'));
      const ctx = entry ? projectCtx(entry.id, entry.path) : null;
      const noProject = () => { json(res, 404, { error: 'unknown project' }); };

      if (req.method === 'GET' && p === '/api/projects') {
        json(res, 200, registry.all().map((e) => ({
          id: e.id, name: e.name, path: e.path, default: e.default,
        })));

      } else if (req.method === 'GET' && p === '/api/project') {
        if (!ctx) return noProject();
        json(res, 200, ctx.loadProject());

      } else if (req.method === 'PUT' && /^\/api\/scenes\/[\w-]+\/timings$/.test(p)) {
        if (!ctx) return noProject();
        const id = p.split('/')[3];
        if (!ctx.sceneIds().includes(id)) { json(res, 404, { error: 'unknown scene' }); return; }
        const body = JSON.parse((await readBody(req)).toString('utf8'));
        ctx.writeTimings(id, body);
        json(res, 200, { ok: true });

      } else if (req.method === 'PUT' && /^\/api\/scenes\/[\w.-]+\/element-text$/.test(p)) {
        if (!ctx) return noProject();
        const id = p.split('/')[3];
        if (!ctx.sceneIds().includes(id)) { json(res, 404, { error: 'unknown scene' }); return; }
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        if (typeof body.id !== 'string' || typeof body.text !== 'string') {
          json(res, 400, { error: 'id and text are required' }); return;
        }
        try {
          const html = ctx.setElementText(id, body.id, body.text);
          json(res, 200, { ok: true, html });
        } catch (err) {
          json(res, 400, { error: String(err.message || err) });
        }

      } else if (req.method === 'PUT' && /^\/api\/scenes\/[\w.-]+\/element-html$/.test(p)) {
        if (!ctx) return noProject();
        const id = p.split('/')[3];
        if (!ctx.sceneIds().includes(id)) { json(res, 404, { error: 'unknown scene' }); return; }
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        if (typeof body.id !== 'string' || typeof body.html !== 'string') {
          json(res, 400, { error: 'id and html are required' }); return;
        }
        try {
          const html = ctx.setElementHtml(id, body.id, body.html);
          json(res, 200, { ok: true, html });
        } catch (err) {
          json(res, 400, { error: String(err.message || err) });
        }

      } else if (req.method === 'PUT' && /^\/api\/scenes\/[\w.-]+\/element-style$/.test(p)) {
        if (!ctx) return noProject();
        const id = p.split('/')[3];
        if (!ctx.sceneIds().includes(id)) { json(res, 404, { error: 'unknown scene' }); return; }
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        if (typeof body.id !== 'string' || typeof body.style !== 'object' || !body.style) {
          json(res, 400, { error: 'id and style object are required' }); return;
        }
        try {
          const css = ctx.setElementStyle(id, body.id, body.style);
          json(res, 200, { ok: true, css });
        } catch (err) {
          json(res, 400, { error: String(err.message || err) });
        }

      } else if (req.method === 'PUT' && /^\/api\/scenes\/[\w.-]+\/html$/.test(p)) {
        if (!ctx) return noProject();
        const id = p.split('/')[3];
        if (!ctx.sceneIds().includes(id)) { json(res, 404, { error: 'unknown scene' }); return; }
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        if (typeof body.html !== 'string') { json(res, 400, { error: 'html is required' }); return; }
        try {
          ctx.putSceneHtml(id, body.html);
          json(res, 200, { ok: true });
        } catch (err) {
          json(res, 400, { error: String(err.message || err) });
        }

      } else if (req.method === 'PUT' && /^\/api\/scenes\/[\w.-]+\/css$/.test(p)) {
        if (!ctx) return noProject();
        const id = p.split('/')[3];
        if (!ctx.sceneIds().includes(id)) { json(res, 404, { error: 'unknown scene' }); return; }
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        if (typeof body.css !== 'string') { json(res, 400, { error: 'css is required' }); return; }
        try {
          ctx.putSceneCss(id, body.css);
          json(res, 200, { ok: true });
        } catch (err) {
          json(res, 400, { error: String(err.message || err) });
        }

      } else if (req.method === 'GET' && p === '/api/takes') {
        if (!ctx) return noProject();
        json(res, 200, ctx.listTakes());

      } else if (req.method === 'POST' && /^\/api\/takes\/[\w.-]+\/[\w.-]+$/.test(p)) {
        if (!ctx) return noProject();
        const [, , , sid, lid] = p.split('/');
        if (!ctx.sceneIds().includes(sid)) { json(res, 404, { error: 'unknown scene' }); return; }
        if (!safeName(lid) || !ctx.lineIds(sid).includes(lid)) { json(res, 404, { error: 'unknown line' }); return; }
        const ext = (u.searchParams.get('ext') || 'webm').replace(/[^a-z0-9]/gi, '');
        const body = await readBody(req);
        if (!body.length) { json(res, 400, { error: 'empty body' }); return; }
        const dir = ctx.sectionTakesDir(sid, lid);
        fs.mkdirSync(dir, { recursive: true });
        const file = 'take-' + new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19) + '.' + ext;
        const raw = path.join(dir, 'raw-' + file);
        fs.writeFileSync(raw, body);
        if (await remux(raw, path.join(dir, file))) {
          fs.rmSync(raw, { force: true });
        } else {
          fs.renameSync(raw, path.join(dir, file)); // keep the recording even if ffmpeg fails
        }
        const state = ctx.readTakesState();
        (state.picks[sid] ||= {})[lid] = file; // newest take becomes the candidate
        ctx.writeTakesState(state);
        json(res, 200, { ok: true, file, candidate: file });

      } else if (req.method === 'POST' && /^\/api\/takes\/[\w.-]+\/[\w.-]+\/[\w.-]+\/pick$/.test(p)) {
        if (!ctx) return noProject();
        const [, , , sid, lid, file] = p.split('/');
        if (!safeName(file) || !fs.existsSync(path.join(ctx.sectionTakesDir(sid, lid), file))) {
          json(res, 404, { error: 'take not found' }); return;
        }
        const state = ctx.readTakesState();
        (state.picks[sid] ||= {})[lid] = file;
        ctx.writeTakesState(state);
        json(res, 200, { ok: true });

      } else if (req.method === 'POST' && /^\/api\/takes\/[\w.-]+\/[\w.-]+\/[\w.-]+\/offset$/.test(p)) {
        if (!ctx) return noProject();
        const [, , , sid, lid, file] = p.split('/');
        if (!safeName(file) || !fs.existsSync(path.join(ctx.sectionTakesDir(sid, lid), file))) {
          json(res, 404, { error: 'take not found' }); return;
        }
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const offset = Math.max(-30, Math.min(30, Number(body.offset) || 0));
        const state = ctx.readTakesState();
        const key = ctx.sectionKey(sid, lid, file);
        if (offset === 0) delete state.offsets[key];
        else state.offsets[key] = offset;
        ctx.writeTakesState(state);
        json(res, 200, { ok: true, offset });

      } else if (req.method === 'POST' && /^\/api\/takes\/[\w.-]+\/[\w.-]+\/[\w.-]+\/inpoint$/.test(p)) {
        if (!ctx) return noProject();
        const [, , , sid, lid, file] = p.split('/');
        if (!safeName(file) || !fs.existsSync(path.join(ctx.sectionTakesDir(sid, lid), file))) {
          json(res, 404, { error: 'take not found' }); return;
        }
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        /* seconds into the take where the line's window starts; clamp to a
           generous range (a take can be long, but not absurd). 0 deletes the
           key so an unset in-point writes nothing (same precedent as offset). */
        const inPoint = Math.max(0, Math.min(3600, Number(body.inPoint) || 0));
        const state = ctx.readTakesState();
        const key = ctx.sectionKey(sid, lid, file);
        if (inPoint === 0) delete state.inPoints[key];
        else state.inPoints[key] = inPoint;
        ctx.writeTakesState(state);
        json(res, 200, { ok: true, inPoint });

      } else if (req.method === 'POST' && /^\/api\/takes\/[\w.-]+\/[\w.-]+\/[\w.-]+\/chain$/.test(p)) {
        if (!ctx) return noProject();
        const [, , , sid, lid, file] = p.split('/');
        if (!safeName(file) || !fs.existsSync(path.join(ctx.sectionTakesDir(sid, lid), file))) {
          json(res, 404, { error: 'take not found' }); return;
        }
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        /* build a normalized chain, clamping each effect's fields and dropping
           identity defaults so the stored chain stays minimal. Later tickets
           add their own clamped fields here. */
        const chain = {};
        /* high-pass: { freq } with freq clamped to 20..300 Hz; absent or 0 = bypass */
        if (body.highpass && typeof body.highpass.freq === 'number' && body.highpass.freq > 0) {
          const freq = Math.max(20, Math.min(300, body.highpass.freq));
          chain.highpass = { freq };
        }
        /* noise gate: threshold dB (-80..0); optional range dB of attenuation
           (0..80), attack s (0..0.5), release s (0..2). Object present (with a
           numeric threshold) = enabled; absent object = bypassed. Optional
           fields are dropped when at their default so the stored chain stays
           minimal. Sits after highpass and before the compressor. */
        if (body.gate && typeof body.gate.threshold === 'number') {
          const gate = { threshold: Math.max(-80, Math.min(0, body.gate.threshold)) };
          if (typeof body.gate.range === 'number')   gate.range   = Math.max(0, Math.min(80,  body.gate.range));
          if (typeof body.gate.attack === 'number')  gate.attack  = Math.max(0, Math.min(0.5, body.gate.attack));
          if (typeof body.gate.release === 'number') gate.release = Math.max(0, Math.min(2,   body.gate.release));
          chain.gate = gate;
        }
        /* compressor: threshold dB (-60..0), ratio (1..20), attack s (0..1), release s (0..2).
           Object present = enabled. All fields required; absent object = bypassed. */
        if (body.comp &&
            typeof body.comp.threshold === 'number' &&
            typeof body.comp.ratio     === 'number' &&
            typeof body.comp.attack    === 'number' &&
            typeof body.comp.release   === 'number') {
          chain.comp = {
            threshold: Math.max(-60, Math.min(0,   body.comp.threshold)),
            ratio:     Math.max(1,   Math.min(20,  body.comp.ratio)),
            attack:    Math.max(0,   Math.min(1,   body.comp.attack)),
            release:   Math.max(0,   Math.min(2,   body.comp.release)),
          };
        }
        const gainDb = Math.max(-24, Math.min(24, Number(body.gainDb) || 0));
        if (gainDb !== 0) chain.gainDb = gainDb;
        const state = ctx.readTakesState();
        const key = ctx.sectionKey(sid, lid, file);
        if (Object.keys(chain).length === 0) delete state.chains[key];
        else state.chains[key] = chain;
        ctx.writeTakesState(state);
        json(res, 200, { ok: true, chain });

      } else if (req.method === 'DELETE' && /^\/api\/takes\/[\w.-]+\/[\w.-]+\/[\w.-]+$/.test(p)) {
        if (!ctx) return noProject();
        const [, , , sid, lid, file] = p.split('/');
        const src = path.join(ctx.sectionTakesDir(sid, lid), file);
        if (!safeName(file) || !fs.existsSync(src)) { json(res, 404, { error: 'take not found' }); return; }
        const trash = path.join(ctx.sectionTakesDir(sid, lid), 'trash');
        fs.mkdirSync(trash, { recursive: true });
        fs.renameSync(src, path.join(trash, Date.now() + '-' + file));
        const state = ctx.readTakesState();
        delete state.offsets[ctx.sectionKey(sid, lid, file)];
        delete state.inPoints[ctx.sectionKey(sid, lid, file)];
        delete state.chains[ctx.sectionKey(sid, lid, file)];
        if (state.picks[sid] && state.picks[sid][lid] === file) {
          /* auto-pick the newest remaining take in this section */
          const left = ctx.listSection(sid, lid);
          if (left.length) state.picks[sid][lid] = left[left.length - 1].file;
          else delete state.picks[sid][lid];
        }
        ctx.writeTakesState(state);
        json(res, 200, { ok: true, candidate: (state.picks[sid] && state.picks[sid][lid]) || null });

      } else if (req.method === 'GET' && /^\/takes\/[\w.-]+\/[\w.-]+\/[\w.-]+$/.test(p)) {
        if (!ctx) return noProject();
        const [, , sid, lid, file] = p.split('/');
        if (!safeName(sid) || !safeName(lid) || !safeName(file)) { res.writeHead(404); res.end(); return; }
        sendFile(res, path.join(ctx.TAKES_DIR, sid, lid, file), req.headers.range);

      } else if (req.method === 'POST' && p === '/api/export') {
        if (!ctx) return noProject();
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const fps = Math.max(5, Math.min(60, parseInt(body.fps, 10) || 30));
        const scene = typeof body.scene === 'string' && ctx.sceneIds().includes(body.scene)
          ? body.scene : null;
        if (req.headers.host) origin = 'http://' + req.headers.host;
        await startExport(ctx, { fps, scene });
        json(res, 200, { ok: true });

      } else if (req.method === 'GET' && p === '/api/export/status') {
        json(res, 200, job || { state: 'idle' });

      } else if (req.method === 'GET' && /^\/exports\/[\w.-]+$/.test(p)) {
        if (!ctx) return noProject();
        const file = p.split('/')[2];
        if (!safeName(file)) { res.writeHead(404); res.end(); return; }
        sendFile(res, path.join(ctx.EXPORTS_DIR, file), req.headers.range);

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

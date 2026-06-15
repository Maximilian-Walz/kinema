import type { ExportStatus, ProjectData, ProjectInfo, SceneData, TakeChain, TakesMap } from './types';

/* Which project this page is editing. Read once from ?project=<id> in the URL
   (render mode and a future picker both set it); empty means "the server's
   default project". Every request below carries it so one dev server can serve
   many projects. */
let currentProject = new URLSearchParams(location.search).get('project') || '';

export function getProject(): string {
  return currentProject;
}
export function setProject(id: string): void {
  currentProject = id;
}

/* append ?project=<id> (or &project=) unless we're on the default project */
function withProject(url: string): string {
  if (!currentProject) return url;
  return url + (url.includes('?') ? '&' : '?') + 'project=' + encodeURIComponent(currentProject);
}

async function check(r: Response): Promise<Response> {
  if (!r.ok) {
    /* the API replies { error } as JSON; surface that text, not just a code */
    const text = await r.text().catch(() => '');
    let msg = text;
    try { const j = JSON.parse(text); if (j && j.error) msg = j.error; } catch { /* not json */ }
    throw new Error(msg ? `${r.status}: ${msg}` : `HTTP ${r.status}`);
  }
  return r;
}

/* not project-scoped: lists every registered project for the picker */
export async function fetchProjects(): Promise<ProjectInfo[]> {
  return (await check(await fetch('/api/projects'))).json();
}

export async function fetchProject(): Promise<ProjectData> {
  return (await check(await fetch(withProject('/api/project')))).json();
}

export async function putTimings(scene: SceneData): Promise<void> {
  await check(await fetch(withProject(`/api/scenes/${scene.id}/timings`), {
    method: 'PUT',
    body: JSON.stringify({
      len: scene.len,
      schedule: scene.schedule,
      captions: scene.captions,
      lines: scene.lines,
    }),
  }));
}

export async function fetchTakes(): Promise<TakesMap> {
  return (await check(await fetch(withProject('/api/takes')))).json();
}

export async function uploadTake(sceneId: string, lineId: string, blob: Blob, ext: string): Promise<void> {
  await check(await fetch(withProject(`/api/takes/${sceneId}/${lineId}?ext=${ext}`), { method: 'POST', body: blob }));
}

export async function pickTake(sceneId: string, lineId: string, file: string): Promise<void> {
  await check(await fetch(withProject(`/api/takes/${sceneId}/${lineId}/${file}/pick`), { method: 'POST' }));
}

export async function deleteTake(sceneId: string, lineId: string, file: string): Promise<void> {
  await check(await fetch(withProject(`/api/takes/${sceneId}/${lineId}/${file}`), { method: 'DELETE' }));
}

export async function setTakeOffset(sceneId: string, lineId: string, file: string, offset: number): Promise<void> {
  await check(await fetch(withProject(`/api/takes/${sceneId}/${lineId}/${file}/offset`), {
    method: 'POST',
    body: JSON.stringify({ offset }),
  }));
}

export async function setTakeChain(sceneId: string, lineId: string, file: string, chain: TakeChain): Promise<void> {
  await check(await fetch(withProject(`/api/takes/${sceneId}/${lineId}/${file}/chain`), {
    method: 'POST',
    body: JSON.stringify(chain),
  }));
}

export function takeUrl(sceneId: string, lineId: string, file: string): string {
  return withProject(`/takes/${sceneId}/${lineId}/${file}`);
}

export async function startExport(fps: number, scene: string | null): Promise<void> {
  await check(await fetch(withProject('/api/export'), { method: 'POST', body: JSON.stringify({ fps, scene }) }));
}

export async function exportStatus(): Promise<ExportStatus> {
  return (await check(await fetch('/api/export/status'))).json();
}

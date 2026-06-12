import type { ExportStatus, ProjectData, SceneData, TakesMap } from './types';

async function check(r: Response): Promise<Response> {
  if (!r.ok) throw new Error(`${r.status} ${await r.text().catch(() => '')}`);
  return r;
}

export async function fetchProject(): Promise<ProjectData> {
  return (await check(await fetch('/api/project'))).json();
}

export async function putTimings(scene: SceneData): Promise<void> {
  await check(await fetch(`/api/scenes/${scene.id}/timings`, {
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
  return (await check(await fetch('/api/takes'))).json();
}

export async function uploadTake(sceneId: string, blob: Blob, ext: string): Promise<void> {
  await check(await fetch(`/api/takes/${sceneId}?ext=${ext}`, { method: 'POST', body: blob }));
}

export async function pickTake(sceneId: string, file: string): Promise<void> {
  await check(await fetch(`/api/takes/${sceneId}/${file}/pick`, { method: 'POST' }));
}

export async function deleteTake(sceneId: string, file: string): Promise<void> {
  await check(await fetch(`/api/takes/${sceneId}/${file}`, { method: 'DELETE' }));
}

export async function setTakeOffset(sceneId: string, file: string, offset: number): Promise<void> {
  await check(await fetch(`/api/takes/${sceneId}/${file}/offset`, {
    method: 'POST',
    body: JSON.stringify({ offset }),
  }));
}

export function takeUrl(sceneId: string, file: string): string {
  return `/takes/${sceneId}/${file}`;
}

export async function startExport(fps: number, scene: string | null): Promise<void> {
  await check(await fetch('/api/export', { method: 'POST', body: JSON.stringify({ fps, scene }) }));
}

export async function exportStatus(): Promise<ExportStatus> {
  return (await check(await fetch('/api/export/status'))).json();
}

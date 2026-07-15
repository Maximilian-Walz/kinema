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

/** Patch the inner text of one leaf element (#elId) in a scene's scene.html.
    Server keeps the rest of the file intact and returns the updated HTML; it
    rejects elements that have child markup or no text content. */
export async function setElementText(sceneId: string, elId: string, text: string): Promise<string> {
  const r = await check(await fetch(withProject(`/api/scenes/${sceneId}/element-text`), {
    method: 'PUT',
    body: JSON.stringify({ id: elId, text }),
  }));
  const j = await r.json();
  return j.html as string;
}

/** Replace the entire inner HTML of #elId in a scene's scene.html (nesting-aware
    on the server). Used for nested text edits where the client serialised the
    element's new inner markup. Returns the updated HTML. */
export async function setElementHtml(sceneId: string, elId: string, html: string): Promise<string> {
  const r = await check(await fetch(withProject(`/api/scenes/${sceneId}/element-html`), {
    method: 'PUT',
    body: JSON.stringify({ id: elId, html }),
  }));
  return (await r.json()).html as string;
}

/** Duplicate #elId in scene.html: clone its outer HTML after itself, give the
    copy the fresh id `newId`, strip the copy's descendant ids. Returns html. */
export async function duplicateElement(sceneId: string, elId: string, newId: string): Promise<string> {
  const r = await check(await fetch(withProject(`/api/scenes/${sceneId}/element-duplicate`), {
    method: 'PUT',
    body: JSON.stringify({ id: elId, newId }),
  }));
  return (await r.json()).html as string;
}

/** Delete #elId's node from scene.html (the inverse of duplicateElement).
    Returns the updated scene html. */
export async function deleteElement(sceneId: string, elId: string): Promise<string> {
  const r = await check(await fetch(withProject(`/api/scenes/${sceneId}/element-delete`), {
    method: 'PUT',
    body: JSON.stringify({ id: elId }),
  }));
  return (await r.json()).html as string;
}

/** Set (or clear, with '') the data-label attribute on #elId in scene.html —
    the display name clips/inspector show. Returns the updated scene html. */
export async function setElementLabel(sceneId: string, elId: string, label: string): Promise<string> {
  const r = await check(await fetch(withProject(`/api/scenes/${sceneId}/element-label`), {
    method: 'PUT',
    body: JSON.stringify({ id: elId, label }),
  }));
  return (await r.json()).html as string;
}

/** Duplicate a scene (folder copy + project.json insert after the source);
    line ids are re-prefixed, takes are not copied. Returns the new scene. */
export async function duplicateScene(sceneId: string): Promise<{ id: string; scene: SceneData }> {
  const r = await check(await fetch(withProject(`/api/scenes/${sceneId}/duplicate`), {
    method: 'POST',
  }));
  const j = await r.json();
  return { id: j.id as string, scene: j.scene as SceneData };
}

/** Persist a new scene order into project.json (a permutation of the ids). */
export async function reorderScenes(order: string[]): Promise<void> {
  await check(await fetch(withProject('/api/project/scene-order'), {
    method: 'PUT',
    body: JSON.stringify({ order }),
  }));
}

/** Insert id="newId" on the element reached by `path` (element-child indexes)
    under #ancestorId in scene.html; returns the whole updated scene html. */
export async function assignElementId(
  sceneId: string,
  ancestorId: string,
  path: number[],
  newId: string,
): Promise<string> {
  const r = await check(await fetch(withProject(`/api/scenes/${sceneId}/element-id`), {
    method: 'PUT',
    body: JSON.stringify({ ancestorId, path, newId }),
  }));
  return (await r.json()).html as string;
}

/** Upsert visual override declarations for #elId into the generated overrides
    region of scene.css (size/colour/position). A null/empty value drops that
    property. Returns the updated CSS. */
export async function setElementStyle(
  sceneId: string,
  elId: string,
  style: Record<string, string | null>,
): Promise<string> {
  const r = await check(await fetch(withProject(`/api/scenes/${sceneId}/element-style`), {
    method: 'PUT',
    body: JSON.stringify({ id: elId, style }),
  }));
  return (await r.json()).css as string;
}

/** Overwrite a scene's whole scene.html (used by undo/redo to restore a prior
    snapshot — element-text/html patch incrementally, this writes the lot). */
export async function putSceneHtml(sceneId: string, html: string): Promise<void> {
  await check(await fetch(withProject(`/api/scenes/${sceneId}/html`), {
    method: 'PUT',
    body: JSON.stringify({ html }),
  }));
}

/** Overwrite a scene's whole scene.css (undo/redo counterpart to putSceneHtml). */
export async function putSceneCss(sceneId: string, css: string): Promise<void> {
  await check(await fetch(withProject(`/api/scenes/${sceneId}/css`), {
    method: 'PUT',
    body: JSON.stringify({ css }),
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

export async function setTakeInPoint(sceneId: string, lineId: string, file: string, inPoint: number): Promise<void> {
  await check(await fetch(withProject(`/api/takes/${sceneId}/${lineId}/${file}/inpoint`), {
    method: 'POST',
    body: JSON.stringify({ inPoint }),
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

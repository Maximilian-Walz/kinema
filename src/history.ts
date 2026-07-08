import type { SceneData, ScheduleEntry, TimedText } from './types';

/* ============================================================================
   Undo/redo for scene content edits (timings, text, add/delete). Snapshot
   based: callers take a snapshot before a mutation "transaction" (a drag, a
   text edit, a delete) and commit it afterwards; undo/redo swap the scene's
   editable fields back in place so all object references stay valid.
============================================================================ */

export interface SceneSnapshot {
  len: number;
  schedule: ScheduleEntry[];
  captions: TimedText[];
  lines: TimedText[];
  /* SCENE editor text/style/position edits live in scene.html / scene.css, not
     scene.json — snapshot them too so those edits are undoable as well. */
  html: string;
  css: string;
  /* opaque extra state captured alongside the scene by the hooks (e.g. take
     in-points, which live in takes.json) so a transaction that changes both
     undoes as one step. */
  extra?: unknown;
}

/** Capture/restore state that belongs to a transaction but lives outside the
    scene files (e.g. the take windows in takes.json). `capture` must return a
    JSON-serialisable value; `restore` is only invoked when the edit being
    undone/redone actually changed that value, so unrelated undos never clobber
    edits made outside the history (a slip between two transactions stays). */
export interface HistoryHooks {
  capture(scene: SceneData): unknown;
  restore(scene: SceneData, extra: unknown): void;
}

interface SceneEdit {
  kind: 'scene';
  scene: SceneData;
  before: SceneSnapshot;
  after: SceneSnapshot;
}

/* A project-level edit: the scene LIST changed shape (reorder / duplicate /
   delete). Holds shallow copies of the array — the SceneData objects
   themselves are shared, so scene-scoped edits before/after stay valid. The
   caller owns applying it (Player.setSceneOrder) and persisting the order. */
interface ProjectEdit {
  kind: 'project';
  before: SceneData[];
  after: SceneData[];
}

type Edit = SceneEdit | ProjectEdit;

/** what undo()/redo() popped, for the caller to apply + persist */
export type UndoResult =
  | { kind: 'scene'; scene: SceneData }
  | { kind: 'project'; scenes: SceneData[] }
  | null;

const LIMIT = 200;

export class History {
  private undoStack: Edit[] = [];
  private redoStack: Edit[] = [];
  private readonly hooks?: HistoryHooks;

  constructor(hooks?: HistoryHooks) {
    this.hooks = hooks;
  }

  snapshot(scene: SceneData): SceneSnapshot {
    return structuredClone({
      len: scene.len,
      schedule: scene.schedule,
      captions: scene.captions,
      lines: scene.lines,
      html: scene.html,
      css: scene.css,
      extra: this.hooks?.capture(scene),
    });
  }

  /** record a finished transaction; no-op if nothing changed */
  commit(scene: SceneData, before: SceneSnapshot): void {
    const after = this.snapshot(scene);
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    this.undoStack.push({ kind: 'scene', scene, before, after });
    if (this.undoStack.length > LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  /** record a scene-list reshape (reorder / duplicate / delete); shallow array
      copies are stored, the caller keeps applying + persisting the order */
  commitProject(before: SceneData[], after: SceneData[]): void {
    if (
      before.length === after.length && before.every((s, i) => s === after[i])
    ) return;
    this.undoStack.push({ kind: 'project', before: [...before], after: [...after] });
    if (this.undoStack.length > LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  /** pops + applies (scene edits in place; project edits are returned for the
      caller to apply via Player.setSceneOrder) — null when the stack is empty */
  undo(): UndoResult {
    const edit = this.undoStack.pop();
    if (!edit) return null;
    this.redoStack.push(edit);
    if (edit.kind === 'project') return { kind: 'project', scenes: [...edit.before] };
    this.apply(edit.scene, edit.before);
    this.restoreExtra(edit, edit.before);
    return { kind: 'scene', scene: edit.scene };
  }

  redo(): UndoResult {
    const edit = this.redoStack.pop();
    if (!edit) return null;
    this.undoStack.push(edit);
    if (edit.kind === 'project') return { kind: 'project', scenes: [...edit.after] };
    this.apply(edit.scene, edit.after);
    this.restoreExtra(edit, edit.after);
    return { kind: 'scene', scene: edit.scene };
  }

  /** hand the target snapshot's extra state to the hooks — but only when THIS
      edit changed it, so undoing an unrelated edit can't roll back extra state
      modified outside the history in the meantime */
  private restoreExtra(edit: SceneEdit, target: SceneSnapshot): void {
    if (!this.hooks) return;
    if (JSON.stringify(edit.before.extra) === JSON.stringify(edit.after.extra)) return;
    this.hooks.restore(edit.scene, structuredClone(target.extra));
  }

  private apply(scene: SceneData, snap: SceneSnapshot): void {
    const copy = structuredClone(snap);
    scene.len = copy.len;
    scene.schedule.splice(0, scene.schedule.length, ...copy.schedule);
    scene.captions.splice(0, scene.captions.length, ...copy.captions);
    scene.lines.splice(0, scene.lines.length, ...copy.lines);
    scene.html = copy.html;
    scene.css = copy.css;
  }
}

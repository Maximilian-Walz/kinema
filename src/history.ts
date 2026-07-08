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

interface Edit {
  scene: SceneData;
  before: SceneSnapshot;
  after: SceneSnapshot;
}

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
    this.undoStack.push({ scene, before, after });
    if (this.undoStack.length > LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  /** returns the affected scene (caller persists + refreshes) or null */
  undo(): SceneData | null {
    const edit = this.undoStack.pop();
    if (!edit) return null;
    this.apply(edit.scene, edit.before);
    this.restoreExtra(edit, edit.before);
    this.redoStack.push(edit);
    return edit.scene;
  }

  redo(): SceneData | null {
    const edit = this.redoStack.pop();
    if (!edit) return null;
    this.apply(edit.scene, edit.after);
    this.restoreExtra(edit, edit.after);
    this.undoStack.push(edit);
    return edit.scene;
  }

  /** hand the target snapshot's extra state to the hooks — but only when THIS
      edit changed it, so undoing an unrelated edit can't roll back extra state
      modified outside the history in the meantime */
  private restoreExtra(edit: Edit, target: SceneSnapshot): void {
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

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

  snapshot(scene: SceneData): SceneSnapshot {
    return structuredClone({
      len: scene.len,
      schedule: scene.schedule,
      captions: scene.captions,
      lines: scene.lines,
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
    this.redoStack.push(edit);
    return edit.scene;
  }

  redo(): SceneData | null {
    const edit = this.redoStack.pop();
    if (!edit) return null;
    this.apply(edit.scene, edit.after);
    this.undoStack.push(edit);
    return edit.scene;
  }

  private apply(scene: SceneData, snap: SceneSnapshot): void {
    const copy = structuredClone(snap);
    scene.len = copy.len;
    scene.schedule.splice(0, scene.schedule.length, ...copy.schedule);
    scene.captions.splice(0, scene.captions.length, ...copy.captions);
    scene.lines.splice(0, scene.lines.length, ...copy.lines);
  }
}

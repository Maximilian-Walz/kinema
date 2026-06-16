import * as api from './api';
import { Emitter } from './emitter';
import type { Player } from './engine/player';
import type { SceneData } from './types';

/* Re-length narration line `lineId` to `newDur` seconds, rippling everything
   after the line's (old) end by the delta: the line's own `to`, every following
   line's from/to, the scene `len`, and the scene's schedule entries + captions
   that start at or after the anchor (intervals straddling the anchor stretch).
   Growing `len` shifts later scenes automatically (global offsets are
   cumulative), so this is a pure in-memory mutation of one scene. Snapshot with
   History before, then `TimingSync.changed` + `History.commit` after, for an
   undoable, persisted edit. Returns the applied delta (0 if no-op). */
export function rippleLineLength(scene: SceneData, lineId: string, newDur: number): number {
  const i = scene.lines.findIndex((l) => l.id === lineId);
  if (i < 0) return 0;
  const line = scene.lines[i];
  const anchor = line.to;                       // insert/remove time at the line end
  const delta = newDur - (line.to - line.from);
  if (Math.abs(delta) < 1e-4) return 0;
  line.to += delta;
  for (let j = i + 1; j < scene.lines.length; j++) {
    scene.lines[j].from += delta;
    scene.lines[j].to += delta;
  }
  for (const e of scene.schedule) {
    if (e.enter >= anchor) e.enter += delta;
    if (e.exit !== undefined && e.exit >= anchor) e.exit += delta;
  }
  for (const c of scene.captions) {
    if (c.from >= anchor) c.from += delta;
    if (c.to >= anchor) c.to += delta;
  }
  scene.len += delta;
  return delta;
}

/* After any timing mutation: refresh the engine immediately, persist the
   scene's timing fields back into its scene.json shortly after (debounced
   per scene). The scene files on disk are the single source of truth. */
export class TimingSync {
  readonly events = new Emitter<{ saved: [string]; error: [string] }>();
  private readonly player: Player;
  private readonly timers = new Map<string, number>();

  constructor(player: Player) {
    this.player = player;
  }

  changed(scene: SceneData): void {
    this.player.refreshTimings();
    clearTimeout(this.timers.get(scene.id));
    this.timers.set(scene.id, window.setTimeout(() => {
      api.putTimings(scene)
        .then(() => this.events.emit('saved', scene.id))
        .catch((e) => this.events.emit('error', String(e)));
    }, 500));
  }
}

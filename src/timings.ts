import * as api from './api';
import { Emitter } from './emitter';
import type { Player } from './engine/player';
import type { SceneData } from './types';

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

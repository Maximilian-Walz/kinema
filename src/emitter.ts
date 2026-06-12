/* minimal typed event emitter */
type Fn = (...args: unknown[]) => void;

export class Emitter<E extends Record<string, unknown[]>> {
  private map = new Map<keyof E, Set<Fn>>();

  on<K extends keyof E>(ev: K, fn: (...args: E[K]) => void): () => void {
    let set = this.map.get(ev);
    if (!set) { set = new Set(); this.map.set(ev, set); }
    set.add(fn as Fn);
    return () => set!.delete(fn as Fn);
  }

  emit<K extends keyof E>(ev: K, ...args: E[K]): void {
    this.map.get(ev)?.forEach((fn) => fn(...args));
  }
}

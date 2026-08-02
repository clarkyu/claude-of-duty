/**
 * EventBus — tiny synchronous pub/sub. Owner: orchestrator (core).
 * API: on(name, fn) -> unsubscribe | once(name, fn) | off(name, fn) | emit(name, payload)
 * Listener exceptions are contained so one bad subscriber can't break a frame.
 */
export class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this.map = new Map();
    this.muted = false;
  }

  on(name, fn) {
    let set = this.map.get(name);
    if (!set) this.map.set(name, (set = new Set()));
    set.add(fn);
    return () => this.off(name, fn);
  }

  once(name, fn) {
    const un = this.on(name, (p) => {
      un();
      fn(p);
    });
    return un;
  }

  off(name, fn) {
    this.map.get(name)?.delete(fn);
  }

  emit(name, payload) {
    if (this.muted) return;
    const set = this.map.get(name);
    if (!set || set.size === 0) return;
    for (const fn of set) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[bus] listener for "${name}" threw:`, err);
      }
    }
  }

  clear() {
    this.map.clear();
  }
}

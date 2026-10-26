import { useSyncExternalStore } from "react";

/** Minimal external store usable from React via useSyncExternalStore. */
export function createStore<T>(initial: T) {
  let state = initial;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set(next: T | ((prev: T) => T)) {
      state = typeof next === "function" ? (next as (p: T) => T)(state) : next;
      subs.forEach((s) => s());
    },
    subscribe(cb: () => void) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
  };
}

export type Store<T> = ReturnType<typeof createStore<T>>;

export function useStore<T, S = T>(store: Store<T>, select?: (s: T) => S): S {
  return useSyncExternalStore(store.subscribe, () => (select ? select(store.get()) : (store.get() as unknown as S)));
}

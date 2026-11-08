/**
 * Minimal snapshot-store engine used by the vendored primitives.
 *
 * DSH's original engine is backed by zustand + immer; this port keeps the two
 * methods the primitives consume (getSnapshot/subscribe and update/set) so the
 * copied components compile without pulling the full client runtime in.
 */
export interface SnapshotStore<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
  update(mutator: (draft: T) => void): void
  set(next: T): void
}

export function createSnapshotStore<T>(init: T): SnapshotStore<T> {
  let state = init
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const listener of [...listeners]) listener()
  }
  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    update: (mutator) => {
      const draft = structuredClone(state)
      mutator(draft)
      state = draft
      notify()
    },
    set: (next) => {
      state = next
      notify()
    },
  }
}

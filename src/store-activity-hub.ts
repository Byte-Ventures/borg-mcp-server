import type { ActivityStreamRecord } from "./store.js";

export class ActivityHub {
  readonly #listeners = new Map<string, Set<(entry: ActivityStreamRecord) => void>>();
  readonly #wakeListeners = new Map<string, Map<string, number>>();
  readonly #cubeDeletionListeners = new Map<string, Set<() => void>>();
  readonly #allListeners = new Set<() => void>();

  subscribe(
    cubeId: string,
    listener: (entry: ActivityStreamRecord) => void,
    onCubeDeleted: () => void,
    droneId?: string,
  ): () => void {
    const listeners = this.#listeners.get(cubeId) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(cubeId, listeners);
    const deletionListeners = this.#cubeDeletionListeners.get(cubeId) ?? new Set();
    deletionListeners.add(onCubeDeleted);
    this.#cubeDeletionListeners.set(cubeId, deletionListeners);
    if (droneId !== undefined) {
      const wakeListeners = this.#wakeListeners.get(cubeId) ?? new Map<string, number>();
      wakeListeners.set(droneId, (wakeListeners.get(droneId) ?? 0) + 1);
      this.#wakeListeners.set(cubeId, wakeListeners);
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(cubeId);
      deletionListeners.delete(onCubeDeleted);
      if (deletionListeners.size === 0) this.#cubeDeletionListeners.delete(cubeId);
      if (droneId !== undefined) {
        const wakeListeners = this.#wakeListeners.get(cubeId);
        const count = wakeListeners?.get(droneId) ?? 0;
        if (count <= 1) wakeListeners?.delete(droneId);
        else wakeListeners?.set(droneId, count - 1);
        if (wakeListeners?.size === 0) this.#wakeListeners.delete(cubeId);
      }
    };
  }

  publishCubeDeletion(cubeId: string): void {
    for (const listener of this.#cubeDeletionListeners.get(cubeId) ?? []) {
      try {
        listener();
      } catch {
        // A subscriber cannot roll back or alter a committed cube deletion.
      }
    }
    this.#notifyAll();
  }

  listenerCount(cubeId: string): number {
    return this.#listeners.get(cubeId)?.size ?? 0;
  }

  publish(cubeId: string, entry: ActivityStreamRecord): void {
    for (const listener of this.#listeners.get(cubeId) ?? []) {
      try {
        listener(entry);
      } catch {
        // A live subscriber cannot roll back or alter a committed append.
      }
    }
    this.#notifyAll();
  }

  #notifyAll(): void {
    for (const listener of this.#allListeners) {
      try {
        listener();
      } catch {
        // A dashboard subscriber cannot roll back or alter a committed append.
      }
    }
  }

  subscribeAll(listener: () => void): () => void {
    this.#allListeners.add(listener);
    return () => this.#allListeners.delete(listener);
  }

  publishDashboardChange(): void {
    this.#notifyAll();
  }

  wakeTargets(): readonly { readonly cubeId: string; readonly droneId: string }[] {
    return [...this.#wakeListeners.entries()].flatMap(([cubeId, drones]) =>
      [...drones.keys()].map((droneId) => ({ cubeId, droneId })),
    );
  }
}

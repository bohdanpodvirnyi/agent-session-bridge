export async function withRetry<T>(
  action: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

export interface MemoryLockStore {
  locks: Set<string>;
}

export async function acquireLock(
  store: MemoryLockStore,
  key: string,
): Promise<boolean> {
  if (store.locks.has(key)) {
    return false;
  }

  store.locks.add(key);
  return true;
}

export async function releaseLock(
  store: MemoryLockStore,
  key: string,
): Promise<void> {
  store.locks.delete(key);
}

export async function recoverStaleLock(
  store: MemoryLockStore,
  key: string,
): Promise<void> {
  store.locks.delete(key);
}

export async function nonBlockingMirrorWrite(
  action: () => Promise<void>,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await action();
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

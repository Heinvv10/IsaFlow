/**
 * At most MAX_CONCURRENT snapshots (or standalone check runs) at once in this process: each holds a pooled connection
 * for its whole run (seconds to tens of seconds), and the pool is shared with every request's after-commit work and
 * the public routes. Automatic snapshots wait for a slot; one asked for by hand is refused while the slots are full.
 */
import { SnapshotBusyError } from './auditTx';

export const MAX_CONCURRENT_SNAPSHOTS = 2;
let running = 0;
const waiting: (() => void)[] = [];

export async function withSnapshotSlot<T>(wait: boolean, fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT_SNAPSHOTS) {
    if (!wait) throw new SnapshotBusyError('The server is already taking the most audit snapshots it runs at once. Try again shortly.');
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  running += 1;
  try {
    return await fn();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

/**
 * At most MAX_CONCURRENT whole-ledger jobs at once in this process — snapshots, standalone check runs, verifies,
 * comparisons and pack verifies: each reads a company's whole ledger (seconds to tens of seconds) on connections the
 * pool shares with every request's after-commit work and the public routes. This bounds their load however many
 * members send requests (the rate limit is per member, for fairness, not for the pool). Automatic snapshots wait for
 * a slot; anything asked for by a person or an agent is refused (409) while the slots are full.
 */
import { SnapshotBusyError } from './auditTx';

export const MAX_CONCURRENT_SNAPSHOTS = 2;
let running = 0;
const waiting: (() => void)[] = [];

export async function withSnapshotSlot<T>(wait: boolean, fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT_SNAPSHOTS) {
    if (!wait) throw new SnapshotBusyError('The server is already running the most audit jobs (snapshots, verifies, comparisons) it runs at once. Try again shortly.');
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

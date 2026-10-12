/**
 * At most MAX_CONCURRENT_SNAPSHOTS whole-ledger jobs at once in this process — snapshots, standalone check runs,
 * verifies, comparisons and pack verifies — and at most PER_COMPANY of them for any one company. Each reads a
 * company's whole ledger (seconds to tens of seconds) on connections the pool shares with every request's after-commit
 * work and the public routes, so this bounds their load however many members send requests (the rate limit is per
 * member, for fairness, not for the pool), and one company can never hold every slot and starve the others.
 * Automatic snapshots wait for a slot (at most AUDIT_WAIT_MS, then refused: a holder that hangs cannot stall them for
 * ever); anything asked for by a person or an agent is refused (409) while none is free.
 */
import { AUDIT_WAIT_MS, SnapshotBusyError } from './auditTx';

export const MAX_CONCURRENT_SNAPSHOTS = 2;
export const PER_COMPANY = 1;
let running = 0;
const held = new Map<string, number>();
const waiting: { companyId: string; go: () => void }[] = [];

const free = (companyId: string) => running < MAX_CONCURRENT_SNAPSHOTS && (held.get(companyId) ?? 0) < PER_COMPANY;

function take(companyId: string) {
  running += 1;
  held.set(companyId, (held.get(companyId) ?? 0) + 1);
}

function give(companyId: string) {
  running -= 1;
  const left = (held.get(companyId) ?? 1) - 1;
  if (left > 0) held.set(companyId, left); else held.delete(companyId);
  // Wake the longest-waiting job that may run now (another company's, when this one still holds its share).
  const next = waiting.findIndex((w) => free(w.companyId));
  if (next >= 0) {
    const [w] = waiting.splice(next, 1);
    take(w!.companyId);
    w!.go();
  }
}

export async function withSnapshotSlot<T>(companyId: string, wait: boolean, fn: () => Promise<T>): Promise<T> {
  if (free(companyId)) {
    take(companyId);
  } else {
    if (!wait) {
      throw new SnapshotBusyError('An audit job (snapshot, verify or comparison) is already running for this company, or the '
        + 'server is running the most it runs at once. Try again shortly.');
    }
    // The slot is taken for us before we are woken; past AUDIT_WAIT_MS we leave the queue and are refused.
    await new Promise<void>((go, refuse) => {
      const timer = setTimeout(() => {
        const at = waiting.indexOf(me);
        if (at < 0) return;
        waiting.splice(at, 1);
        refuse(new SnapshotBusyError(`No audit slot came free for this company within ${AUDIT_WAIT_MS / 60_000} minutes.`));
      }, AUDIT_WAIT_MS);
      const me = { companyId, go: () => { clearTimeout(timer); go(); } };
      waiting.push(me);
    });
  }
  try {
    return await fn();
  } finally {
    give(companyId);
  }
}

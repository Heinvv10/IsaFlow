/**
 * At most MAX_CONCURRENT_SNAPSHOTS whole-ledger jobs at once in this process — snapshots, standalone check runs,
 * verifies, comparisons, pack builds and pack verifies — at most PER_COMPANY of them for any one company and PER_USER
 * for any one person (whichever of their companies it is for). Each reads a company's whole ledger (seconds to tens of
 * seconds) on connections the pool shares with every request's after-commit work and the public routes, so this
 * bounds their load however many members send requests; neither one company nor one person can hold every slot and
 * starve the others (breaker r2 N5: one person with two companies did).
 * Automatic snapshots wait for a slot (at most AUDIT_WAIT_MS, then refused: a holder that hangs cannot stall them for
 * ever); anything asked for by a person or an agent is refused (409) while none is free — a waiting web request would
 * hold its own pooled connection.
 */
import { als } from '@/lib/als';
import { AUDIT_WAIT_MS, SnapshotBusyError } from './auditTx';

export const MAX_CONCURRENT_SNAPSHOTS = 2;
export const PER_COMPANY = 1;
export const PER_USER = 1;
let running = 0;
const heldByCompany = new Map<string, number>();
const heldByUser = new Map<string, number>();
const waiting: { companyId: string; userId: string | null; go: () => void }[] = [];

const count = (m: Map<string, number>, k: string | null) => (k === null ? 0 : m.get(k) ?? 0);
const bump = (m: Map<string, number>, k: string | null, by: number) => {
  if (k === null) return;
  const n = count(m, k) + by;
  if (n > 0) m.set(k, n); else m.delete(k);
};

const free = (companyId: string, userId: string | null) => running < MAX_CONCURRENT_SNAPSHOTS
  && count(heldByCompany, companyId) < PER_COMPANY && count(heldByUser, userId) < PER_USER;

function take(companyId: string, userId: string | null) {
  running += 1;
  bump(heldByCompany, companyId, 1);
  bump(heldByUser, userId, 1);
}

function give(companyId: string, userId: string | null) {
  running -= 1;
  bump(heldByCompany, companyId, -1);
  bump(heldByUser, userId, -1);
  // Wake the longest-waiting job that may run now (another company's or person's, when this one still holds its share).
  const next = waiting.findIndex((w) => free(w.companyId, w.userId));
  if (next >= 0) {
    const [w] = waiting.splice(next, 1);
    take(w!.companyId, w!.userId);
    w!.go();
  }
}

/** `userId`: the person the job runs for — the request's own by default. */
export async function withSnapshotSlot<T>(companyId: string, wait: boolean, fn: () => Promise<T>,
  userId: string | null = als.getStore()?.userId ?? null): Promise<T> {
  if (free(companyId, userId)) {
    take(companyId, userId);
  } else {
    if (!wait) {
      throw new SnapshotBusyError('An audit job (snapshot, verify or comparison) is already running for this company or for you, '
        + 'or the server is running the most it runs at once. Try again shortly.');
    }
    // The slot is taken for us before we are woken; past AUDIT_WAIT_MS we leave the queue and are refused.
    await new Promise<void>((go, refuse) => {
      const timer = setTimeout(() => {
        const at = waiting.indexOf(me);
        if (at < 0) return;
        waiting.splice(at, 1);
        refuse(new SnapshotBusyError(`No audit slot came free for this company within ${AUDIT_WAIT_MS / 60_000} minutes.`));
      }, AUDIT_WAIT_MS);
      const me = { companyId, userId, go: () => { clearTimeout(timer); go(); } };
      waiting.push(me);
    });
  }
  try {
    return await fn();
  } finally {
    give(companyId, userId);
  }
}

/**
 * At most MAX_CONCURRENT_SNAPSHOTS whole-ledger jobs at once in this process — snapshots, standalone check runs,
 * verifies, comparisons, pack builds and pack verifies — at most PER_COMPANY of them for any one company and PER_USER
 * for any one person (whichever of their companies it is for). Each reads a company's whole ledger (seconds to tens of
 * seconds) on connections the pool shares with every request's after-commit work and the public routes, so this
 * bounds their load however many members send requests; neither one company nor one person can hold every slot and
 * starve the others (breaker r2 N5: one person with two companies did).
 * Automatic snapshots hold at most MAX_AUTOMATIC slots (the rest stay free for what people and agents ask for) and
 * wait for one — the per-person cap applies to them too, so a person cannot fill the slots by closing and reopening
 * periods — for up to SLOT_WAIT_MS (a wait holds no database connection, and the snapshot's time budget starts only
 * once it runs), taking people in turn rather than in arrival order, at most MAX_WAITING_PER_USER per person. Anything asked for by a person or an agent is
 * refused (409) while no slot is free — a waiting web request would hold its own pooled connection.
 */
import { als } from '@/lib/als';
import { SnapshotBusyError } from './auditTx';

export const MAX_CONCURRENT_SNAPSHOTS = 2;
export const PER_COMPANY = 1;
export const PER_USER = 1;
/** Automatic jobs hold at most this many slots: the rest stay free for what people and agents ask for. */
export const MAX_AUTOMATIC = 1;
export const SLOT_WAIT_MS = 60 * 60_000;
export const MAX_WAITING_PER_USER = 50;
let running = 0;
let runningAutomatic = 0;
const heldByCompany = new Map<string, number>();
const heldByUser = new Map<string, number>();
const waiting: { companyId: string; userId: string | null; go: () => void }[] = [];
/** When each person's automatic job last started: the queue takes people in turn, not in arrival order. */
const lastServed = new Map<string, number>();
let tick = 0;

const count = (m: Map<string, number>, k: string | null) => (k === null ? 0 : m.get(k) ?? 0);
const bump = (m: Map<string, number>, k: string | null, by: number) => {
  if (k === null) return;
  const n = count(m, k) + by;
  if (n > 0) m.set(k, n); else m.delete(k);
};

const free = (companyId: string, userId: string | null, automatic: boolean) => running < MAX_CONCURRENT_SNAPSHOTS
  && count(heldByCompany, companyId) < PER_COMPANY && count(heldByUser, userId) < PER_USER
  && (!automatic || runningAutomatic < MAX_AUTOMATIC);

function take(companyId: string, userId: string | null, automatic: boolean) {
  running += 1;
  if (automatic) {
    runningAutomatic += 1;
    lastServed.set(userId ?? '', ++tick);
  }
  bump(heldByCompany, companyId, 1);
  bump(heldByUser, userId, 1);
}

function give(companyId: string, userId: string | null, automatic: boolean) {
  running -= 1;
  if (automatic) runningAutomatic -= 1;
  bump(heldByCompany, companyId, -1);
  bump(heldByUser, userId, -1);
  // Wake a waiting (automatic) job that may run now: the person served longest ago first, then the earliest queued.
  let next = -1;
  for (let i = 0; i < waiting.length; i++) {
    const w = waiting[i]!;
    if (!free(w.companyId, w.userId, true)) continue;
    if (next < 0 || (lastServed.get(w.userId ?? '') ?? 0) < (lastServed.get(waiting[next]!.userId ?? '') ?? 0)) next = i;
  }
  if (next >= 0) {
    const [w] = waiting.splice(next, 1);
    take(w!.companyId, w!.userId, true);
    w!.go();
  }
}

/** `userId`: the person the job runs for — the request's own by default. */
export async function withSnapshotSlot<T>(companyId: string, wait: boolean, fn: () => Promise<T>,
  userId: string | null = als.getStore()?.userId ?? null): Promise<T> {
  // `wait`: an automatic job (it queues); anything a person or an agent asks for is refused while busy.
  if (free(companyId, userId, wait)) {
    take(companyId, userId, wait);
  } else {
    if (!wait) {
      throw new SnapshotBusyError('An audit job (snapshot, verify or comparison) is already running for this company or for you, '
        + 'or the server is running the most it runs at once. Try again shortly.');
    }
    if (userId !== null && waiting.filter((w) => w.userId === userId).length >= MAX_WAITING_PER_USER) {
      throw new SnapshotBusyError(`${MAX_WAITING_PER_USER} audit jobs are already waiting for you; this one is not queued.`);
    }
    // The slot is taken for us before we are woken; past SLOT_WAIT_MS we leave the queue and are refused.
    await new Promise<void>((go, refuse) => {
      const timer = setTimeout(() => {
        const at = waiting.indexOf(me);
        if (at < 0) return;
        waiting.splice(at, 1);
        refuse(new SnapshotBusyError(`No audit slot came free for this company within ${SLOT_WAIT_MS / 60_000} minutes.`));
      }, SLOT_WAIT_MS);
      const me = { companyId, userId, go: () => { clearTimeout(timer); go(); } };
      waiting.push(me);
    });
  }
  try {
    return await fn();
  } finally {
    give(companyId, userId, wait);
  }
}

/**
 * Queueing the automatic snapshot taken when a fiscal period is closed or
 * locked, a VAT period locked or a year closed (Hein's decision D3).
 *
 * NEVER blocks or rolls back the lock: this only puts work on the request's
 * after-commit list (runAfterCommit) and logs — never throws — if it cannot.
 * The work (./autoSnapshot) is loaded only when it runs, so the period and
 * VAT services do not import the snapshot machinery.
 *
 * One request that closes many periods (bulk close, close year) queues ONE
 * snapshot per trigger, at the latest cutoff it closed.
 */
import { als, type RequestContext } from '@/lib/als';
import { runAfterCommit } from '@/lib/afterCommit';
import { log } from '@/lib/logger';

export type AutoTrigger = 'period_close' | 'vat_lock' | 'year_close';
interface Pending { trigger: AutoTrigger; cutoff: string }

const queued = new WeakMap<RequestContext, Map<AutoTrigger, Pending>>();

export function scheduleAutoSnapshot(trigger: AutoTrigger, cutoff: string): void {
  try {
    const store = als.getStore();
    if (!store?.companyId || !store.userId) {
      log.warn('audit: automatic snapshot skipped — no request principal', { trigger, cutoff }, 'audit');
      return;
    }
    let pending = queued.get(store);
    if (!pending) {
      const items = new Map<AutoTrigger, Pending>();
      const principal = { userId: store.userId, companyId: store.companyId, claims: { ...store.claims } };
      runAfterCommit('audit-auto-snapshot', async () => {
        const { runAutoSnapshots } = await import('./autoSnapshot');
        await runAutoSnapshots(principal, [...items.values()]);
      });
      queued.set(store, items);
      pending = items;
    }
    const prev = pending.get(trigger);
    if (!prev || cutoff > prev.cutoff) pending.set(trigger, { trigger, cutoff });
  } catch (err) {
    log.error('audit: could not queue the automatic snapshot', { trigger, cutoff,
      error: err instanceof Error ? err.message : String(err) }, 'audit');
  }
}

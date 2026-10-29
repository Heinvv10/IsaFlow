/**
 * Queueing the rolling-forecast roll after a fiscal period is closed or locked, or a year closed
 * (Budgets P4 spec §6), modelled on `audit/autoSnapshotQueue`.
 *
 * NEVER blocks or rolls back the close: this only puts work on the request's after-commit list
 * (runAfterCommit) and logs, never throws, if it cannot. The work (./budgetRollJob) is loaded
 * only when it runs, so the period service does not import the budget machinery. One request that
 * closes many periods (bulk close, close year) queues ONE job holding every end date; the job
 * rolls each fiscal year's rolling version once, from committed state.
 *
 * No request principal (a script or cron calling closePeriod): nothing is queued, logged; the
 * versions bar shows the version stale and offers Roll now.
 */
import { als, type RequestContext } from '@/lib/als';
import { runAfterCommit } from '@/lib/afterCommit';
import { log } from '@/lib/logger';

const queued = new WeakMap<RequestContext, Map<string, Set<string>>>();

export function scheduleBudgetRoll(companyId: string, endDate: string): void {
  try {
    const store = als.getStore();
    if (!store?.userId || !store.companyId) {
      log.warn('budgets: rolling forecast roll skipped — no request principal', { companyId, endDate }, 'accounting');
      return;
    }
    let pending = queued.get(store);
    if (!pending) {
      const byCompany = new Map<string, Set<string>>();
      const principal = { userId: store.userId, claims: { ...store.claims } };
      runAfterCommit('budget-rolling-forecast', async () => {
        const { runBudgetRolls } = await import('./budgetRollJob');
        for (const [company, dates] of byCompany) await runBudgetRolls({ ...principal, companyId: company }, [...dates]);
      });
      queued.set(store, byCompany);
      pending = byCompany;
    }
    const dates = pending.get(companyId) ?? new Set<string>();
    dates.add(endDate);
    pending.set(companyId, dates);
  } catch (err) {
    log.error('budgets: could not queue the rolling forecast roll', {
      companyId, endDate, error: err instanceof Error ? err.message : String(err),
    }, 'accounting');
  }
}

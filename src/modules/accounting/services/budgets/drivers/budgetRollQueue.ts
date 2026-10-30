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
 * Not hooked into yearEndCloseService.closeFiscalYear (ruling 2026-10-29): it only LOCKS periods
 * already closed, whose closes already queued a roll, so the closed set does not change; a missed
 * roll shows as staleMonths with Roll now.
 *
 * No request principal (a script or cron calling closePeriod): nothing is queued, logged; the
 * versions bar shows the version stale and offers Roll now.
 */
import { als, type RequestContext } from '@/lib/als';
import { runAfterCommit } from '@/lib/afterCommit';
import { log } from '@/lib/logger';

const queued = new WeakMap<RequestContext, Set<string>>();

/**
 * The company is the request's (store.companyId), as autoSnapshotQueue takes it: the roll runs
 * under that company's GUC and the closer's claims. A different `companyId` is a caller bug,
 * refused and logged, never rolled under the request's company.
 */
export function scheduleBudgetRoll(companyId: string, endDate: string): void {
  try {
    const store = als.getStore();
    if (!store?.userId || !store.companyId) {
      log.warn('budgets: rolling forecast roll skipped — no request principal', { companyId, endDate }, 'accounting');
      return;
    }
    if (store.companyId !== companyId) {
      log.error('budgets: rolling forecast roll refused — the company is not the request\'s', {
        companyId, requestCompanyId: store.companyId, endDate,
      }, 'accounting');
      return;
    }
    let dates = queued.get(store);
    if (!dates) {
      const pending = new Set<string>();
      const principal = { userId: store.userId, companyId: store.companyId, claims: { ...store.claims } };
      runAfterCommit('budget-rolling-forecast', async () => {
        const { runBudgetRolls } = await import('./budgetRollJob');
        await runBudgetRolls(principal, [...pending]);
      });
      queued.set(store, pending);
      dates = pending;
    }
    dates.add(endDate);
  } catch (err) {
    log.error('budgets: could not queue the rolling forecast roll', {
      companyId, endDate, error: err instanceof Error ? err.message : String(err),
    }, 'accounting');
  }
}

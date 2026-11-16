/**
 * Whether the current code runs inside a period flow's lock budget
 * (`withPeriodLockBudget`: close, lock, reopen, Close Year, bulk, the year-end
 * close and its dry run). Server-only.
 *
 * `getCloseReadiness` reads it: inside a budget a lock wait that ran out
 * (55P03) or a lost deadlock (40P01) in a check is rethrown, so the flow
 * answers 503 retry. Outside one (the checklist panel, MCP
 * period_close_checklist, the close run) the check becomes one busy warn row
 * and the rest of the checklist still comes back.
 *
 * The scope is AsyncLocalStorage, so after-commit work queued inside a budget
 * (scheduleAutoSnapshot, scheduleBudgetRoll) inherits it: a background reader
 * of getCloseReadiness started from there would rethrow a busy check instead of
 * getting a busy row.
 *
 * Its own module, with no imports from the gate, because the gate imports the
 * readiness service.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const scope = new AsyncLocalStorage<true>();

export function inPeriodLockBudget(): boolean {
  return scope.getStore() === true;
}

export function runInPeriodLockBudget<T>(fn: () => Promise<T>): Promise<T> {
  return scope.run(true, fn);
}

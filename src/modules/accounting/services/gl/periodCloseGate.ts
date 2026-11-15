/**
 * The period-close gate: the ONE place that decides whether the books are
 * ready for a period to be closed or locked (Hein, 2026-11-15: every close
 * refuses when a readiness check fails, as MCP close_fiscal_period already did).
 *
 * Every writer that moves a fiscal period to `closed` or `locked` calls it,
 * after taking the period row lock(s) and before the UPDATE, in the same
 * transaction (`fiscalPeriodCloseWrites.ts`, `yearEndPeriodGate.ts`):
 *   - `closePeriod` — the app's Close and Bulk Close, and MCP
 *     close_fiscal_period (through `closePeriodWithReadiness`), dry run included;
 *   - `closeYear` — Close Year, all or nothing;
 *   - `lockPeriod` — Lock and Bulk Lock;
 *   - the year-end close, for every period it locks.
 * Lock and the year-end close judge periods that are already `closed`: a
 * period closed before this gate existed, or one that changed after its close,
 * is judged again before it is locked for good.
 *
 * Row locks are taken in (fiscal_year, period_number, id) order everywhere, so
 * two close requests over overlapping periods wait for each other instead of
 * deadlocking; each wait is bounded (`withPeriodLockBudget`).
 *
 * What blocks is `isCloseBlocker`: a `fail`, or a check that could not be
 * computed. An ordinary `warn` does not. There is no override.
 *
 * ── ACCEPTED LIMIT: WRITES INTO THE PERIOD DURING THE CLOSE ─────────────────
 *
 * The period row lock serialises close, reopen, lock and year close of that
 * period. It does NOT stop another transaction writing INTO the period (a bank
 * line imported, a journal posted) between the gate's reads and the close's
 * COMMIT: no posting or import path locks the period row, and making every
 * writer do so is out of scope. Such a row can land in a period that closed
 * with the checks passing. It cannot get further unnoticed: Lock and the
 * year-end close run this gate again on every period they lock, so it is
 * caught before the period is locked for good.
 */

import { als } from '@/lib/als';
import { log } from '@/lib/logger';
import { isLockContention } from '@/modules/accounting/services/core/lockContention';
import {
  currentLockTimeout, ROW_LOCK_BUDGET_MS, withRowLockBudget,
} from '@/modules/accounting/services/core/rowLockBudget';
import { getCloseReadiness, type CloseCheckMemo, type CloseReadiness } from './periodCloseReadinessService';
import {
  FiscalPeriodLockTimeoutError, isCloseBlocker, PeriodCloseBlockedError, YearCloseBlockedError,
  type BlockedPeriod, type GatedAction,
} from './periodCloseErrors';
import type { FiscalPeriod } from '../../types/gl.types';

/**
 * Runs the readiness checks for one period and throws `PeriodCloseBlockedError`
 * naming every blocker. Returns the readiness (warnings included) when the
 * period may close. The caller holds the period row lock.
 */
export async function assertPeriodCloseReady(
  companyId: string, periodId: string, memo?: CloseCheckMemo, action: GatedAction = 'closed',
): Promise<CloseReadiness> {
  const readiness = await getCloseReadiness(companyId, periodId, memo);
  if (!readiness) throw new Error(`Fiscal period ${periodId} not found`);
  const blockers = readiness.items.filter(isCloseBlocker);
  if (blockers.length > 0) {
    log.info('Period close refused by the readiness checks', {
      companyId, periodId, blockers: blockers.map((b) => b.key),
    }, 'accounting');
    throw new PeriodCloseBlockedError(readiness.periodLabel, blockers, readiness.items, periodId, action);
  }
  return readiness;
}

/**
 * Runs the gate for EVERY period given and throws one `YearCloseBlockedError`
 * naming each blocked period and its checks. All or nothing, because the year
 * close and the year-end lock write all their periods in one UPDATE.
 */
export async function assertYearCloseReady(
  companyId: string,
  fiscalYear: number,
  periods: ReadonlyArray<Pick<FiscalPeriod, 'id' | 'periodName'>>,
  memo: CloseCheckMemo = {},
  action: GatedAction = 'closed',
): Promise<void> {
  const blocked: BlockedPeriod[] = [];
  for (const period of periods) {
    try {
      await assertPeriodCloseReady(companyId, period.id, memo, action);
    } catch (err) {
      if (!(err instanceof PeriodCloseBlockedError)) throw err;
      blocked.push(...err.periods);
    }
  }
  if (blocked.length > 0) throw new YearCloseBlockedError(fiscalYear, blocked, action);
}

const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, min: 60_000, h: 3_600_000, d: 86_400_000 };

/** A `lock_timeout` setting ('0', '250ms', '5s', '1min') in ms; 0 = unbounded; null when unreadable. */
export function lockTimeoutMs(setting: string): number | null {
  const m = /^(\d+)\s*(ms|s|min|h|d)?$/.exec(setting.trim());
  return m ? Number(m[1]) * UNIT_MS[m[2] ?? 'ms']! : null;
}

/**
 * Every lock a close / lock / year-end flow takes waits at most the row-lock
 * budget: a transaction-local `lock_timeout` of 5 s, or the caller's own when
 * that is tighter (tighten only, never loosen), restored afterwards. A wait that
 * runs out, or a deadlock this flow lost, is `FiscalPeriodLockTimeoutError`:
 * 503 + Retry-After at the routes, and the whole request rolls back. `what`
 * names the locks the flow takes (default: a fiscal period or its year), since
 * any lock wait inside `fn` lands here, not only the period rows'.
 * A lock wait inside a readiness check is rethrown by the check, not degraded
 * to "Could not compute" (getCloseReadiness, subLedgerTieCheck), so it is busy
 * (503) here too, never a refusal.
 * No `statement_timeout` is set: a check cancelled by one degrades to "Could not
 * compute", which refuses the close, so a tight one would turn load into refusals.
 */
export async function withPeriodLockBudget<T>(fn: () => Promise<T>, what?: string): Promise<T> {
  const client = als.getStore()?.client;
  let deadline = Date.now() + ROW_LOCK_BUDGET_MS;
  if (client) {
    const current = lockTimeoutMs(await currentLockTimeout(client));
    if (current !== null && current > 0) deadline = Math.min(deadline, Date.now() + current);
  }
  return withRowLockBudget(fn, () => new FiscalPeriodLockTimeoutError(what), { deadline, isTimeout: isLockContention });
}

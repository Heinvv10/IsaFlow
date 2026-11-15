/**
 * The period-close gate: the ONE place that decides whether the books are
 * ready for a period to close (Hein, 2026-11-15: the app's own close refuses
 * when any readiness check fails, as MCP close_fiscal_period already did).
 *
 * Every writer that moves a fiscal period to `closed` calls it, after taking
 * the period row lock and before the UPDATE, inside the same transaction:
 *   - `fiscalPeriodService.closePeriod` — the app's Close and Bulk Close, and
 *     MCP close_fiscal_period (through `closePeriodWithReadiness`);
 *   - `fiscalPeriodService.closeYear` — Close Year, all or nothing.
 * The year-end close (`yearEndCloseService.closeFiscalYear`) only LOCKS periods
 * and refuses any that are not already closed, so every period it locks came
 * through this gate first.
 *
 * What blocks is `isCloseBlocker`: a `fail`, or a check that could not be
 * computed. An ordinary `warn` does not. There is no override.
 */

import { log } from '@/lib/logger';
import { getCloseReadiness, type CloseReadiness } from './periodCloseReadinessService';
import {
  isCloseBlocker, PeriodCloseBlockedError, YearCloseBlockedError, type BlockedPeriod,
} from './periodCloseErrors';
import type { FiscalPeriod } from '../../types/gl.types';

/**
 * Runs the readiness checks for one period and throws `PeriodCloseBlockedError`
 * naming every blocker. Returns the readiness (warnings included) when the
 * period may close. The caller holds the period row lock.
 */
export async function assertPeriodCloseReady(companyId: string, periodId: string): Promise<CloseReadiness> {
  const readiness = await getCloseReadiness(companyId, periodId);
  if (!readiness) throw new Error(`Fiscal period ${periodId} not found`);
  const blockers = readiness.items.filter(isCloseBlocker);
  if (blockers.length > 0) {
    log.info('Period close refused by the readiness checks', {
      companyId, periodId, blockers: blockers.map((b) => b.key),
    }, 'accounting');
    throw new PeriodCloseBlockedError(readiness.periodLabel, blockers, readiness.items, periodId);
  }
  return readiness;
}

/**
 * Runs the gate for EVERY period a year close would close and throws one
 * `YearCloseBlockedError` naming each blocked period and its checks. All or
 * nothing, because the year close writes all its periods in one UPDATE.
 */
export async function assertYearCloseReady(
  companyId: string,
  fiscalYear: number,
  periods: ReadonlyArray<Pick<FiscalPeriod, 'id' | 'periodName'>>,
): Promise<void> {
  const blocked: BlockedPeriod[] = [];
  for (const period of periods) {
    try {
      await assertPeriodCloseReady(companyId, period.id);
    } catch (err) {
      if (!(err instanceof PeriodCloseBlockedError)) throw err;
      blocked.push(...err.periods);
    }
  }
  if (blocked.length > 0) throw new YearCloseBlockedError(fiscalYear, blocked);
}

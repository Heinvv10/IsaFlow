/**
 * Closing a fiscal period for a caller that is not a person (MCP
 * close_fiscal_period): a dry run, and a result that carries the whole
 * checklist.
 *
 * Nothing here judges anything. The dry run is `judgePeriodClose` and the live
 * close is `closePeriodWithVerdict` (fiscalPeriodCloseWrites): the same row
 * lock, status and prior-period guards and readiness gate (periodCloseGate) in
 * both, so a dry run refuses exactly where the live call would, and the
 * checklist returned is the verdict the close was judged on, under its lock.
 *
 * "Not ready" is not a lock an agent can respect, so a refusal is a list: every
 * failing check with its key, its reason and the screen that fixes it
 * (`PeriodCloseBlockedError`). A check that could not be computed blocks too
 * (`isCloseBlocker`).
 */

import { log } from '@/lib/logger';
import { closePeriodWithVerdict, judgePeriodClose } from './fiscalPeriodService';
import type { ChecklistItem } from './periodCloseReadinessService';
import { PeriodCloseBlockedError, PeriodNotCloseableError } from './periodCloseErrors';
import type { FiscalPeriod } from '../../types/gl.types';

export { PeriodCloseBlockedError, PeriodNotCloseableError };

export interface ClosePeriodOptions {
  /** Run every guard and report, but do not write. */
  dryRun?: boolean;
}

export interface ClosePeriodResult {
  period: FiscalPeriod;
  /** False on a dry run, and on nothing else — a refusal throws. */
  closed: boolean;
  dryRun: boolean;
  /** Every check that ran, passes included. */
  checklist: ChecklistItem[];
  /** Checks that did not pass but did not block. */
  warnings: ChecklistItem[];
}

export async function closePeriodWithReadiness(
  companyId: string,
  periodId: string,
  userId: string,
  options: ClosePeriodOptions,
): Promise<ClosePeriodResult> {
  const dryRun = options.dryRun === true;
  const { period, readiness } = dryRun
    ? await judgePeriodClose(companyId, periodId)
    : await closePeriodWithVerdict(companyId, periodId, userId);
  const warnings = readiness.items.filter((i) => i.status !== 'pass');
  if (!dryRun) {
    log.info('Fiscal period closed after readiness checks', { companyId, periodId, warnings: warnings.length }, 'accounting');
  }
  return { period, closed: !dryRun, dryRun, checklist: readiness.items, warnings };
}

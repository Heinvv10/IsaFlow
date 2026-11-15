/**
 * The period-close refusal: what blocks a close, and the error every close path
 * throws when something does.
 *
 * Kept free of runtime dependencies (one string constant, types otherwise) so
 * the API route and the screens can read a refusal without loading the checks.
 * The gate that raises these is `periodCloseGate.ts`.
 */

import type { ChecklistItem } from './periodCloseReadinessService';
import { UNCOMPUTED_REASON_PREFIX } from './closeReadinessChecks/uncomputedReason';

/** `error.details.code` on the 409 a refused close answers with. */
export const PERIOD_CLOSE_NOT_READY = 'PERIOD_CLOSE_NOT_READY';

/** One failing check, as the screen shows it: what, why, and where to fix it. */
export type CloseBlocker = Pick<ChecklistItem, 'key' | 'label' | 'reason' | 'fixHref'>;

export interface BlockedPeriod {
  periodId: string;
  periodName: string;
  blockers: CloseBlocker[];
}

/**
 * A `fail` blocks. A `warn` does not (no VAT return for the period, opening
 * balance equity not cleared), EXCEPT a warn that says the check did not run:
 * "the AP tie could not be checked" is exactly the state in which a close is
 * unsafe. Matched on the prefix, because `getCloseReadiness` substitutes a
 * fixed reason for a check that threw, while the AR / AP tie names its cause
 * after the same prefix.
 */
export function isCloseBlocker(item: ChecklistItem): boolean {
  return item.status === 'fail'
    || (item.status === 'warn' && item.reason.startsWith(UNCOMPUTED_REASON_PREFIX));
}

const toBlocker = ({ key, label, reason, fixHref }: ChecklistItem): CloseBlocker => ({ key, label, reason, fixHref });

/** The period is closeable in principle and the books are not ready. */
export class PeriodCloseBlockedError extends Error {
  readonly blockers: ChecklistItem[];
  readonly checklist: ChecklistItem[];
  readonly periodId: string;
  readonly periodName: string;

  constructor(periodLabel: string, blockers: ChecklistItem[], checklist: ChecklistItem[], periodId = '') {
    super(
      `${periodLabel} cannot be closed — ${blockers.length} check`
      + `${blockers.length === 1 ? '' : 's'} did not pass: `
      + blockers.map((b) => `${b.key}: ${b.reason}`).join('; '),
    );
    this.name = 'PeriodCloseBlockedError';
    this.blockers = blockers;
    this.checklist = checklist;
    this.periodId = periodId;
    this.periodName = periodLabel;
  }

  get periods(): BlockedPeriod[] {
    return [{ periodId: this.periodId, periodName: this.periodName, blockers: this.blockers.map(toBlocker) }];
  }
}

/** A year close refused as a whole: every period that would not pass, by name. */
export class YearCloseBlockedError extends Error {
  readonly fiscalYear: number;
  readonly periods: BlockedPeriod[];

  constructor(fiscalYear: number, periods: BlockedPeriod[]) {
    super(
      `Fiscal year ${fiscalYear} cannot be closed — ${periods.length} period`
      + `${periods.length === 1 ? '' : 's'} did not pass the close checks, so nothing was closed: `
      + periods.map((p) => `${p.periodName} (${p.blockers.map((b) => b.key).join(', ')})`).join('; '),
    );
    this.name = 'YearCloseBlockedError';
    this.fiscalYear = fiscalYear;
    this.periods = periods;
  }
}

/** Either readiness refusal: an answer for the caller, not a fault. */
export function isCloseRefusal(err: unknown): err is PeriodCloseBlockedError | YearCloseBlockedError {
  return err instanceof PeriodCloseBlockedError || err instanceof YearCloseBlockedError;
}

export interface CloseRefusalDetails {
  code: typeof PERIOD_CLOSE_NOT_READY;
  fiscalYear?: number;
  periods: BlockedPeriod[];
}

/** The `details` of the 409 for either refusal. */
export function closeRefusalDetails(err: PeriodCloseBlockedError | YearCloseBlockedError): CloseRefusalDetails {
  return {
    code: PERIOD_CLOSE_NOT_READY,
    ...(err instanceof YearCloseBlockedError ? { fiscalYear: err.fiscalYear } : {}),
    periods: err.periods,
  };
}

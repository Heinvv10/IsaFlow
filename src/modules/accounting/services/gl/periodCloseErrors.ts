/**
 * The period-close refusals: what blocks a close, and the errors the close,
 * lock and year-end paths throw.
 *
 * Runtime imports: only `uncomputedReason.ts` (one string constant) and the
 * dependency-free `periodCloseRefusalShape.ts`; the readiness service is a
 * type-only import. So the API routes can use these without loading the checks.
 * The screens import `periodCloseRefusalShape.ts` alone. The gate that raises
 * the readiness refusals is `periodCloseGate.ts`.
 */

import type { ChecklistItem } from './periodCloseReadinessService';
import { UNCOMPUTED_REASON_PREFIX } from './closeReadinessChecks/uncomputedReason';
import {
  PERIOD_CLOSE_NOT_READY, type BlockedPeriod, type CloseBlocker, type CloseRefusalDetails,
} from './periodCloseRefusalShape';

export { PERIOD_CLOSE_NOT_READY, type BlockedPeriod, type CloseBlocker, type CloseRefusalDetails };

/** What the refused write would have done to the period: the gate runs before a close and before a lock. */
export type GatedAction = 'closed' | 'locked';

/**
 * A `fail` blocks. A `warn` does not (no VAT return for the period, opening
 * balance equity not cleared), EXCEPT a warn that says the check did not run:
 * "the AP tie could not be checked" is exactly the state in which a close is
 * unsafe (Hein, 2026-11-15). Matched on the prefix, because `getCloseReadiness`
 * substitutes a fixed reason for a check that threw, while the AR / AP tie names
 * its cause after the same prefix.
 */
export function isCloseBlocker(item: ChecklistItem): boolean {
  return item.status === 'fail'
    || (item.status === 'warn' && item.reason.startsWith(UNCOMPUTED_REASON_PREFIX));
}

const toBlocker = ({ key, label, reason, fixHref }: ChecklistItem): CloseBlocker => ({ key, label, reason, fixHref });

/** The period cannot be closed (or locked) at all: missing, in the wrong status, or earlier periods are open. */
export class PeriodNotCloseableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PeriodNotCloseableError';
  }
}

/** The period is closeable in principle and the books are not ready. */
export class PeriodCloseBlockedError extends Error {
  readonly blockers: ChecklistItem[];
  readonly checklist: ChecklistItem[];
  readonly periodId: string;
  readonly periodName: string;

  constructor(
    periodLabel: string, blockers: ChecklistItem[], checklist: ChecklistItem[], periodId = '', action: GatedAction = 'closed',
  ) {
    super(
      `${periodLabel} cannot be ${action} — ${blockers.length} check`
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

/** A year close (or year-end lock) refused as a whole: every period that would not pass, by name. */
export class YearCloseBlockedError extends Error {
  readonly fiscalYear: number;
  readonly periods: BlockedPeriod[];

  constructor(fiscalYear: number, periods: BlockedPeriod[], action: GatedAction = 'closed') {
    super(
      `Fiscal year ${fiscalYear} cannot be ${action} — ${periods.length} period`
      + `${periods.length === 1 ? '' : 's'} did not pass the close checks, so nothing was ${action}: `
      + periods.map((p) => `${p.periodName} (${p.blockers.map((b) => b.key).join(', ')})`).join('; '),
    );
    this.name = 'YearCloseBlockedError';
    this.fiscalYear = fiscalYear;
    this.periods = periods;
  }
}

/** What a close / lock / reopen holds while it runs: the period rows, and the year row their status writes lock. */
export const PERIOD_LOCKS_HELD = 'a fiscal period or its financial year';

/**
 * A lock not acquired within its budget (55P03), or this flow was a deadlock
 * victim (40P01), anywhere inside a period flow (withPeriodLockBudget). The
 * message names what the flow could have been waiting for (`what`), because
 * the SQLSTATE does not say which lock it was. The `_LOCK_TIMEOUT` code makes
 * it a held row (`isLockTimeoutError`): the routes answer 503 + Retry-After and
 * roll the request back, and MCP shows the message.
 */
export class FiscalPeriodLockTimeoutError extends Error {
  readonly code = 'ROW_LOCK_TIMEOUT'; // the row-lock budget's code (core/rowLockBudget): 503 + Retry-After, caller-safe over MCP
  constructor(what: string = PERIOD_LOCKS_HELD) {
    super(`Another request is holding ${what}. Nothing was changed; retry in a moment.`);
    this.name = 'FiscalPeriodLockTimeoutError';
  }
}

/** Either readiness refusal: an answer for the caller, not a fault. */
export function isCloseRefusal(err: unknown): err is PeriodCloseBlockedError | YearCloseBlockedError {
  return err instanceof PeriodCloseBlockedError || err instanceof YearCloseBlockedError;
}

/** The `details` of the 409 for either readiness refusal. */
export function closeRefusalDetails(err: PeriodCloseBlockedError | YearCloseBlockedError): CloseRefusalDetails {
  return {
    code: PERIOD_CLOSE_NOT_READY,
    ...(err instanceof YearCloseBlockedError ? { fiscalYear: err.fiscalYear } : {}),
    periods: err.periods,
  };
}

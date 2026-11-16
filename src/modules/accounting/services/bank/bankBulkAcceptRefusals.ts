/**
 * What a refused bulk-accept line tells the caller (WP6): a typed refusal reads as its own sentence, a few are labelled by
 * what to do about them, a held line reads "busy", and only an untyped error is the generic "internal error" (logged by
 * the caller at error level, never echoed).
 *
 * THE LIST IS BUILT FROM WHAT `allocateTransaction` AND ITS CALLEES THROW (grep their `throw new X`), by `instanceof`, not
 * by name or by the MCP boundary's REFUSAL_CODES: a user-fixable refusal (a period closed, an account deactivated, a VAT
 * period locked, ...) must never read as a fault. `bankBulkAcceptRefusalCensus.test.ts` fails when a class thrown under the
 * allocation path is in neither list below. Plain `Error`s that mean "your data" (an inactive cost centre, an account of
 * another company) are checked before the call (`bankBulkAcceptService`) and arrive here as LineRefused.
 */
import { BankControlError } from './bankControlRefusal';
import { BankAllocationRefusal } from './bankAllocationRefusal';
import { BankTransactionNotPostedError } from './bankFeedStateGuard';
import { ReconciledCashError } from './reconciledCash';
import { ReconciliationCompletedError } from './reconciliationSessionLock';
import { BankTransactionLockTimeoutError } from './bankTxLock';
import { isLockContention } from '../core/lockContention';
import { RowLockTimeoutError } from '../core/rowLockBudget';
import { ClosedFiscalPeriodError, InactiveAccountError } from '../gl/journalEntryPostingGuards';
import { VatPeriodLockedError, VatLockTimeoutError } from '../gl/journalVatLockGuard';
import { DimensionRefusal } from '../gl/dimensions/dimensionTypes';
import { ApprovalRequiredError } from '../gl/approvalGate';

/** A line refused by the bulk accept's own checks (changed since the preview, no longer eligible, ...). */
export class LineRefused extends Error {}

export const GENERIC_REFUSAL = 'could not post (internal error)';

type Ctor = abstract new (...args: never[]) => Error;

/** Typed refusals whose message was written for the person, each raised before the line's first write. Subclasses are covered. */
export const PASS_THROUGH: readonly Ctor[] = [
  BankAllocationRefusal, BankTransactionNotPostedError, ReconciledCashError, ReconciliationCompletedError,
  ClosedFiscalPeriodError, InactiveAccountError, VatPeriodLockedError, DimensionRefusal,
];
/** Held rows: the line is busy, retry. */
export const BUSY: readonly Ctor[] = [BankTransactionLockTimeoutError, RowLockTimeoutError, VatLockTimeoutError];
/** The labelled ones (below). */
export const LABELLED: readonly Ctor[] = [BankControlError, ApprovalRequiredError];

/** Class names under the allocation path that are deliberately NOT passed through (faults, not refusals). */
export const NOT_REFUSALS: readonly string[] = ['LateClaimCompanionReversalError', 'BankDimensionSyncRefusal'];

const isA = (err: unknown, list: readonly Ctor[]): boolean => list.some((C) => err instanceof C);

/** Whether `refusalReason` reads this as a typed refusal (so the caller logs it below error level). */
export const isTypedRefusal = (err: unknown): boolean => err instanceof LineRefused || isA(err, BUSY) || isLockContention(err)
  || isA(err, PASS_THROUGH) || isA(err, LABELLED);

export function refusalReason(err: unknown): string {
  if (err instanceof LineRefused) return err.message;
  if (isLockContention(err) || isA(err, BUSY)) return 'busy - retry (another request holds this line)';
  if (!(err instanceof Error)) return GENERIC_REFUSAL;
  const code = (err as { code?: unknown }).code;
  if (code === 'IMPORTER_MAY_NOT_ALLOCATE') return `needs a colleague: ${err.message}`;
  if (isA(err, LABELLED)) return `approval_required: ${err.message}`;
  if (isA(err, PASS_THROUGH)) return err.message;
  return GENERIC_REFUSAL;
}

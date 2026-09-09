import type { LoanCreateInput, LoanEventInput } from './loanTypes';

export function validateCreate(input: LoanCreateInput): void {
  if (!input.principal || input.principal <= 0) throw new Error('principal must be positive');
  if (!input.termMonths || input.termMonths <= 0) throw new Error('termMonths must be positive');
  if (input.rateMode === 'FIXED' && (input.fixedRate == null || input.fixedRate <= 0)) {
    throw new Error('fixedRate is required for FIXED rate mode');
  }
  if (input.originationFee != null && input.originationFee < 0) {
    throw new Error('originationFee must not be negative');
  }
  assertSkipScheduleRepayable(input.skipMode, input.recurringSkipMonths);
}

/**
 * A loan that skips every calendar month with EXTEND_TERM never repays: each
 * skipped period pushes the term out by one, so the schedule ran to the year
 * 10000 (95,699 rows, ~7s of synchronous CPU) before anything stopped it.
 *
 * The bound must agree with `maxExtendedPeriods` in `src/lib/amortisation/engine.ts`.
 * With k of the twelve months skipped the extension converges to
 * `termMonths * k / (12 - k)`, so k = 11 costs 11x the term and only k = 12
 * fails to terminate. The engine caps at 12x, which accepts every k <= 11.
 * Rejecting more here than the engine refuses would block loans that compute
 * perfectly well; rejecting less would let a create succeed and every later
 * schedule recompute 500.
 */
export function assertSkipScheduleRepayable(
  skipMode: string | null | undefined,
  recurringSkipMonths: number[] | null | undefined,
): void {
  const months = new Set((recurringSkipMonths ?? []).filter((m) => m >= 1 && m <= 12));
  if (skipMode === 'EXTEND_TERM' && months.size >= 12) {
    throw new Error(
      'recurringSkipMonths cannot cover all twelve months when skipMode is EXTEND_TERM — the loan would never repay',
    );
  }
}

export function validateEventInput(input: LoanEventInput): void {
  if (input.kind === 'LUMP') {
    if (input.amount == null || input.amount <= 0) {
      throw new Error('amount must be positive for LUMP events');
    }
  }
}

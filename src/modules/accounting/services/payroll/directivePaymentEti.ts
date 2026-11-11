/**
 * A stand-alone directive payment and the ETI of its month (wave 5 ET; coordinator ruling H2 option a, Hein rulings
 * R-A and R-C). Wraps taxDirectivePaymentService.applyTaxDirective, which is unchanged:
 *  0. The company's payroll approval lock first (review round 2), so a directive, a run approval, a reopen and a
 *     recalculation of the company serialise: none reads the month's booked ETI while another is booking it.
 *  1. R-A: refused before any write when, in a period with ETI, a later month has a journal in force.
 *  2. The payment and its journal, as before.
 *  3. The month's ETI journal (directiveEtiJournal): what the month now uses less what is booked.
 * So a month's journals together book exactly the EMP201's ETI, and its 2140 nets to the EMP201 PAYE payable.
 */
import { postMonthEtiJournal, rebookLaterRunlessMonths } from './directiveEtiJournal';
import { assertNoLaterEtiJournal } from './etiPeriodGuard';
import { lockCompanyPayrollApprovals } from './payrollRunLock';
import {
  applyTaxDirective as applyTaxDirectivePayment, type ApplyDirectiveInput, type ApplyDirectiveResult,
} from './taxDirectivePaymentService';

export interface ApplyDirectiveWithEtiResult extends ApplyDirectiveResult {
  /** The month's ETI journal this payment posted, or null when there was nothing to book. */
  etiJournalEntryId: string | null;
}

export async function applyTaxDirective(
  companyId: string, directiveId: string, input: ApplyDirectiveInput, userId: string,
): Promise<ApplyDirectiveWithEtiResult> {
  const ym = { year: Number(input.paymentDate.slice(0, 4)), month: Number(input.paymentDate.slice(5, 7)) };
  await lockCompanyPayrollApprovals(null, companyId);
  await assertNoLaterEtiJournal(companyId, ym);
  const result = await applyTaxDirectivePayment(companyId, directiveId, input, userId);
  const etiJournalEntryId = await postMonthEtiJournal(companyId, ym, input.paymentDate, userId);
  await rebookLaterRunlessMonths(companyId, ym, userId); // round 3: the later run-less months of the period follow
  return { ...result, etiJournalEntryId };
}

/**
 * The plan for a journal that REPLACES a reversed one (payrollApprovalGate): its date, closed-period blocker and
 * the advisory that says why. Split out of the gate to keep it under the 300-line cap.
 */
import { closedPeriodBlocker } from './payrollJournalParts';
import type { JournalChain } from './payrollJournalChain';
import type { PayrollJournalPlan } from './payrollJournalBuilder';

/**
 * The plan for a journal that REPLACES a reversed one.
 *
 * ACCOUNTING RULING NEEDED (W3-01 round 5, C1-E) — implemented as recommended,
 * pending the owner's decision. When the reversal that took the old journal
 * out is not dated in the run's month (the month was closed, so the reversal
 * fell on a later date), the replacement is dated ON THAT REVERSAL'S DATE. The
 * reversal and the replacement then net in one period, and the run's own month
 * keeps the figures it reported. Dated in the run's month instead, that month
 * would carry the run twice and the later one a negative.
 * The alternative — re-date into the original month — needs that period
 * reopened and the reversal moved into it; it is not done here.
 */
export async function datedForReplacement(companyId: string, plan: PayrollJournalPlan, chain: JournalChain): Promise<PayrollJournalPlan> {
  const reversal = chain.journals[chain.journals.length - 1];
  if (!reversal || chain.journals.length < 2 || reversal.entryDate.slice(0, 7) === plan.entryDate.slice(0, 7)) return plan;
  const closed = await closedPeriodBlocker(companyId, reversal.entryDate);
  return {
    ...plan,
    entryDate: reversal.entryDate,
    blockers: [...plan.blockers.filter((b) => b.code !== 'closed_period'), ...(closed ? [closed] : [])],
    advisories: [...plan.advisories, {
      code: 'replacement_dated_on_reversal',
      detail: `The journal this run posted was reversed by ${reversal.entryNumber} on ${reversal.entryDate}, outside ${plan.entryDate.slice(0, 7)}. `
        + `The new journal is dated ${reversal.entryDate} as well, so the reversal and the new journal fall in the same period and `
        + `${plan.entryDate.slice(0, 7)} keeps the figures it reported.`,
    }],
  };
}

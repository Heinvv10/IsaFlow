/**
 * The month's ETI journal (wave 5 ET; coordinator ruling H2 option a, Hein ruling R-C): what brings the ETI the
 * ledger has booked for a month to what the month now uses. Posted after a stand-alone directive payment
 * (directivePaymentEti), after a directive payment's journal is reversed (review M3: the month then uses less, and the
 * negative difference is booked), and for the run-less months of the period (etiRebook). Reference `ETI-YYYY-MM`, source 'auto_payroll'.
 *  - ETI used (ETI Act s9(1); the month's PAYE includes its directives', guide §6.1 p. 42): the month's ETI used, its
 *    run counted only through its in-force journal (etiCarryRead.etiMonthLine), less what the run's journal and earlier
 *    ETI journals booked (etiBooking): DR 2140 / CR 5200 (reversed when negative).
 *  - In August and February, the period's unused ETI as the refund (s10(1)): DR ETI refund receivable / CR 5200.
 * The 2140 and 5200 accounts are the payroll journal's own (payrollJournalParts.resolveAccounts).
 * NAMED LIMITS: the ETI credit is untagged (no cost centre); a refund with no account holding the role is not booked
 * (the integrity check paye_payable_differs_from_emp201 reports the month).
 */
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostService';
import type { JournalLineInput } from '@/modules/accounting/types/gl.types';
import { bookedByEtiJournals, bookedByRunJournal, etiJournalReference } from './etiBooking';
import { etiMonthLine } from './etiCarryRead';
import { refundReceivable } from './payrollJournalEti';
import { resolveAccounts } from './payrollJournalParts';
import type { YearMonth } from './etiCarry';

const r2 = (n: number): number => Math.round(n * 100) / 100;

/** What the month's ETI journal must still book: ETI used and refund declared less what the run journal and ETI journals booked. */
export async function etiDueForMonth(companyId: string, ym: YearMonth): Promise<{ used: number; refund: number }> {
  const month = await etiMonthLine(companyId, ym);
  const byEti = await bookedByEtiJournals(companyId, ym);
  const byRun = await bookedByRunJournal(companyId, ym);
  return { used: r2(month.used - byEti.used - byRun.used), refund: r2(month.refundClaimable - byEti.refund - byRun.refund) };
}

/** The month's ETI journal as it would post: its lines and what they book (ETI used on 2140, refund on the receivable). */
export interface EtiMonthPlan { lines: JournalLineInput[]; used: number; refund: number }

/**
 * The plan that brings the month's booked ETI to what it uses; no lines when it already agrees. The ONE resolution of
 * the refund-receivable account and of 2140/5200 (and their error), shared by the post and the dry run (review round 5,
 * adv L1): a refund with no account holding the role is left out of both.
 */
export async function etiMonthPlan(companyId: string, ym: YearMonth): Promise<EtiMonthPlan> {
  const { used, refund: refundDue } = await etiDueForMonth(companyId, ym);
  const refundAccount = Math.abs(refundDue) < 0.005 ? null : await refundReceivable(companyId);
  const refund = refundAccount ? refundDue : 0;
  if (Math.abs(used) < 0.005 && Math.abs(refund) < 0.005) return { lines: [], used: 0, refund: 0 };
  const accounts = await resolveAccounts(companyId);
  const paye = accounts.get('2140')?.id;
  const labour = accounts.get('5200')?.id;
  if (!paye || !labour) throw new Error('GL accounts 2140 and 5200 are needed to book the month\'s ETI — ensure the chart of accounts is seeded');
  const pair = (debitAccount: string, amount: number, description: string): JournalLineInput[] => {
    const a = Math.abs(amount);
    const [dr, cr] = amount > 0 ? [debitAccount, labour] : [labour, debitAccount];
    return [{ glAccountId: dr, debit: a, credit: 0, description }, { glAccountId: cr, debit: 0, credit: a, description }];
  };
  const bookUsed = Math.abs(used) >= 0.005;
  const bookRefund = Math.abs(refund) >= 0.005 && !!refundAccount;
  return {
    lines: [
      ...(bookUsed ? pair(paye, used, 'ETI used against this month\'s PAYE (ETI Act s9(1))') : []),
      ...(bookRefund && refundAccount ? pair(refundAccount.id, refund, 'ETI refund claimable on the EMP501 (ETI Act s10(1))') : []),
    ],
    used: bookUsed ? used : 0,
    refund: bookRefund ? refund : 0,
  };
}

/** The lines that bring the month's booked ETI to what it uses; empty when it already agrees. */
export async function directiveEtiLines(companyId: string, ym: YearMonth): Promise<JournalLineInput[]> {
  return (await etiMonthPlan(companyId, ym)).lines;
}

/** Posts a planned ETI journal (reference ETI-YYYY-MM); its id, or null when the plan has no lines. */
export async function postEtiPlan(
  companyId: string, ym: YearMonth, plan: EtiMonthPlan, entryDate: string, userId: string, postingAgent?: string,
): Promise<string | null> {
  if (plan.lines.length === 0) return null;
  const entry = await createJournalEntry(companyId, {
    entryDate, description: `ETI for ${etiJournalReference(ym).slice(4)}: directive PAYE`,
    source: 'auto_payroll', reference: etiJournalReference(ym), lines: plan.lines,
  }, userId, postingAgent ? { postingAgent } : undefined);
  await postJournalEntry(companyId, entry.id, userId);
  return entry.id;
}

/** Posts the month's ETI journal when there is anything to book; its id, or null. `postingAgent` stamps a connector's posting. */
export async function postMonthEtiJournal(
  companyId: string, ym: YearMonth, entryDate: string, userId: string, postingAgent?: string,
): Promise<string | null> {
  return postEtiPlan(companyId, ym, await etiMonthPlan(companyId, ym), entryDate, userId, postingAgent);
}

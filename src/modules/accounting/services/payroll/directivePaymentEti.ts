/**
 * A stand-alone directive payment and the ETI of its month (wave 5 ET; coordinator ruling H2 option a, Hein rulings
 * R-A and R-C). Wraps taxDirectivePaymentService.applyTaxDirective, which is unchanged:
 *  1. R-A: refused before any write when a later month of the same ETI period has posted its run journal.
 *  2. The payment and its journal, as before.
 *  3. An ETI journal for the month, posted in the same request: the ETI the month now uses (ETI Act s9(1): its PAYE
 *     includes this directive's, guide §6.1 p. 42) less what the ledger already booked for it (the run's journal and
 *     earlier ETI journals, etiBooking), DR 2140 / CR 5200; in August and February also the period's unused ETI as the
 *     refund (s10(1)): DR ETI refund receivable / CR 5200. Reference `ETI-YYYY-MM`, source 'auto_payroll'. Nothing to
 *     book: no journal.
 * So a month's journals together book exactly the EMP201's ETI, and its 2140 nets to the EMP201 PAYE payable.
 * NAMED LIMITS: the ETI journal credits 5200 untagged (no cost centre); a refund with no account holding the role is
 * not booked (paye_payable_differs_from_emp201 / the run's blocker report it); reversing a directive payment does not
 * reverse its ETI journal (the integrity check reports the month).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { getSystemAccount } from '@/modules/accounting/services/gl/systemAccountResolver';
import { MissingSystemAccountError } from '@/modules/accounting/services/gl/systemAccountKeys';
import type { JournalLineInput } from '@/modules/accounting/types/gl.types';
import { bookedByEtiJournals, bookedByRunJournal, etiJournalReference } from './etiBooking';
import { etiMonthLine } from './etiCarryRead';
import { assertNoLaterEtiJournal } from './etiPeriodGuard';
import type { YearMonth } from './etiCarry';
import {
  applyTaxDirective as applyTaxDirectivePayment, type ApplyDirectiveInput, type ApplyDirectiveResult,
} from './taxDirectivePaymentService';

const r2 = (n: number): number => Math.round(n * 100) / 100;

export interface ApplyDirectiveWithEtiResult extends ApplyDirectiveResult {
  /** The month's ETI journal this payment posted, or null when there was nothing to book. */
  etiJournalEntryId: string | null;
}

async function accountByCode(companyId: string, code: string): Promise<string | null> {
  const rows = (await sql`SELECT id FROM gl_accounts WHERE company_id = ${companyId}::uuid AND account_code = ${code} AND is_active LIMIT 1`) as DbRow[];
  return rows[0] ? String(rows[0].id) : null;
}

/** The lines that bring the month's booked ETI to the EMP201's; empty when it already agrees. */
export async function directiveEtiLines(companyId: string, ym: YearMonth): Promise<JournalLineInput[]> {
  const month = await etiMonthLine(companyId, ym);
  const refundAccount = await getSystemAccount('eti_refund_receivable', companyId).catch((err: unknown) => {
    if (err instanceof MissingSystemAccountError) return null;
    throw err;
  });
  const byEti = await bookedByEtiJournals(companyId, ym, refundAccount?.id ?? null);
  const byRun = await bookedByRunJournal(companyId, ym, refundAccount?.id ?? null);
  const used = r2(month.used - byEti.used - byRun.used);
  const refund = refundAccount ? r2(month.refundClaimable - byEti.refund - byRun.refund) : 0;
  if (Math.abs(used) < 0.005 && Math.abs(refund) < 0.005) return [];
  const paye = await accountByCode(companyId, '2140');
  const labour = await accountByCode(companyId, '5200');
  if (!paye || !labour) throw new Error('GL accounts 2140 and 5200 are needed to book the month\'s ETI — ensure the chart of accounts is seeded');
  const pair = (debitAccount: string, amount: number, description: string): JournalLineInput[] => {
    const a = Math.abs(amount);
    const [dr, cr] = amount > 0 ? [debitAccount, labour] : [labour, debitAccount];
    return [{ glAccountId: dr, debit: a, credit: 0, description }, { glAccountId: cr, debit: 0, credit: a, description }];
  };
  return [
    ...(Math.abs(used) >= 0.005 ? pair(paye, used, 'ETI used against this month\'s PAYE (ETI Act s9(1))') : []),
    ...(Math.abs(refund) >= 0.005 && refundAccount ? pair(refundAccount.id, refund, 'ETI refund claimable on the EMP501 (ETI Act s10(1))') : []),
  ];
}

export async function applyTaxDirective(
  companyId: string, directiveId: string, input: ApplyDirectiveInput, userId: string,
): Promise<ApplyDirectiveWithEtiResult> {
  const ym = { year: Number(input.paymentDate.slice(0, 4)), month: Number(input.paymentDate.slice(5, 7)) };
  await assertNoLaterEtiJournal(companyId, ym);
  const result = await applyTaxDirectivePayment(companyId, directiveId, input, userId);
  const lines = await directiveEtiLines(companyId, ym);
  if (lines.length === 0) return { ...result, etiJournalEntryId: null };
  const entry = await createJournalEntry(companyId, {
    entryDate: input.paymentDate, description: `ETI for ${etiJournalReference(ym).slice(4)}: directive PAYE`,
    source: 'auto_payroll', reference: etiJournalReference(ym), lines,
  }, userId);
  await postJournalEntry(companyId, entry.id, userId);
  return { ...result, etiJournalEntryId: entry.id };
}

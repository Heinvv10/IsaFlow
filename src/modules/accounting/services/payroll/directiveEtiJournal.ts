/**
 * The month's ETI journal (wave 5 ET; coordinator ruling H2 option a, Hein ruling R-C): what brings the ETI the
 * ledger has booked for a month to what the month now uses. Posted after a stand-alone directive payment
 * (directivePaymentEti) and after a directive payment's journal is reversed (review M3: the month then uses less, and the
 * negative difference is booked). Reference `ETI-YYYY-MM`, source 'auto_payroll'.
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
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { payrollJournalInForce } from './payrollJournalChain';
import { reconciliationEnd } from './etiPeriodGuard';
import { index } from './etiCarry';
import type { YearMonth } from './etiCarry';

const r2 = (n: number): number => Math.round(n * 100) / 100;

/** The lines that bring the month's booked ETI to what it uses; empty when it already agrees. */
export async function directiveEtiLines(companyId: string, ym: YearMonth): Promise<JournalLineInput[]> {
  const month = await etiMonthLine(companyId, ym);
  const byEti = await bookedByEtiJournals(companyId, ym);
  const byRun = await bookedByRunJournal(companyId, ym);
  const used = r2(month.used - byEti.used - byRun.used);
  const refundDue = r2(month.refundClaimable - byEti.refund - byRun.refund);
  const refundAccount = Math.abs(refundDue) < 0.005 ? null : await refundReceivable(companyId);
  const refund = refundAccount ? refundDue : 0;
  if (Math.abs(used) < 0.005 && Math.abs(refund) < 0.005) return [];
  const accounts = await resolveAccounts(companyId);
  const paye = accounts.get('2140')?.id;
  const labour = accounts.get('5200')?.id;
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

/** Posts the month's ETI journal when there is anything to book; its id, or null. */
export async function postMonthEtiJournal(companyId: string, ym: YearMonth, entryDate: string, userId: string): Promise<string | null> {
  const lines = await directiveEtiLines(companyId, ym);
  if (lines.length === 0) return null;
  const entry = await createJournalEntry(companyId, {
    entryDate, description: `ETI for ${etiJournalReference(ym).slice(4)}: directive PAYE`,
    source: 'auto_payroll', reference: etiJournalReference(ym), lines,
  }, userId);
  await postJournalEntry(companyId, entry.id, userId);
  return entry.id;
}

const pad = (n: number): string => String(n).padStart(2, '0');
const lastOf = (ym: YearMonth): string => new Date(Date.UTC(ym.year, ym.month, 0)).toISOString().slice(0, 10);
const next = (ym: YearMonth): YearMonth => (ym.month === 12 ? { year: ym.year + 1, month: 1 } : { year: ym.year, month: ym.month + 1 });

/** Whether the month's run journal is in force: such a month books its own ETI (the run journal) and is not rebooked here. */
async function runJournalInForce(companyId: string, ym: YearMonth): Promise<boolean> {
  const rows = (await sql`
    SELECT journal_entry_id FROM payroll_run_headers
     WHERE company_id = ${companyId}::uuid AND period_year = ${ym.year} AND period_month = ${ym.month} AND journal_entry_id IS NOT NULL
  `) as DbRow[];
  for (const r of rows) if (await payrollJournalInForce(companyId, String(r.journal_entry_id))) return true;
  return false;
}

/**
 * Review round 3 (adv3 M2/M3): keep the months of `from`'s ETI period that have NO run journal in force booked as
 * the EMP201 declares them, from `from` to the end of the period (August or February). A change to an earlier month
 * (an approval, a reopen, a directive payment or its reversal) moves the carry those months use and, in August or
 * February, the refund (ETI Act s9(1), s10(1)): each such month's ETI journal takes the difference, dated the month's
 * last day. Idempotent: a month already booked as declared posts nothing. Only months that have ENDED by `today` (no
 * future-dated refund). Callers hold the company payroll approval lock (lock 1). Returns the journals posted.
 */
export async function rebookRunlessMonths(companyId: string, from: YearMonth, userId: string, today: Date = new Date()): Promise<string[]> {
  const todayIso = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const posted: string[] = [];
  const end = reconciliationEnd(from);
  for (let m = from; index(m) <= index(end) && lastOf(m) <= todayIso; m = next(m)) {
    if (await runJournalInForce(companyId, m)) continue;
    const id = await postMonthEtiJournal(companyId, m, lastOf(m), userId);
    if (id) posted.push(id);
  }
  return posted;
}

/** The run-less months AFTER `ym` in its ETI period, rebooked (rebookRunlessMonths): what an approval, reopen or directive calls. */
export const rebookLaterRunlessMonths = (companyId: string, ym: YearMonth, userId: string): Promise<string[]> =>
  rebookRunlessMonths(companyId, next(ym), userId);

/** The description applyTaxDirective gives its journal ("SARS directive <number> — <employee>"). */
const DIRECTIVE_JOURNAL = /^SARS directive /;

/**
 * Review M3: after a stand-alone directive payment's journal is reversed, its month uses less ETI; book the difference
 * (dated with the reversal, referenced to the directive's month), then rebook the later run-less months of the period.
 * Called by reverseJournalEntry, which already holds lock 1 (payrollJournalReversalGuard). A run journal or an ETI
 * journal reversed by hand is NOT rebooked here: a run's month is booked again when the run is approved again, and
 * rebooking an ETI journal someone just reversed would undo them.
 */
export async function bookEtiAfterDirectiveReversal(
  companyId: string, entry: { source?: string; description?: string | null; entryDate: unknown }, reversalDate: string, userId: string,
): Promise<string | null> {
  if (entry.source !== 'auto_payroll' || !DIRECTIVE_JOURNAL.test(entry.description ?? '')) return null;
  const d = entry.entryDate instanceof Date ? entry.entryDate.toISOString().slice(0, 10) : String(entry.entryDate).slice(0, 10);
  const ym = { year: Number(d.slice(0, 4)), month: Number(d.slice(5, 7)) };
  const id = await postMonthEtiJournal(companyId, ym, reversalDate, userId);
  await rebookRunlessMonths(companyId, next(ym), userId);
  return id;
}

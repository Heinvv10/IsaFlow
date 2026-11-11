/**
 * Keeping the RUN-LESS months of an ETI period booked as the EMP201 declares them (wave 5 ET; coordinator rulings,
 * review rounds 3 and 4). A month with no run journal in force (a directive-only month, or a month with no pay run at
 * all) has no journal of its own to carry its ETI used and, in August or February, its refund (ETI Act s9(1), s10(1)).
 * When an earlier month changes, what it uses moves; its ETI journal (directiveEtiJournal.postMonthEtiJournal) takes
 * the difference.
 *  - rebookEtiAfterEvent: on every trigger (a run approval, a reopen, a directive payment or a directive reversal),
 *    every run-less month of the trigger's half-year AND of the half-year before it that has ENDED by today (SAST), the
 *    trigger month and earlier months included. The half-year before is what books a run-less August's or February's
 *    refund once the next period starts. Idempotent: a month already booked as declared posts nothing.
 *  - bookEtiForMonth: one month, the same rebook: the explicit "Book ETI for this month" action (API and MCP).
 * Callers hold the company payroll approval lock (lock 1).
 * DATING (review round 4 M2): the month's last day while its fiscal period is open; otherwise the start of the first
 * open period after it, so an unrelated action never meets ClosedFiscalPeriodError. The reference ETI-YYYY-MM keeps the
 * month, which is what the integrity check reads. No open period after it: not booked, and the integrity check reports it.
 * NAMED LIMIT: a month that has not ended is never rebooked; the first trigger (or the action) after it ends books it.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { todayInSast } from '@/lib/saDateParser';
import { etiDueForMonth, postMonthEtiJournal } from './directiveEtiJournal';
import { payrollJournalInForce } from './payrollJournalChain';
import { periodHasEti, reconciliationEnd } from './etiPeriodGuard';
import { index, reconciliationStart } from './etiCarry';
import type { YearMonth } from './etiCarry';
import { lockCompanyPayrollApprovals } from './payrollRunLock';

const pad = (n: number): string => String(n).padStart(2, '0');
const lastOf = (ym: YearMonth): string => new Date(Date.UTC(ym.year, ym.month, 0)).toISOString().slice(0, 10);
const next = (ym: YearMonth): YearMonth => (ym.month === 12 ? { year: ym.year + 1, month: 1 } : { year: ym.year, month: ym.month + 1 });
const prev = (ym: YearMonth): YearMonth => (ym.month === 1 ? { year: ym.year - 1, month: 12 } : { year: ym.year, month: ym.month - 1 });

export type BookEtiStatus = 'booked' | 'nothing_to_book' | 'not_ended' | 'run_journal_in_force' | 'no_open_period';
export interface BookEtiOutcome { month: string; status: BookEtiStatus; journalEntryId: string | null; entryDate: string | null }
export interface BookEtiPreview { month: string; status: BookEtiStatus; entryDate: string | null; usedToBook: number; refundToBook: number }

/** Whether the month's run journal is in force: such a month books its own ETI (the run journal) and is not rebooked. */
async function runJournalInForce(companyId: string, ym: YearMonth): Promise<boolean> {
  const rows = (await sql`
    SELECT journal_entry_id FROM payroll_run_headers
     WHERE company_id = ${companyId}::uuid AND period_year = ${ym.year} AND period_month = ${ym.month} AND journal_entry_id IS NOT NULL
  `) as DbRow[];
  for (const r of rows) if (await payrollJournalInForce(companyId, String(r.journal_entry_id))) return true;
  return false;
}

/** The date a rebook of `ym` is posted on: its last day if that is in an open period (or none), else the first open date after it. */
export async function etiRebookDate(companyId: string, ym: YearMonth): Promise<string | null> {
  const last = lastOf(ym);
  const covering = (await sql`
    SELECT status FROM fiscal_periods
     WHERE company_id = ${companyId}::uuid AND start_date <= ${last}::date AND end_date >= ${last}::date
  `) as DbRow[];
  if (!covering.some((p) => String(p.status) !== 'open')) return last;
  const open = (await sql`
    SELECT to_char(start_date, 'YYYY-MM-DD') AS d FROM fiscal_periods
     WHERE company_id = ${companyId}::uuid AND status = 'open' AND start_date > ${last}::date
     ORDER BY start_date LIMIT 1
  `) as DbRow[];
  return open[0] ? String(open[0].d) : null;
}

/** One month brought to what the EMP201 declares, unless it has not ended or its run journal is in force. Caller holds lock 1. */
export async function bookEtiForMonth(
  companyId: string, ym: YearMonth, userId: string, today: string = todayInSast(), postingAgent?: string,
): Promise<BookEtiOutcome> {
  const month = `${ym.year}-${pad(ym.month)}`;
  const out = (status: BookEtiStatus, journalEntryId: string | null = null, entryDate: string | null = null): BookEtiOutcome =>
    ({ month, status, journalEntryId, entryDate });
  if (lastOf(ym) > today) return out('not_ended');
  if (await runJournalInForce(companyId, ym)) return out('run_journal_in_force');
  const entryDate = await etiRebookDate(companyId, ym);
  if (!entryDate) {
    log.warn('ETI rebook skipped: no open fiscal period on or after the month end', { companyId, month }, 'payroll');
    return out('no_open_period');
  }
  const id = await postMonthEtiJournal(companyId, ym, entryDate, userId, postingAgent);
  return id ? out('booked', id, entryDate) : out('nothing_to_book', null, entryDate);
}

/** The explicit action (EMP201 page, MCP): lock 1, then bookEtiForMonth. */
export async function bookEtiForMonthLocked(companyId: string, ym: YearMonth, userId: string, postingAgent?: string): Promise<BookEtiOutcome> {
  await lockCompanyPayrollApprovals(null, companyId);
  return bookEtiForMonth(companyId, ym, userId, todayInSast(), postingAgent);
}

/** What bookEtiForMonth would do, writing nothing (the connector's dry run): its status, date and ETI used/refund to book. */
export async function previewEtiForMonth(companyId: string, ym: YearMonth, today: string = todayInSast()): Promise<BookEtiPreview> {
  const month = `${ym.year}-${pad(ym.month)}`;
  const base = { month, entryDate: null, usedToBook: 0, refundToBook: 0 };
  if (lastOf(ym) > today) return { ...base, status: 'not_ended' };
  if (await runJournalInForce(companyId, ym)) return { ...base, status: 'run_journal_in_force' };
  const entryDate = await etiRebookDate(companyId, ym);
  if (!entryDate) return { ...base, status: 'no_open_period' };
  const due = await etiDueForMonth(companyId, ym);
  const any = Math.abs(due.used) >= 0.005 || Math.abs(due.refund) >= 0.005;
  return { month, status: any ? 'booked' : 'nothing_to_book', entryDate, usedToBook: due.used, refundToBook: due.refund };
}

/** Every trigger: the run-less months of `ym`'s half-year and the half-year before it that have ended. Returns the journals posted. */
export async function rebookEtiAfterEvent(companyId: string, ym: YearMonth, userId: string, today: string = todayInSast()): Promise<string[]> {
  const posted: string[] = [];
  const current = reconciliationStart(ym);
  for (const start of [reconciliationStart(prev(current)), current]) {
    if (!(await periodHasEti(companyId, start))) continue;
    const end = reconciliationEnd(start);
    for (let m = start; index(m) <= index(end) && lastOf(m) <= today; m = next(m)) {
      const r = await bookEtiForMonth(companyId, m, userId, today);
      if (r.journalEntryId) posted.push(r.journalEntryId);
    }
  }
  return posted;
}

/** The description applyTaxDirective gives its journal ("SARS directive <number> — <employee>"). */
const DIRECTIVE_JOURNAL = /^SARS directive /;

/**
 * Review M3: after a stand-alone directive payment's journal is reversed, its month uses less ETI; book the difference
 * (dated with the reversal, referenced to the directive's month), then the rebook every trigger runs.
 * Called by reverseJournalEntry, which already holds lock 1 (payrollJournalReversalGuard). A run journal or an ETI
 * journal reversed by hand is not rebooked by its own reversal; the next trigger, or the explicit action, books it.
 */
export async function bookEtiAfterDirectiveReversal(
  companyId: string, entry: { source?: string; description?: string | null; entryDate: unknown }, reversalDate: string, userId: string,
): Promise<string | null> {
  if (entry.source !== 'auto_payroll' || !DIRECTIVE_JOURNAL.test(entry.description ?? '')) return null;
  const d = entry.entryDate instanceof Date ? entry.entryDate.toISOString().slice(0, 10) : String(entry.entryDate).slice(0, 10);
  const ym = { year: Number(d.slice(0, 4)), month: Number(d.slice(5, 7)) };
  const id = await postMonthEtiJournal(companyId, ym, reversalDate, userId);
  await rebookEtiAfterEvent(companyId, ym, userId);
  return id;
}

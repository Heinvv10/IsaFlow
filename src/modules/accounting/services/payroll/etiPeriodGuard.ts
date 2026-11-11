/**
 * Hein ruling R-A (wave 5 ET; redesigned in review round 2): ETI carried forward (ETI Act s9(1)) makes a later month's
 * journal depend on the earlier months of its reconciliation period (March-August, September-February). So, ONLY in a
 * period that has ETI (a run header with ETI, or an ETI journal), a month cannot be approved, reopened, recalculated, or
 * have a directive paid or reversed while a LATER month of the period has a journal IN FORCE: its run journal or its
 * ETI journal (reference ETI-YYYY-MM). "In force" is payrollJournalInForce, the predicate etiBooking reads; a journal
 * reversed out of the ledger no longer blocks. The refusal names the month and the remedy that clears it.
 * Also (review L4) a month cannot be approved while an EARLIER month of an ETI period has a calculated, unapproved run.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { index, reconciliationStart, type YearMonth } from './etiCarry';
import { payrollJournalInForce } from './payrollJournalChain';
import { PayrollRunInputRefusedError } from './payrollRunInputRefused';

/** The last month (inclusive) of the reconciliation period holding `ym`: August or February. */
export function reconciliationEnd(ym: YearMonth): YearMonth {
  const start = reconciliationStart(ym);
  return start.month === 3 ? { year: start.year, month: 8 } : { year: start.year + 1, month: 2 };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const label = (ym: YearMonth): string => `${MONTHS[ym.month - 1]} ${ym.year}`;
const pad = (n: number): string => String(n).padStart(2, '0');
const ref = (ym: YearMonth): string => `ETI-${ym.year}-${pad(ym.month)}`;
const at = (n: number): YearMonth => ({ year: Math.floor(n / 12), month: (n % 12) + 1 });
const monthsBetween = (from: YearMonth, to: YearMonth): YearMonth[] =>
  Array.from({ length: Math.max(0, index(to) - index(from) + 1) }, (_, i) => at(index(from) + i));
const first = (ym: YearMonth): string => `${ym.year}-${pad(ym.month)}-01`;

/** True when the reconciliation period holding `ym` has ETI: a run header with ETI, or an ETI journal. */
export async function periodHasEti(companyId: string, ym: YearMonth): Promise<boolean> {
  const months = monthsBetween(reconciliationStart(ym), reconciliationEnd(ym));
  const rows = (await sql`
    SELECT EXISTS (
      SELECT 1 FROM payroll_run_headers h
       WHERE h.company_id = ${companyId}::UUID AND h.status <> 'cancelled' AND h.total_eti <> 0
         AND make_date(h.period_year, h.period_month, 1) BETWEEN ${first(months[0]!)}::date AND ${first(months[months.length - 1]!)}::date
    ) OR EXISTS (
      SELECT 1 FROM gl_journal_entries je
       WHERE je.company_id = ${companyId}::UUID AND je.source = 'auto_payroll' AND je.reference = ANY(${months.map(ref)}::text[])
    ) AS has_eti
  `) as DbRow[];
  return rows[0]?.has_eti === true;
}

/**
 * The latest LATER month of `ym`'s period whose RUN journal is in force, with the run's status; or null. A later month
 * with no run journal in force (directive and ETI journals only) does not block (review round 3): its ETI journal is
 * rebooked under lock 1 after the change (directiveEtiJournal.rebookRunlessMonths).
 */
export async function laterMonthInForce(companyId: string, ym: YearMonth): Promise<(YearMonth & { status: string }) | null> {
  const later = monthsBetween(at(index(ym) + 1), reconciliationEnd(ym));
  if (later.length === 0) return null;
  const rows = (await sql`
    SELECT h.period_year AS y, h.period_month AS m, h.journal_entry_id AS id, h.status
      FROM payroll_run_headers h
     WHERE h.company_id = ${companyId}::UUID AND h.journal_entry_id IS NOT NULL
       AND make_date(h.period_year, h.period_month, 1) BETWEEN ${first(later[0]!)}::date AND ${first(later[later.length - 1]!)}::date
     ORDER BY 1 DESC, 2 DESC
  `) as DbRow[];
  for (const r of rows) {
    if (await payrollJournalInForce(companyId, String(r.id))) return { year: Number(r.y), month: Number(r.m), status: String(r.status) };
  }
  return null;
}

/**
 * The refusal, or null: in a period with ETI, a later month of the period has its run journal in force.
 * FAIL-CLOSED, deliberately (review round 3, adv3 L4): any later in-force run journal refuses, even one whose ETI the
 * change would not move. The working remedy is in the message.
 */
export async function laterEtiJournalRefusal(companyId: string, ym: YearMonth): Promise<string | null> {
  if (!(await periodHasEti(companyId, ym))) return null;
  const later = await laterMonthInForce(companyId, ym);
  if (!later) return null;
  const head = `The ${label(later)} payroll journal is in the ledger, and it booked ETI carried forward from earlier months of the same ETI `
    + `period (ETI Act s9(1)), so ${label(ym)} cannot change now.`;
  // adv3 L5: a PAID run cannot be reopened, so "reopen" is no remedy for it.
  if (later.status === 'paid') {
    return `${head} The ${label(later)} pay run is paid and cannot be reopened: leave ${label(ym)} as it is and correct it in a later month `
      + `(a correcting run), or ask your accountant to adjust the ETI on the EMP201 and EMP501.`;
  }
  return `${head} To change it: reopen the ${label(later)} pay run and reverse its journal, latest month first; then change `
    + `${label(ym)} and approve the later months again.`;
}

/** Review L4: in a period with ETI, an EARLIER month with a calculated, unapproved run must be approved first. */
export async function earlierUnapprovedRefusal(companyId: string, ym: YearMonth): Promise<string | null> {
  const start = reconciliationStart(ym);
  if (index(start) === index(ym) || !(await periodHasEti(companyId, ym))) return null;
  const rows = (await sql`
    SELECT h.period_year, h.period_month FROM payroll_run_headers h
     WHERE h.company_id = ${companyId}::UUID AND h.status = 'calculated'
       AND make_date(h.period_year, h.period_month, 1) >= ${first(start)}::date
       AND make_date(h.period_year, h.period_month, 1) < ${first(ym)}::date
     ORDER BY h.period_year, h.period_month LIMIT 1
  `) as DbRow[];
  const earlier = rows[0];
  if (!earlier) return null;
  const month = label({ year: Number(earlier.period_year), month: Number(earlier.period_month) });
  return `The ${month} pay run is calculated but not approved. ETI carries forward month by month in an ETI period (ETI Act s9(1)), `
    + `so approve ${month} first, then approve ${label(ym)}.`;
}

/**
 * Thrown by a recalculation (and so by a run input write, which recalculates first) and by a directive payment: a 409
 * raised before any write. Reopen raises its own refusal with the same text; the approval gate returns it as a blocker.
 */
export class EtiLaterMonthPostedError extends PayrollRunInputRefusedError {
  constructor(message: string) {
    super(409, message);
    this.name = 'EtiLaterMonthPostedError';
  }
}

export async function assertNoLaterEtiJournal(companyId: string, ym: YearMonth): Promise<void> {
  const refusal = await laterEtiJournalRefusal(companyId, ym);
  if (refusal) throw new EtiLaterMonthPostedError(refusal);
}

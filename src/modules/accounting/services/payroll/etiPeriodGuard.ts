/**
 * Hein ruling R-A (wave 5 ET round 1): ETI carried forward (ETI Act s9(1)) makes a later month's journal depend on the
 * earlier months of its reconciliation period (March-August, September-February). Changing an earlier month after a
 * later one has posted its journal would leave that journal's ETI wrong, so approving, reopening or recalculating a run
 * is refused while a LATER month of the same period has a posted run journal. The posted month is named.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { reconciliationStart, type YearMonth } from './etiCarry';
import { PayrollRunInputRefusedError } from './payrollRunInputRefused';

/** The last month (inclusive) of the reconciliation period holding `ym`: August or February. */
export function reconciliationEnd(ym: YearMonth): YearMonth {
  const start = reconciliationStart(ym);
  return start.month === 3 ? { year: start.year, month: 8 } : { year: start.year + 1, month: 2 };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const label = (y: number, m: number): string => `${MONTHS[m - 1]} ${y}`;

/** The refusal, or null: a later month of the same ETI period whose run journal is posted. */
export async function laterEtiJournalRefusal(companyId: string, ym: YearMonth): Promise<string | null> {
  const end = reconciliationEnd(ym);
  const rows = (await sql`
    SELECT h.period_year, h.period_month
      FROM payroll_run_headers h
     WHERE h.company_id = ${companyId}::UUID
       AND h.journal_entry_id IS NOT NULL
       AND make_date(h.period_year, h.period_month, 1) > make_date(${ym.year}::int, ${ym.month}::int, 1)
       AND make_date(h.period_year, h.period_month, 1) <= make_date(${end.year}::int, ${end.month}::int, 1)
     ORDER BY h.period_year DESC, h.period_month DESC
     LIMIT 1
  `) as DbRow[];
  const later = rows[0];
  if (!later) return null;
  const posted = label(Number(later.period_year), Number(later.period_month));
  return `The ${posted} payroll journal is already posted, and it booked ETI carried forward from earlier months of the same ETI period `
    + `(ETI Act s9(1)). Changing ${label(ym.year, ym.month)} now would make that journal wrong. Reverse the ${posted} journal first `
    + '(and any later month\'s in the period), then change this month and post them again.';
}

/**
 * Thrown by a recalculation (and so by a run input write, which recalculates first): a 409 raised before any write.
 * Reopen raises its own refusal with the same text; the approval gate returns it as a blocker.
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

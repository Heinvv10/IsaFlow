/**
 * Prior-year actuals for the budget grid (P2 spec 4.2): per revenue/expense account, per month of
 * the budget year, optionally per dimension member.
 *
 * Each budget month takes the SAME CALENDAR MONTH one year earlier (2027-01 reads Jan 2026), never
 * the same position in the prior financial year: a 14-month transition year has fourteen months
 * and every one has a prior-year month. Posted entries only, natural sign (revenue Cr - Dr,
 * expense Dr - Cr), the year-end close journal left out. At company grain it agrees with
 * `reports/trendRowsService.getMonthlyMovements` (a parity test holds the two together).
 *
 * P3's `budgets/tracking/trackingActualRead.ts` is the one actuals SQL in the end (contract
 * ownership); when it lands, this delegates to it.
 */
import { sql } from '@/lib/neon';
import { requireFiscalYear } from '../gl/fiscalYearRegistry';
import { YEAR_END_JOURNAL_SOURCE } from '../gl/yearEndJournalSource';
import { toBudgetYearInfo } from '../core/budgetYears';
import { addMonthsToKey, monthKeyToDate } from '../reports/budgetPeriodWindow';
import { BudgetVersionError } from './budgetVersionTypes';
import { fromCents, toCents } from './grid/cents';

export type PriorGrain = 'company' | 'cc1' | 'cc2' | 'bu';

export const PRIOR_GRAINS: readonly PriorGrain[] = ['company', 'cc1', 'cc2', 'bu'];

export interface PriorActualCell {
  glAccountId: string;
  /** The CC1 / CC2 / BU member at a dimension grain (null: the journal line carries none); always null at company grain. */
  dimensionId: string | null;
  /** The BUDGET-year month the actual maps to ('YYYY-MM'). */
  month: string;
  amount: number;
}

export interface PriorActuals {
  fiscalYear: number;
  grain: PriorGrain;
  /** The budget year's months. */
  months: string[];
  /** `priorMonths[i]` is the calendar month one year before `months[i]`. */
  priorMonths: string[];
  cells: PriorActualCell[];
}

interface Row {
  gl_account_id: string; cc1_id: string | null; cc2_id: string | null; bu_id: string | null; month_key: string; amount: string;
}

/** Posted movement per account x month x journal-line dimensions; the grain is chosen after, from the same rows. */
async function readMovements(companyId: string, first: string, afterLast: string): Promise<Row[]> {
  return (await sql`
    SELECT jl.gl_account_id, jl.cc1_id, jl.cc2_id, jl.bu_id, to_char(je.entry_date, 'YYYY-MM') AS month_key,
           SUM(CASE WHEN ga.account_type = 'revenue' THEN jl.credit - jl.debit ELSE jl.debit - jl.credit END)::text AS amount
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
     WHERE jl.company_id = ${companyId}::UUID AND je.company_id = ${companyId}::UUID AND ga.company_id = ${companyId}::UUID
       AND je.status = 'posted' AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
       AND ga.account_type IN ('revenue', 'expense')
       AND je.entry_date >= ${first}::DATE AND je.entry_date < ${afterLast}::DATE
     GROUP BY jl.gl_account_id, jl.cc1_id, jl.cc2_id, jl.bu_id, to_char(je.entry_date, 'YYYY-MM')
  `) as unknown as Row[];
}

const dimOf = (r: Row, grain: PriorGrain): string | null => {
  const id = grain === 'cc1' ? r.cc1_id : grain === 'cc2' ? r.cc2_id : grain === 'bu' ? r.bu_id : null;
  return id ? String(id) : null;
};

/** Prior-year actuals for the registry year labelled `fiscalYear`; an unknown label is FiscalYearLabelUnknownError. */
export async function loadPriorActuals(companyId: string, fiscalYear: number, grain: PriorGrain): Promise<PriorActuals> {
  const year = toBudgetYearInfo(await requireFiscalYear(companyId, fiscalYear));
  const months = year.monthKeys;
  if (months.length === 0) throw new BudgetVersionError('BUDGET_VERSION_STATE', `Financial year ${fiscalYear} has no months`);
  const priorMonths = months.map((m) => addMonthsToKey(m, -12));
  // The prior months are contiguous, so one window holds them all.
  const first = monthKeyToDate(priorMonths[0]!);
  const afterLast = monthKeyToDate(addMonthsToKey(priorMonths[priorMonths.length - 1]!, 1));
  const budgetMonthOf = new Map(priorMonths.map((p, i) => [p, months[i]!]));

  // Sum in integer cents: a grain folds several dimension combinations into one cell.
  const sums = new Map<string, PriorActualCell>();
  for (const r of await readMovements(companyId, first, afterLast)) {
    const month = budgetMonthOf.get(String(r.month_key));
    if (month === undefined) continue;
    const glAccountId = String(r.gl_account_id), dimensionId = dimOf(r, grain);
    const key = `${glAccountId}|${dimensionId ?? ''}|${month}`;
    const seen = sums.get(key);
    const cents = toCents(Number(r.amount)) + (seen ? toCents(seen.amount) : 0);
    sums.set(key, { glAccountId, dimensionId, month, amount: fromCents(cents) });
  }
  const cells = [...sums.values()];
  cells.sort((a, b) => (a.glAccountId < b.glAccountId ? -1 : a.glAccountId > b.glAccountId ? 1 : a.month < b.month ? -1 : a.month > b.month ? 1 : (a.dimensionId ?? '') < (b.dimensionId ?? '') ? -1 : 1));
  return { fiscalYear, grain, months, priorMonths, cells };
}

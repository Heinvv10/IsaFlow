/**
 * THE ONE READ BEHIND THE FINANCIAL ANALYSIS SCREEN'S RATIOS.
 *
 * The screen shows a KPI scorecard, a ratio list and ratio trends, served by
 * three endpoints. Each built its own engine input: the ratio list read
 * interest, tax, employee cost and direct materials off the ledger, and the
 * other two did not — so the scorecard said interest cover could not be
 * stated a few centimetres above a list printing it as a figure. All three
 * call this.
 *
 * WHAT IT SUPPLIES IS WHAT THE ENGINE MAY CALL "RECORDED". A figure read here
 * and found nil is supplied as 0, which the engine reports as "none recorded
 * in the period" — true, because this looked. A figure this does NOT read
 * (dividends, cash flows, capital expenditure, direct materials) is left
 * undefined, which the engine reports as "not captured in this report". See
 * `ratioBasis.ts`.
 *
 * WHICH ACCOUNTS ARE INTEREST, TAX AND EMPLOYEE COST is the income
 * statement's classifier's answer, not this file's: see `ledgerRatioLines`.
 *
 * The report pack takes the same inputs from `readLedgerRatioInputs`, so a
 * ratio it prints is the one this screen prints.
 *
 * One query after another: under `withAuth` the request holds one pg client.
 */
import { sql } from '@/lib/neon';
import type { ClassificationRow } from '@/modules/accounting/services/gl/accountClassification';
import {
  getFinancialFigures, toFinancialData, type PeriodFigures,
} from '@/modules/accounting/services/gl/financialFiguresService';
import { ledgerRatioLines, type LedgerRatioLines } from './ledgerRatioLines';
import type { FinancialData } from './ratioTypes';

/** What only the head count and the classified income-statement lines supply. */
export type LedgerRatioInputs = LedgerRatioLines & { employeeCount: number };

/**
 * HEAD COUNT AS AT EACH DATE, IN ONE QUERY: the people employed on that day.
 *
 * It was `end_date IS NULL OR end_date > NOW()` — today's staff, whatever the
 * window, so a comparative period, every month of a trend and any historical
 * pack divided by the same number, and someone hired after the window was in
 * it. An employee counts on a date when they had started by it and either
 * left after it, or have no end date and are active now: a row that is
 * inactive or terminated with no end date says nothing about when, so it is
 * not counted on any date.
 *
 * As at the window END, not an average over it. A company that grew through
 * the window divides its whole period's revenue by its closing staff.
 */
export async function readHeadCounts(companyId: string, asAt: readonly string[]): Promise<number[]> {
  const rows = (await sql`
    SELECT d.as_at::text AS as_at, COUNT(e.id)::int AS count
    FROM unnest(${asAt as string[]}::date[]) AS d(as_at)
    LEFT JOIN payroll_employees e
      ON e.company_id = ${companyId}::uuid
     AND e.start_date <= d.as_at
     AND (e.end_date > d.as_at OR (e.end_date IS NULL AND e.status = 'active'))
    GROUP BY d.as_at
  `) as Array<{ as_at: string; count: number | string }>;
  const byDate = new Map(rows.map((r) => [String(r.as_at).slice(0, 10), Number(r.count)]));
  return asAt.map((date) => byDate.get(date) ?? 0);
}

/**
 * Head count at the window end and the period's interest, tax and employee
 * cost. On its own because the report pack has already read the ledger
 * figures and must not read them twice (`reportPackDataService`); the
 * Financial Analysis endpoints get both through `readExtendedRatioInputs`.
 *
 * The movement is read grouped exactly as `getFinancialFigures` reads it —
 * same joins, same predicates — and folded by the statement's classifier.
 * `headCount` is passed by a caller that has already read it for many windows
 * at once (ratio trends).
 */
export async function readLedgerRatioInputs(
  companyId: string, from: string, to: string, headCount?: number,
): Promise<LedgerRatioInputs> {
  const employeeCount = headCount ?? (await readHeadCounts(companyId, [to]))[0]!;
  const rows = (await sql`
    SELECT ga.account_type, ga.account_subtype,
           COALESCE(SUM(jl.debit), 0) AS debit, COALESCE(SUM(jl.credit), 0) AS credit
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = ${companyId}::UUID
    WHERE je.company_id = ${companyId}::UUID AND jl.company_id = ${companyId}::UUID
      AND je.status = 'posted' AND ga.account_type IN ('revenue', 'expense')
      AND je.entry_date >= ${from}::date AND je.entry_date <= ${to}::date
    GROUP BY ga.account_type, ga.account_subtype
  `) as ClassificationRow[];
  return { employeeCount, ...ledgerRatioLines(rows) };
}

export async function readExtendedRatioInputs(
  companyId: string,
  from: string,
  to: string,
  headCount?: number,
): Promise<{ data: FinancialData; figures: PeriodFigures }> {
  const figures = await getFinancialFigures(companyId, from, to);
  const ledger = await readLedgerRatioInputs(companyId, from, to, headCount);
  return { data: { ...toFinancialData(figures), inventoryClassified: figures.inventoryClassified, ...ledger }, figures };
}

/**
 * Budget Management Service — one budget per GL account per financial year.
 *
 * Amounts are stored per CALENDAR MONTH in `budget_month_amounts` (migration
 * 944): one row per company, account and first-of-month date. The year a month
 * counts in is whichever financial year holds it (gl/fiscalYearRegistry), so a
 * 14-month transition year simply has 14 month rows and a window of any length
 * sums the months inside it. `accounting_budgets` stays as the per-account,
 * per-year HEADER that carries the notes; its period_amounts / annual_amount /
 * total_amount are no longer read or written.
 *
 * A "year" here is the registry year for a label: a label no year carries (a
 * skipped label after a change of year end) is refused with a BudgetInputError.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getFiscalYear } from '../gl/fiscalYearRegistry';
import { budgetMonthBounds, budgetMonthKeysInWindow, monthKeyToDate } from '../reports/budgetPeriodWindow';
import { BudgetInputError, resolveMonthAmounts, round2, type BudgetMonthAmount } from './budgetMonths';

export { BudgetInputError, type BudgetMonthAmount } from './budgetMonths';

type Row = DbRow;

export interface BudgetEntry {
  /** The year's header row, or null when only month amounts exist for this account and year. */
  id: string | null;
  glAccountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  /** The financial-year label. */
  fiscalYear: number;
  /** The sum of `months`. */
  annualAmount: number;
  /** Every month of the year, in order; a month with nothing stored is 0. */
  months: BudgetMonthAmount[];
  notes?: string;
  createdAt?: string;
}

export interface BudgetInput {
  glAccountId: string;
  /** The financial-year label. */
  fiscalYear: number;
  /** Spread evenly (cents on the last month) when `months` is absent. */
  annualAmount?: number;
  /** Exactly the year's months. */
  months?: BudgetMonthAmount[];
  notes?: string;
}

interface YearMonths { fiscalYear: number; monthKeys: string[]; first: string; last: string }

async function yearMonths(companyId: string, fiscalYear: number): Promise<YearMonths> {
  const year = await getFiscalYear(companyId, fiscalYear);
  if (!year) throw new BudgetInputError(`No financial year is labelled ${fiscalYear}`);
  const monthKeys = budgetMonthKeysInWindow(year.startDate, year.endDate);
  const bounds = budgetMonthBounds(year.startDate, year.endDate);
  if (!bounds) throw new BudgetInputError(`Financial year ${fiscalYear} has no months`);
  return { fiscalYear, monthKeys, ...bounds };
}

/** Every account with a header or any month in the year, with its months. `accountId` narrows to one. */
async function loadEntries(companyId: string, year: YearMonths, accountId: string | null): Promise<BudgetEntry[]> {
  const accounts = (await sql`
    SELECT ga.id AS gl_account_id, ga.account_code, ga.account_name, ga.account_type,
           h.id AS header_id, h.notes, h.created_at
    FROM gl_accounts ga
    LEFT JOIN accounting_budgets h
      ON h.gl_account_id = ga.id AND h.company_id = ${companyId}::UUID AND h.fiscal_year = ${year.fiscalYear}
    WHERE ga.company_id = ${companyId}::UUID
      AND (${accountId}::UUID IS NULL OR ga.id = ${accountId}::UUID)
      AND (h.id IS NOT NULL OR EXISTS (
        SELECT 1 FROM budget_month_amounts bm
        WHERE bm.company_id = ${companyId}::UUID AND bm.gl_account_id = ga.id
          AND bm.month >= ${year.first}::DATE AND bm.month <= ${year.last}::DATE))
    ORDER BY ga.account_code
  `) as Row[];
  const stored = (await sql`
    SELECT bm.gl_account_id, TO_CHAR(bm.month, 'YYYY-MM') AS month_key, bm.amount::text AS amount
    FROM budget_month_amounts bm
    WHERE bm.company_id = ${companyId}::UUID
      AND (${accountId}::UUID IS NULL OR bm.gl_account_id = ${accountId}::UUID)
      AND bm.month >= ${year.first}::DATE AND bm.month <= ${year.last}::DATE
  `) as Row[];

  const byAccount = new Map<string, Map<string, number>>();
  for (const r of stored) {
    const id = String(r.gl_account_id);
    if (!byAccount.has(id)) byAccount.set(id, new Map());
    byAccount.get(id)!.set(String(r.month_key), Number(r.amount));
  }
  return accounts.map((a) => {
    const have = byAccount.get(String(a.gl_account_id));
    const months = year.monthKeys.map((month) => ({ month, amount: have?.get(month) ?? 0 }));
    return {
      id: a.header_id ? String(a.header_id) : null,
      glAccountId: String(a.gl_account_id),
      accountCode: String(a.account_code ?? ''),
      accountName: String(a.account_name ?? ''),
      accountType: String(a.account_type ?? ''),
      fiscalYear: year.fiscalYear,
      annualAmount: round2(months.reduce((s, m) => s + m.amount, 0)),
      months,
      notes: a.notes ? String(a.notes) : undefined,
      createdAt: a.created_at ? String(a.created_at) : undefined,
    };
  });
}

export async function getBudgets(companyId: string, fiscalYear: number): Promise<BudgetEntry[]> {
  return loadEntries(companyId, await yearMonths(companyId, fiscalYear), null);
}

export async function upsertBudget(
  companyId: string,
  input: BudgetInput,
  userId: string,
): Promise<BudgetEntry> {
  const year = await yearMonths(companyId, input.fiscalYear);
  const amounts = resolveMonthAmounts(year.monthKeys, { months: input.months, annualAmount: input.annualAmount });

  const owned = (await sql`
    SELECT 1 FROM gl_accounts WHERE id = ${input.glAccountId}::UUID AND company_id = ${companyId}::UUID
  `) as Row[];
  if (owned.length === 0) throw new BudgetInputError('Budget account does not belong to this company');

  // The arbiter index is partial (WHERE gl_account_id IS NOT NULL), so the
  // predicate has to be repeated here or Postgres cannot pick it.
  await sql`
    INSERT INTO accounting_budgets (company_id, budget_name, fiscal_year, gl_account_id, notes, created_by)
    VALUES (${companyId}::UUID, ${budgetName(input.fiscalYear)}, ${input.fiscalYear},
            ${input.glAccountId}::UUID, ${input.notes ?? null}, ${userId})
    ON CONFLICT (company_id, gl_account_id, fiscal_year) WHERE gl_account_id IS NOT NULL
    DO UPDATE SET notes = EXCLUDED.notes, updated_at = now()
  `;
  await sql`
    INSERT INTO budget_month_amounts (company_id, gl_account_id, month, amount, created_by)
    SELECT ${companyId}::UUID, ${input.glAccountId}::UUID, t.month::DATE, t.amount, ${userId}
    FROM unnest(${amounts.map(a => monthKeyToDate(a.month))}::TEXT[], ${amounts.map(a => a.amount)}::NUMERIC[])
      AS t(month, amount)
    ON CONFLICT (company_id, gl_account_id, month)
    DO UPDATE SET amount = EXCLUDED.amount, updated_at = now()
  `;

  const [entry] = await loadEntries(companyId, year, input.glAccountId);
  if (!entry) throw new BudgetInputError('Budget account does not belong to this company');
  log.info('Upserted budget', {
    glAccountId: input.glAccountId, fiscalYear: input.fiscalYear, annualAmount: entry.annualAmount,
  }, 'accounting');
  return entry;
}

/** Removes the account's header and every month of the year. Months of other years are untouched. */
export async function deleteBudget(companyId: string, glAccountId: string, fiscalYear: number): Promise<void> {
  const year = await yearMonths(companyId, fiscalYear);
  await sql`
    DELETE FROM budget_month_amounts
    WHERE company_id = ${companyId}::UUID AND gl_account_id = ${glAccountId}::UUID
      AND month >= ${year.first}::DATE AND month <= ${year.last}::DATE
  `;
  await sql`
    DELETE FROM accounting_budgets
    WHERE company_id = ${companyId}::UUID AND gl_account_id = ${glAccountId}::UUID AND fiscal_year = ${fiscalYear}
  `;
}

/**
 * Copies a year's budgets forward BY MONTH POSITION: month i of `fromYear`
 * (counted from its first month) becomes month i of `toYear`. Months beyond the
 * shorter year are dropped (a 14-month year copied to 12 loses its last two) and
 * months of a longer target stay as they were. A month the target already holds
 * is left alone, so a re-run adds nothing. Returns how many accounts gained months.
 */
export async function copyBudgets(
  companyId: string,
  fromYear: number,
  toYear: number,
  userId: string,
): Promise<number> {
  if (fromYear === toYear) throw new BudgetInputError('Cannot copy a year onto itself');
  const from = await yearMonths(companyId, fromYear);
  const to = await yearMonths(companyId, toYear);

  const copied = (await sql`
    WITH moved AS (
      SELECT bm.gl_account_id, bm.amount,
             ${to.first}::DATE + make_interval(months =>
               (EXTRACT(YEAR FROM bm.month)::INT * 12 + EXTRACT(MONTH FROM bm.month)::INT)
               - (EXTRACT(YEAR FROM ${from.first}::DATE)::INT * 12 + EXTRACT(MONTH FROM ${from.first}::DATE)::INT)
             ) AS target
      FROM budget_month_amounts bm
      JOIN gl_accounts ga ON ga.id = bm.gl_account_id AND ga.company_id = ${companyId}::UUID
      WHERE bm.company_id = ${companyId}::UUID
        AND bm.month >= ${from.first}::DATE AND bm.month <= ${from.last}::DATE
    ), ins AS (
      INSERT INTO budget_month_amounts (company_id, gl_account_id, month, amount, created_by)
      SELECT ${companyId}::UUID, gl_account_id, target::DATE, amount, ${userId}
      FROM moved WHERE target <= ${to.last}::DATE
      ON CONFLICT (company_id, gl_account_id, month) DO NOTHING
      RETURNING gl_account_id
    )
    SELECT COUNT(DISTINCT gl_account_id)::INT AS copied FROM ins
  `) as Row[];

  // Notes travel with the budget, for accounts that now have months in the target year.
  await sql`
    INSERT INTO accounting_budgets (company_id, budget_name, fiscal_year, gl_account_id, notes, created_by)
    SELECT h.company_id, ${budgetName(toYear)}, ${toYear}, h.gl_account_id, h.notes, ${userId}
    FROM accounting_budgets h
    WHERE h.company_id = ${companyId}::UUID AND h.fiscal_year = ${fromYear} AND h.gl_account_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM budget_month_amounts bm
        WHERE bm.company_id = ${companyId}::UUID AND bm.gl_account_id = h.gl_account_id
          AND bm.month >= ${to.first}::DATE AND bm.month <= ${to.last}::DATE)
    ON CONFLICT (company_id, gl_account_id, fiscal_year) WHERE gl_account_id IS NOT NULL
    DO NOTHING
  `;

  const count = Number(copied[0]?.copied ?? 0);
  log.info('Copied budgets', { fromYear, toYear, count }, 'accounting');
  return count;
}

function budgetName(fiscalYear: number): string {
  return `FY${fiscalYear} Budget`;
}

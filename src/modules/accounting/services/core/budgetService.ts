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
 *
 * VERSIONS (migration 947): every amount belongs to a budget version. Reads use
 * the year's PRIMARY version unless a `versionId` of that year is named; a year
 * with no primary reads as no months.
 *
 * READ-ONLY since budgets P2 PR-D: the budget workspace writes through
 * budgets/gridSave, budgets/seedVersion and the version routes; the legacy
 * writers (upsertBudget, deleteBudget, copyBudgets) were removed with the old
 * page's routes.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { getFiscalYear, type FiscalYearRecord } from '../gl/fiscalYearRegistry';
import { readVersion } from '../budgets/budgetVersionScope';
import { budgetMonthBounds, budgetMonthKeysInWindow } from '../reports/budgetPeriodWindow';
import { BudgetInputError, round2, type BudgetMonthAmount } from './budgetMonths';

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

interface YearMonths { fiscalYear: number; monthKeys: string[]; first: string; last: string }

function monthsOf(year: FiscalYearRecord): YearMonths {
  const fiscalYear = year.fiscalYear;
  const monthKeys = budgetMonthKeysInWindow(year.startDate, year.endDate);
  const bounds = budgetMonthBounds(year.startDate, year.endDate);
  if (!bounds) throw new BudgetInputError(`Financial year ${fiscalYear} has no months`);
  return { fiscalYear, monthKeys, ...bounds };
}

async function yearMonths(companyId: string, fiscalYear: number): Promise<YearMonths> {
  const year = await getFiscalYear(companyId, fiscalYear);
  if (!year) throw new BudgetInputError(`No financial year is labelled ${fiscalYear}`);
  return monthsOf(year);
}

/** Every account with a header or any month in the year, with its months. */
async function loadEntries(companyId: string, year: YearMonths, versionId: string | null): Promise<BudgetEntry[]> {
  const accounts = (await sql`
    SELECT ga.id AS gl_account_id, ga.account_code, ga.account_name, ga.account_type,
           h.id AS header_id, h.notes, h.created_at
    FROM gl_accounts ga
    LEFT JOIN accounting_budgets h
      ON h.gl_account_id = ga.id AND h.company_id = ${companyId}::UUID AND h.fiscal_year = ${year.fiscalYear}
    WHERE ga.company_id = ${companyId}::UUID
      AND (h.id IS NOT NULL OR EXISTS (
        SELECT 1 FROM budget_month_amounts bm
        WHERE bm.company_id = ${companyId}::UUID AND bm.gl_account_id = ga.id AND bm.version_id = ${versionId}::UUID
          AND bm.month >= ${year.first}::DATE AND bm.month <= ${year.last}::DATE))
    ORDER BY ga.account_code
  `) as Row[];
  const stored = (await sql`
    SELECT bm.gl_account_id, TO_CHAR(bm.month, 'YYYY-MM') AS month_key, SUM(bm.amount)::text AS amount
    FROM budget_month_amounts bm
    WHERE bm.company_id = ${companyId}::UUID AND bm.version_id = ${versionId}::UUID
      AND bm.month >= ${year.first}::DATE AND bm.month <= ${year.last}::DATE
    GROUP BY bm.gl_account_id, bm.month
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

export async function getBudgets(companyId: string, fiscalYear: number, versionId?: string): Promise<BudgetEntry[]> {
  const year = await yearMonths(companyId, fiscalYear);
  return loadEntries(companyId, year, await readVersion(companyId, fiscalYear, versionId));
}

/** `getBudgets` for a year the caller has already looked up (no second registry read). */
export async function getBudgetsForYear(companyId: string, year: FiscalYearRecord, versionId?: string): Promise<BudgetEntry[]> {
  return loadEntries(companyId, monthsOf(year), await readVersion(companyId, year.fiscalYear, versionId));
}

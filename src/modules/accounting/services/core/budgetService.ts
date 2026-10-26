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
 * with no primary reads as no months. Writes go to the named version or the
 * primary, creating a draft primary 'Original' for a year that has none. Each
 * write locks the version first (budgets/budgetVersionScope), so a locked
 * version is a typed 409 before anything is written, and leaves one audit row
 * (entity 'budget', the version id). The page writes company-level amounts only:
 * an account budgeted by dimension in the version is a typed grain refusal.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getFiscalYear, type FiscalYearRecord } from '../gl/fiscalYearRegistry';
import {
  auditBudgetWrite as auditWrite, holdYearRegistry, lockVersionForWrite, readVersion, resolvePrimaryVersion, writeVersion,
} from '../budgets/budgetVersionScope';
import { BudgetVersionError } from '../budgets/budgetVersionTypes';
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
  /** The version to write; default the year's primary (created as a draft 'Original' when missing). */
  versionId?: string;
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

/** Every account with a header or any month in the year, with its months. `accountId` narrows to one. */
async function loadEntries(
  companyId: string, year: YearMonths, accountId: string | null, versionId: string | null,
): Promise<BudgetEntry[]> {
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
        WHERE bm.company_id = ${companyId}::UUID AND bm.gl_account_id = ga.id AND bm.version_id = ${versionId}::UUID
          AND bm.month >= ${year.first}::DATE AND bm.month <= ${year.last}::DATE))
    ORDER BY ga.account_code
  `) as Row[];
  const stored = (await sql`
    SELECT bm.gl_account_id, TO_CHAR(bm.month, 'YYYY-MM') AS month_key, SUM(bm.amount)::text AS amount
    FROM budget_month_amounts bm
    WHERE bm.company_id = ${companyId}::UUID AND bm.version_id = ${versionId}::UUID
      AND (${accountId}::UUID IS NULL OR bm.gl_account_id = ${accountId}::UUID)
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
  return loadEntries(companyId, year, null, await readVersion(companyId, fiscalYear, versionId));
}

/** `getBudgets` for a year the caller has already looked up (no second registry read). */
export async function getBudgetsForYear(companyId: string, year: FiscalYearRecord, versionId?: string): Promise<BudgetEntry[]> {
  return loadEntries(companyId, monthsOf(year), null, await readVersion(companyId, year.fiscalYear, versionId));
}

export async function upsertBudget(
  companyId: string,
  input: BudgetInput,
  userId: string,
): Promise<BudgetEntry> {
  await holdYearRegistry(companyId);
  const year = await yearMonths(companyId, input.fiscalYear);
  const amounts = resolveMonthAmounts(year.monthKeys, { months: input.months, annualAmount: input.annualAmount });

  const owned = (await sql`
    SELECT account_code FROM gl_accounts WHERE id = ${input.glAccountId}::UUID AND company_id = ${companyId}::UUID
  `) as Row[];
  if (owned.length === 0) throw new BudgetInputError('Budget account does not belong to this company');
  const { id: versionId, isPrimary } = await writeVersion(companyId, input.fiscalYear, input.versionId, userId);
  // The version row is locked, so no other writer of it runs between this check and the write.
  const otherGrain = (await sql`
    SELECT 1 FROM budget_month_amounts
     WHERE company_id = ${companyId}::UUID AND version_id = ${versionId}::UUID
       AND gl_account_id = ${input.glAccountId}::UUID AND dim_grain <> 0
     LIMIT 1
  `) as Row[];
  if (otherGrain.length > 0) {
    throw new BudgetVersionError('BUDGET_GRAIN_CONFLICT',
      `Account ${String(owned[0]!.account_code)} is budgeted by dimension in this version; it cannot also have a company-level budget`);
  }

  // The notes header is per account and year, shared by every version: only a write of the
  // PRIMARY version (the budget every report shows) sets it. The arbiter index is partial
  // (WHERE gl_account_id IS NOT NULL), so the predicate has to be repeated here.
  if (isPrimary) await sql`
    INSERT INTO accounting_budgets (company_id, budget_name, fiscal_year, gl_account_id, notes, created_by)
    VALUES (${companyId}::UUID, ${budgetName(input.fiscalYear)}, ${input.fiscalYear},
            ${input.glAccountId}::UUID, ${input.notes ?? null}, ${userId})
    ON CONFLICT (company_id, gl_account_id, fiscal_year) WHERE gl_account_id IS NOT NULL
    DO UPDATE SET notes = EXCLUDED.notes, updated_at = now()
  `;
  await sql`
    INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount, created_by)
    SELECT ${companyId}::UUID, ${versionId}::UUID, ${input.glAccountId}::UUID, t.month::DATE, t.amount, ${userId}
    FROM unnest(${amounts.map(a => monthKeyToDate(a.month))}::TEXT[], ${amounts.map(a => a.amount)}::NUMERIC[])
      AS t(month, amount)
    ON CONFLICT ON CONSTRAINT budget_month_amounts_one_per_cell
    DO UPDATE SET amount = EXCLUDED.amount, updated_at = now()
  `;

  const [entry] = await loadEntries(companyId, year, input.glAccountId, versionId);
  if (!entry) throw new BudgetInputError('Budget account does not belong to this company');
  await auditWrite(companyId, userId, 'update', versionId, input.fiscalYear, {
    glAccountId: input.glAccountId, months: String(amounts.length), total: String(entry.annualAmount),
  });
  log.info('Upserted budget', {
    glAccountId: input.glAccountId, fiscalYear: input.fiscalYear, annualAmount: entry.annualAmount,
  }, 'accounting');
  return entry;
}

/**
 * Removes the account's company-level months of the year in the PRIMARY version, and the year's
 * notes header once no version of the year still has months for the account (the header is shared
 * by every version). Other versions, dimension rows and months of other years are untouched.
 */
export async function deleteBudget(companyId: string, glAccountId: string, fiscalYear: number, userId: string): Promise<void> {
  await holdYearRegistry(companyId);
  const year = await yearMonths(companyId, fiscalYear);
  const primary = await resolvePrimaryVersion(companyId, fiscalYear);
  if (primary) {
    await lockVersionForWrite(companyId, primary);
    await sql`
      DELETE FROM budget_month_amounts
      WHERE company_id = ${companyId}::UUID AND version_id = ${primary}::UUID AND gl_account_id = ${glAccountId}::UUID
        AND dim_grain = 0 AND month >= ${year.first}::DATE AND month <= ${year.last}::DATE
    `;
    await auditWrite(companyId, userId, 'delete', primary, fiscalYear, { glAccountId });
  }
  await sql`
    DELETE FROM accounting_budgets h
    WHERE h.company_id = ${companyId}::UUID AND h.gl_account_id = ${glAccountId}::UUID AND h.fiscal_year = ${fiscalYear}
      AND NOT EXISTS (
        SELECT 1 FROM budget_month_amounts bm JOIN budget_versions v ON v.id = bm.version_id AND v.company_id = bm.company_id
        WHERE bm.company_id = ${companyId}::UUID AND bm.gl_account_id = ${glAccountId}::UUID AND v.fiscal_year = ${fiscalYear})
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
  await holdYearRegistry(companyId);
  const from = await yearMonths(companyId, fromYear);
  const to = await yearMonths(companyId, toYear);
  const source = await resolvePrimaryVersion(companyId, fromYear);
  if (!source) return 0;
  const { id: target } = await writeVersion(companyId, toYear, undefined, userId);

  // Dimensions travel with the amounts. An account the target already budgets at another grain is skipped.
  const copied = (await sql`
    WITH moved AS (
      SELECT bm.gl_account_id, bm.amount, bm.cc1_id, bm.cc2_id, bm.bu_id, bm.dim_grain,
             ${to.first}::DATE + make_interval(months =>
               (EXTRACT(YEAR FROM bm.month)::INT * 12 + EXTRACT(MONTH FROM bm.month)::INT)
               - (EXTRACT(YEAR FROM ${from.first}::DATE)::INT * 12 + EXTRACT(MONTH FROM ${from.first}::DATE)::INT)
             ) AS target
      FROM budget_month_amounts bm
      JOIN gl_accounts ga ON ga.id = bm.gl_account_id AND ga.company_id = ${companyId}::UUID
      WHERE bm.company_id = ${companyId}::UUID AND bm.version_id = ${source}::UUID
        AND bm.month >= ${from.first}::DATE AND bm.month <= ${from.last}::DATE
    ), ins AS (
      INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount, cc1_id, cc2_id, bu_id, created_by)
      SELECT ${companyId}::UUID, ${target}::UUID, m.gl_account_id, m.target::DATE, m.amount, m.cc1_id, m.cc2_id, m.bu_id, ${userId}
      FROM moved m WHERE m.target <= ${to.last}::DATE
        AND NOT EXISTS (SELECT 1 FROM budget_month_amounts t
                         WHERE t.company_id = ${companyId}::UUID AND t.version_id = ${target}::UUID
                           AND t.gl_account_id = m.gl_account_id AND t.dim_grain <> m.dim_grain)
      ON CONFLICT ON CONSTRAINT budget_month_amounts_one_per_cell DO NOTHING
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
        WHERE bm.company_id = ${companyId}::UUID AND bm.version_id = ${target}::UUID AND bm.gl_account_id = h.gl_account_id
          AND bm.month >= ${to.first}::DATE AND bm.month <= ${to.last}::DATE)
    ON CONFLICT (company_id, gl_account_id, fiscal_year) WHERE gl_account_id IS NOT NULL
    DO NOTHING
  `;

  const count = Number(copied[0]?.copied ?? 0);
  await auditWrite(companyId, userId, 'create', target, toYear, { copiedFromFiscalYear: String(fromYear), accounts: String(count) });
  log.info('Copied budgets', { fromYear, toYear, count }, 'accounting');
  return count;
}

function budgetName(fiscalYear: number): string {
  return `FY${fiscalYear} Budget`;
}

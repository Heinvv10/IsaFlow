/**
 * Budget Management Service — one budget per GL account per fiscal year.
 *
 * Storage shape is dictated by the READ path
 * (pages/api/accounting/reports-budget-vs-actual.ts): the twelve months live in
 * `period_amounts` JSONB keyed 'jan'..'dec', not in twelve columns. The earlier
 * version of this file wrote jan..dec columns that do not exist, omitted both
 * NOT NULL columns, and named a constraint that was never created — which is
 * why `accounting_budgets` holds zero rows in production.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = DbRow;

/** Month keys as the budget-vs-actual reader looks them up. Order is Jan..Dec. */
const MONTH_KEYS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'] as const;

export interface BudgetEntry {
  id: string;
  glAccountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  fiscalYear: number;
  annualAmount: number;
  months: number[];
  notes?: string;
  createdAt: string;
}

export interface BudgetInput {
  glAccountId: string;
  fiscalYear: number;
  annualAmount: number;
  months?: number[];
  notes?: string;
}

export async function getBudgets(companyId: string, fiscalYear: number): Promise<BudgetEntry[]> {
  const rows = (await sql`
    SELECT b.id, b.gl_account_id, b.fiscal_year, b.annual_amount, b.period_amounts,
           b.notes, b.created_at,
           ga.account_code, ga.account_name, ga.account_type
    FROM accounting_budgets b
    JOIN gl_accounts ga ON ga.id = b.gl_account_id AND ga.company_id = ${companyId}::UUID
    WHERE b.company_id = ${companyId}::UUID AND b.fiscal_year = ${fiscalYear}
    ORDER BY ga.account_code
  `) as Row[];
  return rows.map(mapRow);
}

export async function upsertBudget(
  companyId: string,
  input: BudgetInput,
  userId: string,
): Promise<BudgetEntry> {
  const months = normaliseMonths(input.months, input.annualAmount);
  const periodAmounts = toPeriodAmounts(months);
  const total = round2(months.reduce((s, m) => s + m, 0));

  // The arbiter index is partial (WHERE gl_account_id IS NOT NULL), so the
  // predicate has to be repeated here or Postgres cannot pick it.
  const rows = (await sql`
    INSERT INTO accounting_budgets (
      company_id, budget_name, fiscal_year, gl_account_id,
      period_amounts, annual_amount, total_amount, notes, created_by
    ) VALUES (
      ${companyId}::UUID, ${budgetName(input.fiscalYear)}, ${input.fiscalYear},
      ${input.glAccountId}::UUID,
      ${JSON.stringify(periodAmounts)}::JSONB, ${input.annualAmount}, ${total},
      ${input.notes ?? null}, ${userId}
    )
    ON CONFLICT (company_id, gl_account_id, fiscal_year) WHERE gl_account_id IS NOT NULL
    DO UPDATE SET
      period_amounts = EXCLUDED.period_amounts,
      annual_amount  = EXCLUDED.annual_amount,
      total_amount   = EXCLUDED.total_amount,
      notes          = EXCLUDED.notes,
      updated_at     = now()
    RETURNING id
  `) as Row[];

  const id = String(rows[0]!.id);
  const result = (await sql`
    SELECT b.id, b.gl_account_id, b.fiscal_year, b.annual_amount, b.period_amounts,
           b.notes, b.created_at,
           ga.account_code, ga.account_name, ga.account_type
    FROM accounting_budgets b
    JOIN gl_accounts ga ON ga.id = b.gl_account_id AND ga.company_id = ${companyId}::UUID
    WHERE b.id = ${id}::UUID AND b.company_id = ${companyId}::UUID
  `) as Row[];
  const row = result[0];
  if (!row) {
    // Only reachable if gl_account_id belongs to another tenant: the insert
    // succeeded but the account join excludes it. Refuse rather than return a
    // half-built entry.
    throw new Error('Budget account does not belong to this company');
  }

  log.info('Upserted budget', {
    glAccountId: input.glAccountId, fiscalYear: input.fiscalYear,
    annualAmount: input.annualAmount,
  }, 'accounting');
  return mapRow(row);
}

export async function deleteBudget(companyId: string, id: string): Promise<void> {
  await sql`DELETE FROM accounting_budgets WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID`;
}

export async function copyBudgets(
  companyId: string,
  fromYear: number,
  toYear: number,
  userId: string,
): Promise<number> {
  const rows = (await sql`
    INSERT INTO accounting_budgets (
      company_id, budget_name, fiscal_year, gl_account_id,
      period_amounts, annual_amount, total_amount, notes, created_by
    )
    SELECT b.company_id, ${budgetName(toYear)}, ${toYear}, b.gl_account_id,
           b.period_amounts, b.annual_amount, b.total_amount, b.notes, ${userId}
    FROM accounting_budgets b
    WHERE b.company_id = ${companyId}::UUID
      AND b.fiscal_year = ${fromYear}
      AND b.gl_account_id IS NOT NULL
    ON CONFLICT (company_id, gl_account_id, fiscal_year) WHERE gl_account_id IS NOT NULL
    DO NOTHING
    RETURNING id
  `) as Row[];

  log.info('Copied budgets', { fromYear, toYear, count: rows.length }, 'accounting');
  return rows.length;
}

/** An explicit split wins; otherwise spread the annual evenly, cents on December. */
function normaliseMonths(months: number[] | undefined, annual: number): number[] {
  if (months && months.length === 12) return months.map(m => round2(Number(m) || 0));
  const monthly = round2(annual / 12);
  const arr = Array<number>(12).fill(monthly);
  arr[11] = round2(annual - monthly * 11);
  return arr;
}

function toPeriodAmounts(months: number[]): Record<string, number> {
  const out: Record<string, number> = {};
  MONTH_KEYS.forEach((key, i) => { out[key] = months[i] ?? 0; });
  return out;
}

function budgetName(fiscalYear: number): string {
  return `FY${fiscalYear} Budget`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function mapRow(row: Row): BudgetEntry {
  const periodAmounts = (row.period_amounts ?? {}) as Record<string, unknown>;
  return {
    id: String(row.id),
    glAccountId: String(row.gl_account_id),
    accountCode: String(row.account_code ?? ''),
    accountName: String(row.account_name ?? ''),
    accountType: String(row.account_type ?? ''),
    fiscalYear: Number(row.fiscal_year),
    annualAmount: Number(row.annual_amount),
    months: MONTH_KEYS.map(k => Number(periodAmounts[k] ?? 0)),
    notes: row.notes ? String(row.notes) : undefined,
    createdAt: String(row.created_at),
  };
}

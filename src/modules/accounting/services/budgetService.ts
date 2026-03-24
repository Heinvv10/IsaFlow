/**
 * Budget Management Service
 * Phase 5: Create and manage budgets per GL account per fiscal year
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'] as const;

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

export async function getBudgets(fiscalYear: number): Promise<BudgetEntry[]> {
  const rows = (await sql`
    SELECT b.*, ga.account_code, ga.account_name, ga.account_type
    FROM accounting_budgets b
    JOIN gl_accounts ga ON ga.id = b.gl_account_id
    WHERE b.fiscal_year = ${fiscalYear}
    ORDER BY ga.account_code
  `) as Row[];
  return rows.map(mapRow);
}

export async function upsertBudget(input: BudgetInput, userId: string): Promise<BudgetEntry> {
  const months = input.months || distributeEvenly(input.annualAmount);

  const rows = (await sql`
    INSERT INTO accounting_budgets (
      gl_account_id, fiscal_year, annual_amount,
      jan, feb, mar, apr, may, jun, jul, aug, sep, oct, nov, "dec",
      notes, created_by
    ) VALUES (
      ${input.glAccountId}::UUID, ${input.fiscalYear}, ${input.annualAmount},
      ${months[0]}, ${months[1]}, ${months[2]}, ${months[3]},
      ${months[4]}, ${months[5]}, ${months[6]}, ${months[7]},
      ${months[8]}, ${months[9]}, ${months[10]}, ${months[11]},
      ${input.notes || null}, ${userId}::UUID
    )
    ON CONFLICT (gl_account_id, fiscal_year)
    DO UPDATE SET
      annual_amount = EXCLUDED.annual_amount,
      jan = EXCLUDED.jan, feb = EXCLUDED.feb, mar = EXCLUDED.mar,
      apr = EXCLUDED.apr, may = EXCLUDED.may, jun = EXCLUDED.jun,
      jul = EXCLUDED.jul, aug = EXCLUDED.aug, sep = EXCLUDED.sep,
      oct = EXCLUDED.oct, nov = EXCLUDED.nov, "dec" = EXCLUDED."dec",
      notes = EXCLUDED.notes
    RETURNING *
  `) as Row[];

  // Re-query with join
  const result = (await sql`
    SELECT b.*, ga.account_code, ga.account_name, ga.account_type
    FROM accounting_budgets b
    JOIN gl_accounts ga ON ga.id = b.gl_account_id
    WHERE b.id = ${rows[0].id}::UUID
  `) as Row[];

  log.info('Upserted budget', {
    glAccountId: input.glAccountId, fiscalYear: input.fiscalYear,
    annualAmount: input.annualAmount,
  }, 'accounting');
  return mapRow(result[0]);
}

export async function deleteBudget(id: string): Promise<void> {
  await sql`DELETE FROM accounting_budgets WHERE id = ${id}::UUID`;
}

export async function copyBudgets(fromYear: number, toYear: number, userId: string): Promise<number> {
  const existing = (await sql`
    SELECT gl_account_id, annual_amount,
           jan, feb, mar, apr, may, jun, jul, aug, sep, oct, nov, "dec", notes
    FROM accounting_budgets WHERE fiscal_year = ${fromYear}
  `) as Row[];

  let count = 0;
  for (const row of existing) {
    await sql`
      INSERT INTO accounting_budgets (
        gl_account_id, fiscal_year, annual_amount,
        jan, feb, mar, apr, may, jun, jul, aug, sep, oct, nov, "dec",
        notes, created_by
      ) VALUES (
        ${row.gl_account_id}::UUID, ${toYear}, ${row.annual_amount},
        ${row.jan}, ${row.feb}, ${row.mar}, ${row.apr},
        ${row.may}, ${row.jun}, ${row.jul}, ${row.aug},
        ${row.sep}, ${row.oct}, ${row.nov}, ${row.dec},
        ${row.notes || null}, ${userId}::UUID
      )
      ON CONFLICT (gl_account_id, fiscal_year) DO NOTHING
    `;
    count++;
  }
  log.info('Copied budgets', { fromYear, toYear, count }, 'accounting');
  return count;
}

function distributeEvenly(annual: number): number[] {
  const monthly = Math.round((annual / 12) * 100) / 100;
  const arr = Array(12).fill(monthly) as number[];
  // Adjust last month for rounding
  const sum = arr.slice(0, 11).reduce((s, v) => s + v, 0);
  arr[11] = Math.round((annual - sum) * 100) / 100;
  return arr;
}

function mapRow(row: Row): BudgetEntry {
  return {
    id: String(row.id),
    glAccountId: String(row.gl_account_id),
    accountCode: String(row.account_code || ''),
    accountName: String(row.account_name || ''),
    accountType: String(row.account_type || ''),
    fiscalYear: Number(row.fiscal_year),
    annualAmount: Number(row.annual_amount),
    months: MONTHS.map(m => Number(row[m] || 0)),
    notes: row.notes ? String(row.notes) : undefined,
    createdAt: String(row.created_at),
  };
}

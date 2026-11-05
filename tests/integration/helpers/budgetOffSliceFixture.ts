/**
 * Budgets P5-2b (off-slice lines refused in block): on top of the P5-2 bill fixture (`budgetBillFixture.ts`: opex
 * BB-6100 at CC1 FT 1 000 / HT 0 a month, nob BB-6300 unbudgeted, FY2027 = Mar 2026 - Feb 2027), a CC2-grain
 * account: proj BB-6400 budgeted at CC2 PA 5 000 a month only; PB is a CC2 centre with no budget row. Seeded as
 * the superuser; `dropBillFixture` removes it with the company.
 */
import type { Pool } from 'pg';
import { MONTHS, type BillFixture } from './budgetBillFixture';

export interface OffSliceExtra { proj: string; PA: string; PB: string }

export async function seedOffSlice(pool: Pool, f: BillFixture): Promise<OffSliceExtra> {
  const x: OffSliceExtra = { proj: crypto.randomUUID(), PA: crypto.randomUUID(), PB: crypto.randomUUID() };
  await pool.query(`INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, normal_balance, level, is_active)
                    VALUES ($1, $2, 'BB-6400', 'Projects', 'expense', 'debit', 3, true)`, [x.proj, f.co]);
  await pool.query(`INSERT INTO cost_centres (id, company_id, code, name, cc_type) VALUES ($1, $3, 'PA', 'Project A', 'cc2'),
                      ($2, $3, 'PB', 'Project B', 'cc2')`, [x.PA, x.PB, f.co]);
  await pool.query(
    `INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount, cc2_id)
     SELECT $1, $2, $3, (m || '-01')::DATE, 5000, $4 FROM unnest($5::TEXT[]) AS m`, [f.co, f.version, x.proj, x.PA, MONTHS]);
  return x;
}

/** Sets every line of the bill to CC2 `cc2` (makeBill writes CC1 only). */
export const setBillCc2 = (pool: Pool, bill: string, cc2: string) =>
  pool.query('UPDATE supplier_invoice_items SET cc2_id = $2 WHERE supplier_invoice_id = $1', [bill, cc2]);

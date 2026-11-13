// Two-tenant fixture for the "Ask IsaFlow" integration suite. Callers run assertNotProductionDb first.
// Each tenant gets a bi-monthly (Sep-Oct) VAT vendor with one posted October sale (VAT 15% on the base), one posted October
// expense, a bank asset, an approved October pay run with one line, and a later draft run (November) that must never be "the last pay run".
// Tenant B's amounts are ten times A's, so any cross-tenant read shows up as a different figure.
import { randomUUID } from 'crypto';
import type { Pool } from 'pg';

export interface AskScope { A: string; B: string; USER: string; TAG: string }
export const ASK_AMOUNTS = {
  A: { sale: 1000, expense: 300, gross: 50_000 },
  B: { sale: 10_000, expense: 3000, gross: 500_000 },
} as const;

export const newAskScope = (): AskScope => ({ A: randomUUID(), B: randomUUID(), USER: randomUUID(), TAG: `ASK-${Date.now()}` });

async function account(pool: Pool, co: string, code: string, type: string, subtype: string | null, normal: 'debit' | 'credit'): Promise<string> {
  const r = await pool.query(
    `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [co, code, `Acct ${code}`, type, subtype, normal]);
  return r.rows[0].id as string;
}

async function systemAccount(pool: Pool, co: string, code: string, type: string, subtype: string, normal: 'debit' | 'credit'): Promise<void> {
  const id = await account(pool, co, code, type, subtype, normal);
  await pool.query('UPDATE gl_accounts SET is_system_account = true WHERE id = $1', [id]);
}

async function journal(pool: Pool, s: AskScope, co: string, lines: Array<[string, number, number, string | null]>): Promise<void> {
  const je = await pool.query(
    `INSERT INTO gl_journal_entries (company_id, entry_date, created_by, status, description)
     VALUES ($1,'2026-10-10',$2,'draft','ask fixture') RETURNING id`, [co, s.USER]);
  const id = je.rows[0].id as string;
  for (const [acct, debit, credit, vat] of lines) {
    await pool.query(
      `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, vat_type) VALUES ($1,$2,$3,$4,$5,$6)`,
      [co, id, acct, debit, credit, vat]);
  }
  await pool.query(`UPDATE gl_journal_entries SET status = 'posted', posted_at = now() WHERE id = $1`, [id]);
}

async function payRun(pool: Pool, co: string, month: number, status: string, gross: number, emp: string, createdAt: string): Promise<void> {
  const paye = Math.round(gross * 0.1 * 100) / 100;
  const sdl = Math.round(gross * 0.01 * 100) / 100;
  const h = await pool.query(
    `INSERT INTO payroll_run_headers (company_id, period_month, period_year, status, total_gross, total_taxable, total_paye, total_sdl, total_net, employee_count, created_at)
     VALUES ($1,$8,2026,$2,$3,$3,$4,$5,$6,1,$7) RETURNING id`, [co, status, gross, paye, sdl, gross - paye, createdAt, month]);
  await pool.query(
    `INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, taxable_income, paye, sdl, net_pay) VALUES ($1,$2,$3,$3,$4,$5,$6)`,
    [h.rows[0].id, emp, gross, paye, sdl, gross - paye]);
}

export async function seedAskScope(pool: Pool, s: AskScope): Promise<void> {
  for (const [co, k] of [[s.A, 'A'], [s.B, 'B']] as const) {
    const a = ASK_AMOUNTS[k];
    await pool.query(
      `INSERT INTO companies (id, name, is_active, financial_year_start, vat_period, vat_period_alignment, vat_system_type)
       VALUES ($1,$2,true,3,'bi-monthly','even','invoice')`, [co, `Ask ${k} ${s.TAG}`]);
    const bank = await account(pool, co, '1000', 'asset', 'bank', 'debit');
    const rev = await account(pool, co, '4000', 'revenue', 'default_revenue', 'credit');
    const vatOut = await account(pool, co, '2200', 'liability', 'vat_output', 'credit');
    await systemAccount(pool, co, '3900', 'equity', 'retained_earnings', 'credit');
    const exp = await account(pool, co, '6000', 'expense', 'operating_expense', 'debit');
    await journal(pool, s, co, [[bank, a.sale * 1.15, 0, null], [rev, 0, a.sale, 'standard'], [vatOut, 0, a.sale * 0.15, null]]);
    await journal(pool, s, co, [[exp, a.expense, 0, null], [bank, 0, a.expense, null]]);
    const emp = await pool.query(
      `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date) VALUES ($1,'E1','Emp','Loyee','2025-01-01') RETURNING id`, [co]);
    const e = emp.rows[0].id as string;
    await payRun(pool, co, 10, 'approved', a.gross, e, '2026-10-20T10:00:00Z');
    await payRun(pool, co, 11, 'draft', a.gross * 7, e, '2026-11-05T10:00:00Z'); // a later, undeclared month: never "the last run"
  }
}

export async function dropAskScope(pool: Pool, s: AskScope): Promise<void> {
  for (const co of [s.A, s.B]) {
    await pool.query('DELETE FROM payroll_run_headers WHERE company_id = $1', [co]);
    await pool.query('DELETE FROM payroll_employees WHERE company_id = $1', [co]);
    await pool.query('ALTER TABLE gl_journal_entries DISABLE TRIGGER USER');
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id = $1', [co]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id = $1', [co]);
    await pool.query('ALTER TABLE gl_journal_entries ENABLE TRIGGER USER');
    await pool.query('DELETE FROM gl_accounts WHERE company_id = $1', [co]);
    await pool.query('DELETE FROM companies WHERE id = $1', [co]);
  }
}

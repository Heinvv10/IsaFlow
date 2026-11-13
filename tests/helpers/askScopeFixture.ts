// Two-tenant fixture for the "Ask IsaFlow" integration suite. Callers run assertNotProductionDb first.
// Each tenant is a bi-monthly (Sep-Oct) VAT vendor with: a posted October sale (VAT 15%), expense and finance-cost journal; a
// posted NOVEMBER sale and expense (after the questions' windows, so a wrong window or as-at date shows); approved September
// and October pay runs and a later draft November run (never "the last run"); an open customer invoice and supplier bill;
// two active bank accounts and one inactive one, with statement transactions.
// Tenant B's amounts are ten times A's, so any cross-tenant read shows up as a different figure.
import { randomUUID } from 'crypto';
import type { Pool } from 'pg';

export interface AskScope { A: string; B: string; USER: string; TAG: string }
export const ASK_AMOUNTS = {
  A: { sale: 1000, expense: 300, financeCost: 40, novSale: 2000, novExpense: 500, gross: 50_000, sepGross: 30_000, ar: 1234.56, ap: 789.12, bankA: 5000, bankB: 700, bankInactive: 300 },
  B: { sale: 10_000, expense: 3000, financeCost: 400, novSale: 20_000, novExpense: 5000, gross: 500_000, sepGross: 300_000, ar: 12_345.6, ap: 7891.2, bankA: 55_500, bankB: 7700, bankInactive: 3300 },
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

async function journal(pool: Pool, s: AskScope, co: string, date: string, lines: Array<[string, number, number, string | null]>): Promise<void> {
  const je = await pool.query(
    `INSERT INTO gl_journal_entries (company_id, entry_date, created_by, status, description)
     VALUES ($1,$3::date,$2,'draft','ask fixture') RETURNING id`, [co, s.USER, date]);
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

async function bankAccounts(pool: Pool, co: string, ledgerBank: string, a: (typeof ASK_AMOUNTS)['A']): Promise<void> {
  const second = await account(pool, co, '1010', 'asset', 'bank', 'debit');
  const old = await account(pool, co, '1020', 'asset', 'bank', 'debit');
  await pool.query('UPDATE gl_accounts SET is_active = false WHERE id = $1', [old]);
  for (const [acct, amount] of [[ledgerBank, a.bankA], [second, a.bankB], [old, a.bankInactive]] as const) {
    await pool.query(`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount) VALUES ($1,$2,'2026-10-02',$3)`, [co, acct, amount]);
  }
}

async function openItems(pool: Pool, s: AskScope, co: string, a: (typeof ASK_AMOUNTS)['A']): Promise<void> {
  const cust = await pool.query(`INSERT INTO customers (company_id, name) VALUES ($1,$2) RETURNING id`, [co, `Cust ${s.TAG}`]);
  const supp = await pool.query(`INSERT INTO suppliers (company_id, name) VALUES ($1,$2) RETURNING id`, [co, `Supp ${s.TAG}`]);
  await pool.query(
    `INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date, due_date, status, total_amount, amount_paid, created_by)
     VALUES ($1,$2,$2,$3,'2026-05-01','2026-05-31','approved',$4,0,$5)`, [co, cust.rows[0].id, `${s.TAG}-AR`, a.ar, s.USER]);
  await pool.query(
    `INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date, status, total_amount, amount_paid, created_by)
     VALUES ($1,$2,$3,'2026-05-01','2026-05-31','approved',$4,0,$5)`, [co, supp.rows[0].id, `${s.TAG}-AP`, a.ap, s.USER]);
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
    const fin = await account(pool, co, '7000', 'expense', 'finance_cost', 'debit');
    await journal(pool, s, co, '2026-10-10', [[bank, a.sale * 1.15, 0, null], [rev, 0, a.sale, 'standard'], [vatOut, 0, a.sale * 0.15, null]]);
    await journal(pool, s, co, '2026-10-12', [[exp, a.expense, 0, null], [bank, 0, a.expense, null]]);
    await journal(pool, s, co, '2026-10-14', [[fin, a.financeCost, 0, null], [bank, 0, a.financeCost, null]]);
    await journal(pool, s, co, '2026-11-05', [[bank, a.novSale * 1.15, 0, null], [rev, 0, a.novSale, 'standard'], [vatOut, 0, a.novSale * 0.15, null]]);
    await journal(pool, s, co, '2026-11-06', [[exp, a.novExpense, 0, null], [bank, 0, a.novExpense, null]]);
    await bankAccounts(pool, co, bank, a);
    await openItems(pool, s, co, a);
    const emp = await pool.query(
      `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date) VALUES ($1,'E1','Emp','Loyee','2025-01-01') RETURNING id`, [co]);
    const e = emp.rows[0].id as string;
    await payRun(pool, co, 9, 'approved', a.sepGross, e, '2026-09-20T10:00:00Z');
    await payRun(pool, co, 10, 'approved', a.gross, e, '2026-10-20T10:00:00Z');
    await payRun(pool, co, 11, 'draft', a.gross * 7, e, '2026-11-05T10:00:00Z'); // a later, undeclared month: never "the last run"
  }
}

export async function dropAskScope(pool: Pool, s: AskScope): Promise<void> {
  for (const co of [s.A, s.B]) {
    await pool.query('DELETE FROM bank_transactions WHERE company_id = $1', [co]);
    await pool.query('DELETE FROM customer_invoices WHERE company_id = $1', [co]);
    await pool.query('DELETE FROM supplier_invoices WHERE company_id = $1', [co]);
    await pool.query('DELETE FROM customers WHERE company_id = $1', [co]);
    await pool.query('DELETE FROM suppliers WHERE company_id = $1', [co]);
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

/**
 * Fixture for the #678 review tests: a company with the rows a cost centre or
 * business unit can be referenced from, and a request-shaped transaction to run
 * the services in (an ALS-bound client inside BEGIN / COMMIT, as withAuth does).
 */
import type { Pool, PoolClient } from 'pg';
import { als } from '@/lib/als';

export interface Base {
  company: string; user: string; account: string; bank: string; supplier: string; customer: string;
  employee: string; journal: string; supplierInvoice: string; customerInvoice: string; claim: string;
}

/** Runs `fn` as a request would: one transaction on its own connection, bound to ALS. */
export async function inCompanyTx<T>(pool: Pool, companyId: string, userId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  await c.query('BEGIN');
  try {
    const out = await als.run({ client: c, userId, companyId, claims: {} } as never, () => fn(c));
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

export const inRequest = <T>(pool: Pool, b: Base, fn: (c: PoolClient) => Promise<T>): Promise<T> =>
  inCompanyTx(pool, b.company, b.user, fn);

const one = async (pool: Pool, text: string, values: unknown[]): Promise<string> =>
  String((await pool.query(`${text} RETURNING id`, values)).rows[0].id);

export async function seedBase(pool: Pool, company: string, user: string): Promise<Base> {
  await pool.query('INSERT INTO companies(id, name) VALUES($1, $2)', [company, `D678 ${company.slice(0, 8)}`]);
  await pool.query("INSERT INTO users(id, email, role, is_active) VALUES($1, $2, 'admin', true) ON CONFLICT DO NOTHING", [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id, user_id, role) VALUES($1, $2, 'owner')", [company, user]);
  const acct = (code: string, type: string) => one(pool,
    `INSERT INTO gl_accounts(company_id, account_code, account_name, account_type, normal_balance)
     VALUES($1, $2, $2, $3, 'debit')`, [company, code, type]);
  const account = await acct('6000', 'expense');
  const bank = await acct('1100', 'asset');
  const supplier = await one(pool, 'INSERT INTO suppliers(company_id, name) VALUES($1, $2)', [company, 'D678 Supplier']);
  const customer = await one(pool, 'INSERT INTO customers(company_id, name) VALUES($1, $2)', [company, 'D678 Customer']);
  const employee = await one(pool,
    `INSERT INTO payroll_employees(company_id, employee_number, first_name, last_name, start_date, medical_aid_main_member)
     VALUES($1, 'D678-1', 'Dee', 'Six', '2026-01-01', true)`, [company]);
  const journal = await one(pool,
    "INSERT INTO gl_journal_entries(company_id, entry_date, created_by, description) VALUES($1, '2026-08-01', $2, 'D678')",
    [company, user]);
  const supplierInvoice = await one(pool,
    `INSERT INTO supplier_invoices(company_id, invoice_number, supplier_id, invoice_date, created_by, total_amount)
     VALUES($1, 'D678-SI', $2, '2026-08-01', $3, 100)`, [company, supplier, user]);
  const customerInvoice = await one(pool,
    `INSERT INTO customer_invoices(company_id, invoice_number, customer_id, created_by, invoice_date, due_date, total_amount)
     VALUES($1, 'D678-CI', $2, $3, '2026-08-01', '2026-08-31', 100)`, [company, customer, user]);
  const claim = await one(pool,
    "INSERT INTO expense_claims(company_id, employee_id, claim_number, claim_date) VALUES($1, $2, 'D678-EC', '2026-08-01')",
    [company, employee]);
  return { company, user, account, bank, supplier, customer, employee, journal, supplierInvoice, customerInvoice, claim };
}

export const costCentre = (pool: Pool, company: string, code: string, ccType = 'cc1', parent: string | null = null, active = true) =>
  one(pool, 'INSERT INTO cost_centres(company_id, code, name, cc_type, parent_id, is_active) VALUES($1, $2, $2, $3, $4, $5)',
    [company, code, ccType, parent, active]);

export const businessUnit = (pool: Pool, company: string, code: string) =>
  one(pool, 'INSERT INTO business_units(company_id, code, name) VALUES($1, $2, $2)', [company, code]);

/** A posted-shape journal line on the base journal. */
export const journalLine = (pool: Pool, b: Base, col: 'cost_center_id' | 'cc1_id' | 'cc2_id' | 'bu_id', id: string) =>
  one(pool, `INSERT INTO gl_journal_lines(company_id, journal_entry_id, gl_account_id, debit, credit, ${col})
             VALUES($1, $2, $3, 10, 0, $4)`, [b.company, b.journal, b.account, id]);

export const bankLine = (pool: Pool, b: Base, col: 'cc1_id' | 'cc2_id' | 'bu_id', id: string) =>
  one(pool, `INSERT INTO bank_transactions(company_id, bank_account_id, transaction_date, amount, description, status, ${col})
             VALUES($1, $2, '2026-08-01', 10, 'D678', 'imported', $3)`, [b.company, b.bank, id]);

/** An un-reversed tag batch line that remembers `id` as the old value of `col`. */
export async function tagHistory(pool: Pool, b: Base, col: 'old_cc1_id' | 'old_cc2_id' | 'old_bu_id', id: string): Promise<string> {
  const batch = await one(pool, 'INSERT INTO dimension_tag_batches(company_id, idempotency_key) VALUES($1, $2)',
    [b.company, crypto.randomUUID()]);
  const line = await one(pool, `INSERT INTO gl_journal_lines(company_id, journal_entry_id, gl_account_id, debit, credit)
                                VALUES($1, $2, $3, 10, 0)`, [b.company, b.journal, b.account]);
  return one(pool, `INSERT INTO dimension_tag_batch_lines(batch_id, company_id, journal_line_id, ${col}) VALUES($1, $2, $3, $4)`,
    [batch, b.company, line, id]);
}

/** Every row the fixture may have written, children before the masters they RESTRICT. */
export async function dropBase(pool: Pool, companies: string[], users: string[]): Promise<void> {
  const q = (text: string) => pool.query(text, [companies]);
  await q('DELETE FROM dimension_tag_batch_lines WHERE company_id = ANY($1)');
  await q('DELETE FROM dimension_tag_batches WHERE company_id = ANY($1)');
  await q('DELETE FROM gl_journal_lines WHERE company_id = ANY($1)');
  await q('DELETE FROM gl_journal_entries WHERE company_id = ANY($1)');
  await q('DELETE FROM bank_transactions WHERE company_id = ANY($1)');
  await q('DELETE FROM expense_claim_lines WHERE company_id = ANY($1)');
  await q('DELETE FROM expense_claims WHERE company_id = ANY($1)');
  await q('DELETE FROM customer_invoice_items WHERE invoice_id IN (SELECT id FROM customer_invoices WHERE company_id = ANY($1))');
  await q('DELETE FROM customer_invoices WHERE company_id = ANY($1)');
  await q('DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (SELECT id FROM supplier_invoices WHERE company_id = ANY($1))');
  await q('DELETE FROM supplier_invoices WHERE company_id = ANY($1)');
  await q('DELETE FROM supplier_purchase_orders WHERE company_id = ANY($1)');
  await q('DELETE FROM supplier_payments WHERE company_id = ANY($1)');
  await q('DELETE FROM customer_payments WHERE company_id = ANY($1)');
  await q('DELETE FROM credit_notes WHERE company_id = ANY($1)');
  await q('DELETE FROM supplier_coding_history WHERE company_id = ANY($1)');
  await q('DELETE FROM supplier_coding_rules WHERE company_id = ANY($1)');
  await q('DELETE FROM payroll_employee_history WHERE company_id = ANY($1)');
  await q('DELETE FROM payroll_employee_cost_allocations WHERE company_id = ANY($1)');
  await q('DELETE FROM assets WHERE company_id = ANY($1)');
  await q('DELETE FROM payroll_employees WHERE company_id = ANY($1)');
  await q('DELETE FROM customers WHERE company_id = ANY($1)');
  await q('DELETE FROM suppliers WHERE company_id = ANY($1)');
  await q('UPDATE gl_accounts SET default_cc1_id = NULL, default_cc2_id = NULL, default_bu_id = NULL WHERE company_id = ANY($1)');
  await q('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = ANY($1))');
  await q('DELETE FROM gl_accounts WHERE company_id = ANY($1)');
  await q('DELETE FROM business_units WHERE company_id = ANY($1)');
  await q('UPDATE cost_centres SET parent_id = NULL WHERE company_id = ANY($1)');
  await q('DELETE FROM cost_centres WHERE company_id = ANY($1)');
  await q('DELETE FROM company_users WHERE company_id = ANY($1)');
  await q('DELETE FROM companies WHERE id = ANY($1)');
  await pool.query('DELETE FROM users WHERE id = ANY($1)', [users]);
}

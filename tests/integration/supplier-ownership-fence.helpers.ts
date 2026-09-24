// tests/integration/supplier-ownership-fence.helpers.ts
//
// R-068 fixture: two throwaway companies on the disposable schema fixture.
// Company A owns SUP_A and SUP_A2; company B owns SUP_B. SUP_A2 is what the
// seeded update-arm rows carry, so an "own supplier" case that re-points a row
// to SUP_A proves a write happened rather than finding the seed.

import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { request, response } from './mfa-impersonation-postgres.helpers';

export type Handler = (req: never, res: never) => Promise<unknown> | unknown;

export interface SupplierCase {
  name: string;
  handler: Handler;
  method: string;
  query?: (supplierId: string) => Record<string, string>;
  body: (supplierId: string) => Record<string, unknown>;
  /** Rows of company A that carry `supplierId` in the fenced column. */
  carried: (supplierId: string) => Promise<number>;
  refusal: number;
}

export const ids = {
  A: randomUUID(), B: randomUUID(), USER: randomUUID(),
  SUP_A: randomUUID(), SUP_A2: randomUUID(), SUP_B: randomUUID(),
  CUST_A: randomUUID(), CUST_B: randomUUID(),
  GL: randomUUID(), BANK_GL: randomUUID(), AP_GL: randomUUID(), AR_GL: randomUUID(),
  BILL: randomUUID(), BILL_A: randomUUID(), PO: randomUUID(), SPO: randomUUID(),
  RULE: randomUUID(), BANK_TX_SEL: randomUUID(), BANK_TX_PAY: randomUUID(),
  TEMPLATE_A: randomUUID(), TEMPLATE_B: randomUUID(), TEMPLATE_BAD: randomUUID(),
};

export interface Fixture {
  pool: Pool;
  count: (text: string, params: unknown[]) => Promise<number>;
  call: (h: Handler, method: string, body: Record<string, unknown>, query?: Record<string, string>)
    => Promise<{ statusCode: number; body: unknown }>;
}

export async function setUpFixture(label: string): Promise<Fixture> {
  const { A, B, USER } = ids;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const q = (text: string, params: unknown[]) => pool.query(text, params);
  await q('INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true), ($3, $4, true)',
    [A, `${label} Co A`, B, `${label} Co B`]);
  await q("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)",
    [USER, `r068-${USER}@isaflow.test`]);
  await q("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'admin')", [A, USER]);
  await q(`INSERT INTO suppliers (id, company_id, name, email) VALUES
      ($1, $2, 'R068 Supplier A', 'a@r068.test'), ($3, $2, 'R068 Supplier A2', NULL),
      ($4, $5, 'R068 Supplier B', 'b@r068.test')`,
  [ids.SUP_A, A, ids.SUP_A2, ids.SUP_B, B]);
  await q("INSERT INTO customers (id, company_id, name) VALUES ($1, $2, 'R068 Customer A'), ($3, $4, 'R068 Customer B')",
    [ids.CUST_A, A, ids.CUST_B, B]);
  for (const [id, code, name, type, subtype, normal, system] of [
    [ids.GL, '5100', 'R068 Expense', 'expense', 'default_expense', 'debit', false],
    [ids.BANK_GL, '1000', 'R068 Bank', 'asset', 'bank', 'debit', true],
    [ids.AP_GL, '2000', 'R068 AP', 'liability', 'payable', 'credit', true],
    [ids.AR_GL, '1100', 'R068 AR', 'asset', 'receivable', 'debit', true],
  ] as const) {
    await q(`INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type,
        account_subtype, normal_balance, is_active, is_system_account)
      VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8)`, [id, A, code, name, type, subtype, normal, system]);
  }
  await q(`INSERT INTO supplier_invoices (id, company_id, invoice_number, supplier_id, invoice_date,
      subtotal, tax_amount, total_amount, amount_paid, status, created_by)
    VALUES ($1, $2, 'R068-SEED-BILL', $3, CURRENT_DATE, 100, 15, 115, 0, 'approved', $4)`,
  [ids.BILL, A, ids.SUP_A2, USER]);
  // SUP_A's own bill, for the payment arms: a payment may settle only its own
  // supplier's bills (K-066), so the seeded SUP_A2 bill would refuse them.
  await q(`INSERT INTO supplier_invoices (id, company_id, invoice_number, supplier_id, invoice_date,
      subtotal, tax_amount, total_amount, amount_paid, status, created_by)
    VALUES ($1, $2, 'R068-SEED-BILL-A', $3, CURRENT_DATE, 100, 15, 115, 0, 'approved', $4)`,
  [ids.BILL_A, A, ids.SUP_A, USER]);
  await q(`INSERT INTO purchase_orders (id, company_id, po_number, supplier_id, status)
    VALUES ($1, $2, 'R068-PO-SEED', $3, 'draft')`, [ids.PO, A, ids.SUP_A2]);
  await q(`INSERT INTO supplier_purchase_orders (id, company_id, order_number, supplier_id, status)
    VALUES ($1, $2, 'R068-SPO-SEED', $3, 'draft')`, [ids.SPO, A, ids.SUP_A2]);
  await q(`INSERT INTO bank_categorisation_rules (id, company_id, rule_name, match_field, match_type,
      match_pattern, gl_account_id, supplier_id, created_by)
    VALUES ($1, $2, 'R068 seeded rule', 'description', 'contains', 'R068-SEED', $3, $4, $5)`,
  [ids.RULE, A, ids.GL, ids.SUP_A2, USER]);
  await q(`INSERT INTO bank_transactions (id, company_id, bank_account_id, transaction_date, amount,
      description, status) VALUES ($1, $3, $4, CURRENT_DATE, -50, 'R068 selection', 'imported'),
      ($2, $3, $4, CURRENT_DATE, -115, 'R068 payment', 'imported')`,
  [ids.BANK_TX_SEL, ids.BANK_TX_PAY, A, ids.BANK_GL]);
  for (const [id, supplierId] of [[ids.TEMPLATE_A, ids.SUP_A], [ids.TEMPLATE_B, ids.SUP_B],
    [ids.TEMPLATE_BAD, 'not-a-uuid']]) {
    await q(`INSERT INTO recurring_transaction_templates (id, company_id, name, entity_type,
        template_data, frequency, next_run_date, created_by)
      VALUES ($1, $2, 'R068 template', 'supplier_invoice', $3::jsonb, 'monthly', CURRENT_DATE, $4)`,
    [id, A, JSON.stringify({ supplierId, reference: 'R068-REC', subtotal: 100, vatAmount: 15,
      totalAmount: 115 }), USER]);
  }
  const token = await new SignJWT({ sub: USER, aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));

  const count = async (text: string, params: unknown[]) => Number((await pool.query(text, params)).rows[0].n);
  const call: Fixture['call'] = async (handler, method, body, query = {}) => {
    const req = request({ 'sb-access-token': token, active_company_id: A }, method) as never as
      { body: unknown; query: Record<string, string>; url: string };
    req.body = body;
    req.query = query;
    req.url = '/api/accounting/r068-fence-fixture';
    const out = response();
    await handler(req as never, out.res as never);
    return out.state;
  };
  return { pool, count, call };
}

export async function tearDownFixture(pool: Pool | undefined): Promise<void> {
  if (!pool) return;
  const both = [[ids.A, ids.B]];
  try {
    await pool.query(`DELETE FROM payment_allocations WHERE payment_id IN
      (SELECT id FROM supplier_payments WHERE company_id = ANY($1::uuid[]))`, both);
    await pool.query(`DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN
      (SELECT id FROM supplier_invoices WHERE company_id = ANY($1::uuid[]))`, both);
    await pool.query(`DELETE FROM po_items WHERE purchase_order_id IN
      (SELECT id FROM purchase_orders WHERE company_id = ANY($1::uuid[]))`, both);
    await pool.query(`DELETE FROM supplier_purchase_order_items WHERE purchase_order_id IN
      (SELECT id FROM supplier_purchase_orders WHERE company_id = ANY($1::uuid[]))`, both);
    await pool.query('DELETE FROM bank_transactions WHERE company_id = ANY($1::uuid[])', both);
    await pool.query(`DELETE FROM gl_journal_lines WHERE journal_entry_id IN
      (SELECT id FROM gl_journal_entries WHERE company_id = ANY($1::uuid[]))`, both);
    // A soft-deleted bill's reversal is recorded and chained to the original.
    await pool.query('DELETE FROM soft_delete_journal_reversals WHERE company_id = ANY($1::uuid[])', both);
    await pool.query(`UPDATE gl_journal_entries SET reversal_of_id = NULL, reversed_by = NULL
      WHERE company_id = ANY($1::uuid[])`, both);
    for (const t of ['expected_invoice_alerts', 'supplier_expectations', 'supplier_coding_rules',
      'supplier_activities', 'supplier_contacts', 'accounting_adjustments', 'credit_notes',
      'supplier_payments', 'customer_payments', 'supplier_payment_batches', 'recurring_transaction_templates',
      'supplier_invoices', 'purchase_orders', 'supplier_purchase_orders', 'gl_journal_entries',
      'bank_categorisation_rules', 'company_document_numbers', 'flow_ledger']) {
      await pool.query(`DELETE FROM ${t} WHERE company_id = ANY($1::uuid[])`, both);
    }
    // Posting maintains these; they reference both the accounts and the periods.
    await pool.query(`DELETE FROM gl_account_balances WHERE gl_account_id IN
      (SELECT id FROM gl_accounts WHERE company_id = ANY($1::uuid[]))`, both);
    for (const t of ['fiscal_periods', 'gl_accounts', 'company_users', 'suppliers', 'customers']) {
      await pool.query(`DELETE FROM ${t} WHERE company_id = ANY($1::uuid[])`, both);
    }
    await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', both);
    await pool.query('DELETE FROM users WHERE id = $1', [ids.USER]);
  } finally {
    await pool.end();
  }
}

export function fenceCases(f: () => Fixture, cases: () => SupplierCase[]): void {
  it.each(cases())('$name refuses company B\'s supplier and stores nothing', async (c) => {
    const state = await f().call(c.handler, c.method, c.body(ids.SUP_B), c.query?.(ids.SUP_B));
    expect(state.statusCode, JSON.stringify(state.body)).toBe(c.refusal);
    // The typed refusal names the problem; a generic "Create failed" does not.
    expect(JSON.stringify(state.body)).toContain('was not found for this company');
    expect(await c.carried(ids.SUP_B)).toBe(0);
  });
  it.each(cases())('$name still stores company A\'s own supplier', async (c) => {
    const state = await f().call(c.handler, c.method, c.body(ids.SUP_A), c.query?.(ids.SUP_A));
    expect(state.statusCode, JSON.stringify(state.body)).toBeLessThan(300);
    expect(await c.carried(ids.SUP_A)).toBe(1);
  });
}

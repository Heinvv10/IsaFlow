/**
 * K-120's unproven half: two SIMULTANEOUS conversions in two open transactions.
 *
 * The original validation could not demonstrate the race, because a harness
 * that serialises both conversions on one pooled connection lets the second
 * MAX() read see the first INSERT. Two separate pool clients, each in its own
 * BEGIN, is the real shape of two concurrent requests under `withAuth`.
 *
 * What this asserts is that `reserveNextDocumentNumber`'s
 * `UPDATE company_document_numbers ... RETURNING` is a genuine mutex, not a
 * hopeful read: B's reservation BLOCKS on A's uncommitted row lock for as long
 * as A stays open, then takes the next number. So the concurrent collision is
 * closed outright, not merely retried past — which is why the retry loop can
 * stay bounded at five attempts.
 *
 * Under the old MAX(invoice_number)+1 both reads would have returned the same
 * value (each other's INSERT being invisible across transactions) and the
 * second INSERT would have hit uq_customer_invoices_company_number.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '../../src/lib/als';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { convertSalesOrderToInvoice } from '../../src/modules/accounting/services/ar/salesOrderWorkflowService';
import { ensureDocumentNumbers } from '../../src/modules/accounting/services/core/companySettingsService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const user = crypto.randomUUID();
const customer = crypto.randomUUID();
const orderA = crypto.randomUUID(), orderB = crypto.randomUUID();

/** How long A holds its transaction open while B is blocked on the counter. */
const HOLD_MS = 400;

async function seedOrder(id: string, number: string) {
  await pool.query(
    `INSERT INTO customer_sales_orders(id,company_id,order_number,customer_id,order_date,subtotal,tax_amount,total_amount,status,created_by)
     VALUES($1,$2,$3,$4,'2026-01-01',1000,150,1150,'confirmed',$5)`,
    [id, company, number, customer, user]);
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K120 concurrency']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customer, company, 'K120 customer']);
  await seedOrder(orderA, 'K120C-SO-A');
  await seedOrder(orderB, 'K120C-SO-B');
  await ensureDocumentNumbers(company);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM customer_invoice_items WHERE invoice_id IN (SELECT id FROM customer_invoices WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM customer_sales_orders WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customer_invoices WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM company_document_numbers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('serialises two conversions in two open transactions on the counter row lock', async () => {
  const seq = await pool.query(
    "SELECT next_number FROM company_document_numbers WHERE company_id=$1 AND document_type='customer_invoice'",
    [company]);
  const before = Number(seq.rows[0].next_number);

  const a = await pool.connect();
  const b = await pool.connect();
  try {
    await a.query('BEGIN');
    await b.query('BEGIN');

    const ctx = (client: typeof a) => ({ client, userId: user, companyId: company, claims: {} });

    // A reserves and inserts, then holds its transaction OPEN.
    const first = await als.run(ctx(a), () => convertSalesOrderToInvoice(company, orderA, user));

    let bSettled = false;
    const startedAt = Date.now();
    const second = als
      .run(ctx(b), () => convertSalesOrderToInvoice(company, orderB, user))
      .finally(() => { bSettled = true; });

    await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
    // B cannot have finished: it is parked on A's uncommitted counter row.
    expect.soft(bSettled).toBe(false);

    await a.query('COMMIT');
    const secondResult = await second;
    const blockedFor = Date.now() - startedAt;
    await b.query('COMMIT');

    expect.soft(blockedFor).toBeGreaterThanOrEqual(HOLD_MS);

    const numbers = await pool.query(
      'SELECT invoice_number FROM customer_invoices WHERE id=ANY($1) ORDER BY invoice_number',
      [[first.invoiceId, secondResult.invoiceId]]);
    expect.soft(numbers.rows.map((r) => r.invoice_number)).toEqual([
      `INV${String(before).padStart(7, '0')}`,
      `INV${String(before + 1).padStart(7, '0')}`,
    ]);

    const after = await pool.query(
      "SELECT next_number FROM company_document_numbers WHERE company_id=$1 AND document_type='customer_invoice'",
      [company]);
    // Two reservations, two numbers — no clash, so no attempt was burned.
    expect(Number(after.rows[0].next_number)).toBe(before + 2);
  } finally {
    a.release();
    b.release();
  }
});

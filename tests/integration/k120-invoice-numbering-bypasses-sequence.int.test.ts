/**
 * K-120 — recurring and sales-order invoice numbering bypasses the company sequence.
 *
 * salesOrderWorkflowService.ts:40-45 and recurringInvoiceService.ts:182-187 derive
 * the next invoice number from MAX(CAST(SUBSTRING(invoice_number ...))) + 1 instead
 * of reserveNextDocumentNumber, which customerInvoiceCreateService.ts:121 and
 * quoteConvertService.ts:93 both use (with a savepointed 23505 retry). Two
 * generators for one uniqueness domain (uq_customer_invoices_company_number):
 * the company's configured counter never advances, the two formats diverge, and
 * neither MAX() path handles 23505 — the sales-order path has no savepoint at all.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '../../src/lib/als';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { convertSalesOrderToInvoice } from '../../src/modules/accounting/services/ar/salesOrderWorkflowService';
import {
  ensureDocumentNumbers,
  reserveNextDocumentNumber,
  updateDocumentNumber,
} from '../../src/modules/accounting/services/core/companySettingsService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), user = crypto.randomUUID(), customer = crypto.randomUUID();
const orderA = crypto.randomUUID(), orderB = crypto.randomUUID();

/**
 * Every call runs in a request transaction, exactly as `withAuth` provides:
 * `claimUnderLockTimeout` refuses to claim outside one, because there the claim
 * autocommits and cannot be rolled back with the writes that follow it.
 */
async function inTx<T>(fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run(
      { client, userId: user, companyId: company, claims: {} } as unknown as Parameters<typeof als.run>[0], fn);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function seedOrder(id: string, number: string) {
  await pool.query(
    `INSERT INTO customer_sales_orders(id,company_id,order_number,customer_id,order_date,subtotal,tax_amount,total_amount,status,created_by)
     VALUES($1,$2,$3,$4,'2026-01-01',1000,150,1150,'confirmed',$5)`,
    [id, company, number, customer, user]);
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K120 fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customer, company, 'K120 customer']);
  await ensureDocumentNumbers(company);
  await updateDocumentNumber(company, 'customer_invoice', 'INV-');
  await seedOrder(orderA, 'K120-SO-A');
  await seedOrder(orderB, 'K120-SO-B');
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

it('mints the sales-order invoice from the company sequence', async () => {
  const before = (await pool.query(
    "SELECT next_number FROM company_document_numbers WHERE company_id=$1 AND document_type='customer_invoice'",
    [company])).rows[0].next_number;

  const { invoiceId } = await inTx(() => convertSalesOrderToInvoice(company, orderA, user));
  const minted = (await pool.query('SELECT invoice_number FROM customer_invoices WHERE id=$1', [invoiceId])).rows[0].invoice_number;

  const after = (await pool.query(
    "SELECT next_number FROM company_document_numbers WHERE company_id=$1 AND document_type='customer_invoice'",
    [company])).rows[0].next_number;

  // The configured counter must have moved, and the minted number must be the
  // one the sequence would have issued.
  expect.soft(Number(after)).toBe(Number(before) + 1);
  expect(minted).toBe(`INV-${String(Number(before)).padStart(7, '0')}`);
});

it('does not hand the sequence a number it has already used', async () => {
  // The sequence is still at 1 because the conversion above never touched it.
  const next = await reserveNextDocumentNumber(company, 'customer_invoice');
  const clash = await pool.query(
    'SELECT count(*)::int AS n FROM customer_invoices WHERE company_id=$1 AND invoice_number=$2',
    [company, next]);
  expect(clash.rows[0].n).toBe(0);
});

// NOTE: the 23505 half of this claim (two concurrent runs both reading MAX(...))
// could NOT be reproduced here — the integration harness serialises both calls on
// one pooled connection, so the second read already sees the first INSERT.

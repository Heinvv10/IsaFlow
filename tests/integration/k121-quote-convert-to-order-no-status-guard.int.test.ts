/**
 * K-121 — convertToSalesOrder has no status guard.
 *
 * quoteConvertService.ts:29-31 checks only that the quote exists. Its sibling
 * convertToInvoice (:84) refuses anything but status 'accepted' and is therefore
 * self-limiting. Every call to convertToSalesOrder mints a new SO number, inserts
 * a full duplicate order with all lines, and overwrites converted_order_id — so a
 * double-click or a client retry leaves two live sales orders for one quote, with
 * the quote pointing at only the second.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '../../src/lib/als';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { convertToSalesOrder, QuoteNotConvertibleError } from '../../src/modules/accounting/services/ar/quoteConvertService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), user = crypto.randomUUID(), customer = crypto.randomUUID();
const quote = crypto.randomUUID();

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


beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K121 fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customer, company, 'K121 customer']);
  await pool.query(
    `INSERT INTO customer_quotes(id,company_id,quote_number,client_id,quote_date,status,subtotal,tax_rate,tax_amount,total,created_by)
     VALUES($1,$2,'K121-Q-1',$3,'2026-01-01','accepted',1000,15,150,1150,$4)`,
    [quote, company, customer, user]);
  await pool.query(
    `INSERT INTO customer_quote_lines(quote_id,description,quantity,unit_price,tax_rate,amount,sort_order)
     VALUES($1,'Consulting',1,1000,15,1000,1)`, [quote]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM customer_sales_order_items WHERE sales_order_id IN (SELECT id FROM customer_sales_orders WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM customer_sales_orders WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customer_quote_lines WHERE quote_id=$1', [quote]);
    await pool.query('DELETE FROM customer_quotes WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM company_document_numbers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('converts a quote to a sales order exactly once', async () => {
  const first = await inTx(() => convertToSalesOrder(company, quote, user));
  expect(first).not.toBeNull();

  // A double-click / client retry. The quote is now 'converted_to_order', which
  // is not a convertible status, so the second call is REFUSED — and it hands
  // back the first call's order id so the caller can open it.
  const second = await inTx(() => convertToSalesOrder(company, quote, user)).then(
    () => null, (err: unknown) => err);
  expect.soft(second).toBeInstanceOf(QuoteNotConvertibleError);
  expect.soft((second as QuoteNotConvertibleError).quoteStatus).toBe('converted_to_order');
  expect.soft((second as QuoteNotConvertibleError).existingOrderId).toBe(first!.salesOrderId);

  const orders = await pool.query('SELECT count(*)::int AS n FROM customer_sales_orders WHERE company_id=$1', [company]);
  expect.soft(orders.rows[0].n).toBe(1);

  const link = await pool.query('SELECT converted_order_id FROM customer_quotes WHERE id=$1', [quote]);
  expect(String(link.rows[0].converted_order_id)).toBe(first!.salesOrderId);
});

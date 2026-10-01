/**
 * K-121 second half — "regardless of status".
 *
 * The claim was that a quote converts repeatedly AND from any status. A guard
 * of "not already converted_to_order" closes only the first half:
 * customer_quotes_status_check permits draft, sent, accepted, rejected,
 * declined, expired, converted and converted_to_order, so six of the eight
 * still passed it. The dangerous one is 'converted' — a quote already turned
 * into an INVOICE. Converting it to an order silently rewrote its status, so
 * the invoiced state vanished from the quote while converted_invoice_id still
 * pointed at the invoice, and that order could be invoiced again: the same
 * quote billed twice.
 *
 * These cases assert the allow-list: only 'accepted' and 'sent' convert, every
 * other status is refused, and a refusal writes NOTHING — no order, and the
 * quote's own status is left exactly as it was.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '../../src/lib/als';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  convertToSalesOrder,
  QuoteNotConvertibleError,
} from '../../src/modules/accounting/services/ar/quoteConvertService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

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
const company = crypto.randomUUID();
const user = crypto.randomUUID();
const customer = crypto.randomUUID();

const REFUSED = ['draft', 'rejected', 'declined', 'expired', 'converted', 'converted_to_order'];
const ALLOWED = ['accepted', 'sent'];
const quoteIds = new Map<string, string>();

async function seedQuote(status: string) {
  const id = crypto.randomUUID();
  quoteIds.set(status, id);
  await pool.query(
    `INSERT INTO customer_quotes(id,company_id,quote_number,client_id,quote_date,status,subtotal,tax_rate,tax_amount,total,created_by)
     VALUES($1,$2,$3,$4,'2026-01-01',$5,1000,15,150,1150,$6)`,
    [id, company, `K121S-${status.toUpperCase()}`, customer, status, user]);
  await pool.query(
    `INSERT INTO customer_quote_lines(quote_id,description,quantity,unit_price,tax_rate,amount,sort_order)
     VALUES($1,'Consulting',1,1000,15,1000,1)`, [id]);
  return id;
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K121 status allow-list']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customer, company, 'K121 customer']);
  for (const status of [...REFUSED, ...ALLOWED]) await seedQuote(status);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM customer_sales_order_items WHERE sales_order_id IN (SELECT id FROM customer_sales_orders WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM customer_sales_orders WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customer_quote_lines WHERE quote_id IN (SELECT id FROM customer_quotes WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM customer_quotes WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customer_invoices WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM company_document_numbers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it.each(REFUSED)('refuses a %s quote and leaves its status untouched', async (status) => {
  const id = quoteIds.get(status)!;
  const outcome = await inTx(() => convertToSalesOrder(company, id, user)).then(() => 'CONVERTED', (e: unknown) => e);

  expect.soft(outcome).toBeInstanceOf(QuoteNotConvertibleError);
  expect.soft((outcome as QuoteNotConvertibleError).quoteStatus).toBe(status);

  const after = await pool.query('SELECT status FROM customer_quotes WHERE id=$1', [id]);
  expect.soft(after.rows[0].status).toBe(status);

  const orders = await pool.query(
    'SELECT count(*)::int AS n FROM customer_sales_orders WHERE company_id=$1 AND reference=$2',
    [company, `K121S-${status.toUpperCase()}`]);
  expect(orders.rows[0].n).toBe(0);
});

it.each(ALLOWED)('converts a %s quote exactly once', async (status) => {
  const id = quoteIds.get(status)!;
  const result = await inTx(() => convertToSalesOrder(company, id, user));
  expect.soft(result).not.toBeNull();

  const after = await pool.query('SELECT status, converted_order_id FROM customer_quotes WHERE id=$1', [id]);
  expect.soft(after.rows[0].status).toBe('converted_to_order');
  expect(String(after.rows[0].converted_order_id)).toBe(result!.salesOrderId);
});

it('an invoiced quote keeps its invoice link and cannot be turned into a second billable order', async () => {
  const id = quoteIds.get('converted')!;
  const invoiceLink = crypto.randomUUID();
  await pool.query(
    `INSERT INTO customer_invoices(id,company_id,invoice_number,client_id,customer_id,invoice_date,due_date,subtotal,tax_amount,total_amount,status,created_by)
     VALUES($1,$2,'K121S-INV-1',$3,$3,'2026-01-01','2026-01-31',1000,150,1150,'draft',$4)`,
    [invoiceLink, company, customer, user]);
  await pool.query('UPDATE customer_quotes SET converted_invoice_id=$1 WHERE id=$2', [invoiceLink, id]);

  await expect(inTx(() => convertToSalesOrder(company, id, user))).rejects.toBeInstanceOf(QuoteNotConvertibleError);

  const after = await pool.query('SELECT status, converted_invoice_id, converted_order_id FROM customer_quotes WHERE id=$1', [id]);
  expect.soft(after.rows[0].status).toBe('converted');
  expect.soft(String(after.rows[0].converted_invoice_id)).toBe(invoiceLink);
  expect(after.rows[0].converted_order_id).toBeNull();
});

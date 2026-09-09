/**
 * K-121 adjacent cases for the convertToSalesOrder status guard.
 *
 * 1. Two CONCURRENT conversions of one quote, on two separate pool clients each
 *    inside its own BEGIN (the shape of two simultaneous requests under
 *    withAuth). The status-predicated UPDATE is the serialisation point: the
 *    second blocks on the row lock, then sees 'converted_to_order' and stops
 *    before the sequence is touched.
 * 2. A quote read under the WRONG tenant converts nothing and leaves the real
 *    tenant's quote and sales orders untouched.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '../../src/lib/als';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { convertToSalesOrder, QuoteNotConvertibleError } from '../../src/modules/accounting/services/ar/quoteConvertService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), other = crypto.randomUUID();
const user = crypto.randomUUID(), customer = crypto.randomUUID();
const raceQuote = crypto.randomUUID(), tenantQuote = crypto.randomUUID();

async function seedQuote(id: string, number: string) {
  await pool.query(
    `INSERT INTO customer_quotes(id,company_id,quote_number,client_id,quote_date,status,subtotal,tax_rate,tax_amount,total,created_by)
     VALUES($1,$2,$3,$4,'2026-01-01','accepted',1000,15,150,1150,$5)`,
    [id, company, number, customer, user]);
  await pool.query(
    `INSERT INTO customer_quote_lines(quote_id,description,quantity,unit_price,tax_rate,amount,sort_order)
     VALUES($1,'Consulting',1,1000,15,1000,1)`, [id]);
}

/** One request: its own connection, its own transaction, its own ALS context. */
async function asRequest<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    const result = await als.run(
      { client, userId: user, companyId: company, claims: {} },
      fn,
    );
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)',
    [company, 'K121 adjacent', other, 'K121 other tenant']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customer, company, 'K121 customer']);
  await seedQuote(raceQuote, 'K121A-Q-RACE');
  await seedQuote(tenantQuote, 'K121A-Q-TENANT');
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM customer_sales_order_items WHERE sales_order_id IN (SELECT id FROM customer_sales_orders WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM customer_sales_orders WHERE company_id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM customer_quote_lines WHERE quote_id=ANY($1)', [[raceQuote, tenantQuote]]);
    await pool.query('DELETE FROM customer_quotes WHERE company_id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM company_document_numbers WHERE company_id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM customers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('two concurrent conversions of one quote produce exactly one sales order', async () => {
  const a = await pool.connect();
  const b = await pool.connect();
  try {
    const settled = await Promise.allSettled([
      asRequest(a, () => convertToSalesOrder(company, raceQuote, user)),
      asRequest(b, () => convertToSalesOrder(company, raceQuote, user)),
    ]);

    // Exactly one winner; the loser is REFUSED, not silently given null.
    const winners = settled.filter(
      (r) => r.status === 'fulfilled' && r.value !== null);
    expect.soft(winners.length).toBe(1);
    const losers = settled.filter((r) => r.status === 'rejected');
    expect.soft(losers.length).toBe(1);
    expect.soft((losers[0] as PromiseRejectedResult).reason)
      .toBeInstanceOf(QuoteNotConvertibleError);

    const orders = await pool.query(
      'SELECT id FROM customer_sales_orders WHERE company_id=$1 AND reference=$2',
      [company, 'K121A-Q-RACE']);
    expect.soft(orders.rows.length).toBe(1);

    const quote = await pool.query(
      'SELECT status, converted_order_id FROM customer_quotes WHERE id=$1', [raceQuote]);
    expect.soft(quote.rows[0].status).toBe('converted_to_order');
    expect(String(quote.rows[0].converted_order_id)).toBe(String(orders.rows[0].id));
  } finally {
    a.release();
    b.release();
  }
});

it('a conversion asked for under the wrong tenant writes nothing', async () => {
  const result = await convertToSalesOrder(other, tenantQuote, user);
  expect.soft(result).toBeNull();

  const orders = await pool.query(
    'SELECT count(*)::int AS n FROM customer_sales_orders WHERE company_id=ANY($1) AND reference=$2',
    [[company, other], 'K121A-Q-TENANT']);
  expect.soft(orders.rows[0].n).toBe(0);

  const quote = await pool.query('SELECT status FROM customer_quotes WHERE id=$1', [tenantQuote]);
  expect(quote.rows[0].status).toBe('accepted');
});

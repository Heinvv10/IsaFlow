/**
 * K-107 round 5 census, class (b) — the row count that was discarded.
 *
 * `salesOrderService.updateSalesOrder` read `existing.status !== 'draft'` and
 * then ran a header UPDATE predicated on `status = 'draft'` — correct so far —
 * but threw the row count away and went on to DELETE and re-INSERT the order's
 * items unconditionally. A request that read 'draft' and was then beaten by a
 * confirm or an invoice conversion left the header alone and replaced the lines
 * of an order that had already been billed, so the invoice and its source order
 * no longer said the same thing.
 *
 * Two pool clients in two open transactions is the only shape that shows it: the
 * loser's early read must see 'draft' while the winner's confirm is still
 * uncommitted.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '../../src/lib/als';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { updateSalesOrder } from '../../src/modules/accounting/services/ar/salesOrderService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), user = crypto.randomUUID(), customer = crypto.randomUUID();

/** How long the winner holds its transaction open while the loser is parked. */
const HOLD_MS = 300;

const ctxFor = (client: PoolClient) =>
  ({ client, userId: user, companyId: company, claims: {} } as unknown as Parameters<typeof als.run>[0]);

async function seedDraftOrder(): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO customer_sales_orders(id,company_id,order_number,customer_id,order_date,
                                       subtotal,tax_amount,total_amount,status,created_by)
     VALUES($1,$2,$3,$4,'2026-04-01',1000,150,1150,'draft',$5)`,
    [id, company, `K107R5-SO-${id.slice(0, 8)}`, customer, user]);
  await pool.query(
    `INSERT INTO customer_sales_order_items(sales_order_id,line_number,description,quantity,unit_price,tax_rate,line_total)
     VALUES($1,1,'Original line',1,1000,15,1000)`, [id]);
  return id;
}

const editInput = {
  customer_id: customer,
  order_date: '2026-04-02',
  items: [{ description: 'Rewritten line', quantity: 2, unit_price: 500, tax_rate: 15 }],
} as unknown as Parameters<typeof updateSalesOrder>[2];

async function lineDescriptions(orderId: string): Promise<string[]> {
  const r = await pool.query(
    'SELECT description FROM customer_sales_order_items WHERE sales_order_id=$1 ORDER BY line_number', [orderId]);
  return r.rows.map((row) => String(row.description));
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K107 R5 SO fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customer, company, 'K107 SO customer']);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM customer_sales_order_items WHERE sales_order_id IN (SELECT id FROM customer_sales_orders WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM customer_sales_orders WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('does not rewrite the lines of an order confirmed between the read and the write', async () => {
  const order = await seedDraftOrder();
  const confirmer = await pool.connect(), editor = await pool.connect();
  let result: unknown;
  try {
    await confirmer.query('BEGIN');
    await editor.query('BEGIN');
    // The winner confirms and holds. Its change is invisible to the loser's
    // early read, which is exactly what makes this a check-then-act.
    await confirmer.query(
      "UPDATE customer_sales_orders SET status='confirmed' WHERE id=$1", [order]);

    let settled = false;
    const attempt = als.run(ctxFor(editor), () => updateSalesOrder(company, order, editInput));
    attempt.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((r) => setTimeout(r, HOLD_MS));
    // Parked on the header UPDATE, having already passed the 'draft' read.
    expect.soft(settled).toBe(false);

    await confirmer.query('COMMIT');
    result = await attempt;
    await editor.query('COMMIT');
  } finally {
    confirmer.release(); editor.release();
  }

  expect.soft(result).toBeNull();
  // The lines are the ORIGINAL ones — not deleted, not replaced.
  expect.soft(await lineDescriptions(order)).toEqual(['Original line']);
  const header = await pool.query(
    'SELECT status, order_date, total_amount FROM customer_sales_orders WHERE id=$1', [order]);
  expect.soft(header.rows[0].status).toBe('confirmed');
  expect(Number(header.rows[0].total_amount)).toBeCloseTo(1150, 2);
});

it('still edits an order that really is draft', async () => {
  const order = await seedDraftOrder();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await als.run(ctxFor(client), () => updateSalesOrder(company, order, editInput));
    await client.query('COMMIT');
    expect.soft(updated).not.toBeNull();
  } finally { client.release(); }

  expect.soft(await lineDescriptions(order)).toEqual(['Rewritten line']);
  const header = await pool.query('SELECT total_amount FROM customer_sales_orders WHERE id=$1', [order]);
  // 2 x 500 + 15% = 1150, and the header foots against the one line.
  expect(Number(header.rows[0].total_amount)).toBeCloseTo(1150, 2);
});

it('will not edit another tenant\'s order', async () => {
  const otherCompany = crypto.randomUUID();
  const theirs = crypto.randomUUID();
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [otherCompany, 'K107 R5 SO other']);
  const theirCustomer = crypto.randomUUID();
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [theirCustomer, otherCompany, 'other']);
  await pool.query(
    `INSERT INTO customer_sales_orders(id,company_id,order_number,customer_id,order_date,
                                       subtotal,tax_amount,total_amount,status,created_by)
     VALUES($1,$2,$3,$4,'2026-04-01',1000,150,1150,'draft',$5)`,
    [theirs, otherCompany, `K107R5-SO-OTHER-${theirs.slice(0, 8)}`, theirCustomer, user]);
  await pool.query(
    `INSERT INTO customer_sales_order_items(sales_order_id,line_number,description,quantity,unit_price,tax_rate,line_total)
     VALUES($1,1,'Their line',1,1000,15,1000)`, [theirs]);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    expect.soft(await als.run(ctxFor(client), () => updateSalesOrder(company, theirs, editInput))).toBeNull();
    await client.query('COMMIT');
  } finally { client.release(); }
  expect(await lineDescriptions(theirs)).toEqual(['Their line']);

  await pool.query('DELETE FROM customer_sales_order_items WHERE sales_order_id=$1', [theirs]);
  await pool.query('DELETE FROM customer_sales_orders WHERE company_id=$1', [otherCompany]);
  await pool.query('DELETE FROM customers WHERE company_id=$1', [otherCompany]);
  await pool.query('DELETE FROM companies WHERE id=$1', [otherCompany]);
});

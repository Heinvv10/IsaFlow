/**
 * Converting a quote or a sales order (Hein, 2026-11-06): the draft invoice is dated today, in South Africa, and its due
 * date runs from that under the customer's terms, else the company default. The quote and the order keep their own dates:
 * they record when the quote was given and the order taken.
 *
 * The clock is 00:30 on 1 Dec in South Africa, still 30 Nov in UTC, and the documents are dated 1 Sep. So a due date worked
 * from the document's date, or from the UTC day, lands on a different date from the one asserted. Only Date is faked: the
 * pool's timers still run.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { als } from '../../src/lib/als';
import { convertToInvoice } from '../../src/modules/accounting/services/ar/quoteConvertService';
import { convertSalesOrderToInvoice } from '../../src/modules/accounting/services/ar/salesOrderWorkflowService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser } from './r035-approval.helpers';
import { cleanupPr4, invoiceCompany } from './r035-pr4.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let user = '';

beforeAll(async () => { user = await createUser(pool, tokens); });
afterAll(() => cleanupPr4(pool, companies, [user]));
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-30T22:30:00Z') }); });
afterEach(() => { vi.useRealTimers(); });

async function inRequest<T>(c: string, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run({ client, userId: user, companyId: c, claims: { sub: user } } as never, fn);
    await client.query('COMMIT');
    return out;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function fixture(days: number | null, type: string | null): Promise<{ c: string; customer: string }> {
  const c = await invoiceCompany(pool, [[user, 'admin']], companies);
  const { rows } = await pool.query(
    `INSERT INTO customers(company_id,name,payment_terms,payment_terms_type) VALUES($1,'Converted',$2,$3) RETURNING id`, [c, days, type]);
  return { c, customer: rows[0].id as string };
}

async function acceptedQuote(c: string, customer: string): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO customer_quotes(company_id,quote_number,client_id,quote_date,status,subtotal,tax_rate,tax_amount,total,created_by)
     VALUES($1,$2,$3,DATE '2026-09-01','accepted',1000,15,150,1150,$4) RETURNING id`, [c, `Q-${crypto.randomUUID().slice(0, 8)}`, customer, user]);
  const id = rows[0].id as string;
  await pool.query(
    `INSERT INTO customer_quote_lines(quote_id,description,quantity,unit_price,tax_rate,amount,sort_order)
     VALUES($1,'Consulting',1,1000,15,1000,1)`, [id]);
  return id;
}

async function confirmedOrder(c: string, customer: string): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO customer_sales_orders(company_id,order_number,customer_id,order_date,subtotal,tax_amount,total_amount,status,created_by)
     VALUES($1,$2,$3,DATE '2026-09-01',1000,150,1150,'confirmed',$4) RETURNING id`, [c, `SO-${crypto.randomUUID().slice(0, 8)}`, customer, user]);
  const id = rows[0].id as string;
  await pool.query(
    `INSERT INTO customer_sales_order_items(sales_order_id,line_number,description,quantity,unit_price,tax_rate,line_total)
     VALUES($1,1,'Consulting',1,1000,15,1000)`, [id]);
  return id;
}

async function datesOf(invoiceId: string): Promise<{ invoice: string; due: string; status: string }> {
  const { rows } = await pool.query(
    'SELECT invoice_date::TEXT AS invoice, due_date::TEXT AS due, status FROM customer_invoices WHERE id = $1', [invoiceId]);
  return rows[0] as { invoice: string; due: string; status: string };
}

const fromQuote = async (c: string, customer: string) => {
  const id = await acceptedQuote(c, customer);
  const out = await inRequest(c, () => convertToInvoice(c, id, user));
  const { rows } = await pool.query('SELECT quote_date::TEXT AS d FROM customer_quotes WHERE id = $1', [id]);
  return { invoiceId: out!.invoiceId, sourceDate: rows[0].d as string };
};
const fromOrder = async (c: string, customer: string) => {
  const id = await confirmedOrder(c, customer);
  const out = await inRequest(c, () => convertSalesOrderToInvoice(c, id, user));
  const { rows } = await pool.query('SELECT order_date::TEXT AS d FROM customer_sales_orders WHERE id = $1', [id]);
  return { invoiceId: out.invoiceId, sourceDate: rows[0].d as string };
};

describe.each([['quote', fromQuote], ['sales order', fromOrder]] as const)('converting a %s', (_name, convert) => {
  it("dates the draft invoice today in South Africa; the due date follows the customer's terms from today", async () => {
    const { c, customer } = await fixture(3, 'statement_months');
    const { invoiceId, sourceDate } = await convert(c, customer);
    expect(await datesOf(invoiceId)).toEqual({ invoice: '2026-12-01', due: '2027-03-31', status: 'draft' });
    expect(sourceDate).toBe('2026-09-01');
  });

  it('a customer with no terms set: the company default runs from today', async () => {
    const { c, customer } = await fixture(null, null);
    const { invoiceId } = await convert(c, customer);
    expect(await datesOf(invoiceId)).toEqual({ invoice: '2026-12-01', due: '2026-12-31', status: 'draft' });
  });
});

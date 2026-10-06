/**
 * R-035 PR4 review F1, conversions: an invoice converted from someone else's
 * quote or sales order carries that content's authors — its creator, the
 * editors stamped on it, and those of the quote behind an order — so they
 * cannot approve it while another eligible approver exists. Time: an entry
 * carries the authors STAMPED on it (r035-pr4-time-authors); its user_id alone
 * — a practice logger, whose rate came from the tables — makes nobody an
 * author (Hein, 2026-10-06, decision 1).
 *
 * DERIVED, not stamped onto the invoice: approval_document_authors'
 * customer_invoice branch (migration 865) reads them through the link each
 * converter already writes — customer_quotes.converted_invoice_id,
 * customer_sales_orders.invoice_id (and .quote_id), time_entries.invoice_id —
 * so the converting services are unchanged. Each case converts as one user
 * (the runner, an admin) content another wrote (the author, an owner), and a
 * second owner approves. Editors: r035-pr4-editors.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '../../src/lib/als';
import customerQuotes from '../../pages/api/accounting/customer-quotes';
import customerQuotesAction from '../../pages/api/accounting/customer-quotes-action';
import timeEntriesInvoice from '../../pages/api/accounting/time-entries-invoice';
import { convertSalesOrderToInvoice } from '../../src/modules/accounting/services/ar/salesOrderWorkflowService';
import { generateWipInvoice } from '../../src/modules/accounting/services/practice/practiceWipService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantRule } from './r035-approval.helpers';
import { dataOf, messageOf } from './r035-pr2.helpers';
import { cleanupPr4, enforceInvoices, invoiceCompany, invoiceRoutes } from './r035-pr4.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
/** runner: admin who converts; author: owner who wrote the content; other: a second owner; clerk: a bookkeeper. */
const u = { runner: '', author: '', other: '', clerk: '' };
const r = invoiceRoutes(tokens);

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(() => cleanupPr4(pool, companies, Object.values(u)));

async function fixture(): Promise<{ c: string; customer: string }> {
  const c = await invoiceCompany(pool,
    [[u.runner, 'admin'], [u.author, 'owner'], [u.other, 'owner'], [u.clerk, 'bookkeeper']], companies);
  await plantRule(pool, c, 'owner', { documentType: 'customer_invoice', operator: 'greater_than', value: 500 });
  await enforceInvoices(pool, c, u.other);
  const customer = crypto.randomUUID();
  await pool.query("INSERT INTO customers(id,company_id,name) VALUES($1,$2,'R035 conversion')", [customer, c]);
  return { c, customer };
}

const as = (user: string, c: string, handler: never, body: unknown, url: string) =>
  callRoute(handler, tokens[user]!, c, 'POST', body, url);
/** What the decide path refuses: approval_document_authors, the one definition. */
const authorsOf = async (c: string, invoiceId: string) => ((await pool.query(
  "SELECT approval_document_authors($1,'customer_invoice',$2)::TEXT[] AS a", [c, invoiceId])).rows[0].a as string[]).sort();
const storedAuthors = async (invoiceId: string) => (await pool.query(
  'SELECT content_authors::TEXT[] AS a FROM customer_invoices WHERE id = $1', [invoiceId])).rows[0].a as string[];

async function inRequest<T>(c: string, user: string, fn: () => Promise<T>): Promise<T> {
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

/** The runner raises; the author is refused 403 as an author; the other owner approves. */
async function authorRefusedOtherApproves(c: string, invoiceId: string): Promise<void> {
  const raised = await r.raise(u.runner, c, invoiceId);
  expect(raised.state.statusCode, JSON.stringify(raised.state.body)).toBe(200);
  const requestId = dataOf<{ id: string }>(raised).id;
  const refused = await r.decide(pool, u.author, c, requestId);
  expect(refused.state.statusCode, JSON.stringify(refused.state.body)).toBe(403);
  expect(messageOf(refused)).toMatch(/you authored the content/);
  expect((await r.decide(pool, u.other, c, requestId)).state.statusCode).toBe(200);
}

async function timeEntry(c: string, loggedBy: string, extra: { status?: string; practiceClientId?: string } = {}): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO time_entries(id,company_id,user_id,task_description,entry_date,hours,rate,billable,invoiced,status,
       practice_client_id,applied_rate,line_total,origin)
     VALUES($1,$2,$3,'Fieldwork',DATE '2026-09-01',4,250,true,false,$4,$5,250,1000,'manual')`,
    [id, c, loggedBy, extra.status ?? 'draft', extra.practiceClientId ?? null]);
  return id;
}

describe('conversions — the source author may not approve what another user converted', () => {
  it('quote → invoice', async () => {
    const { c, customer } = await fixture();
    const quote = dataOf<{ id: string }>(await as(u.author, c, customerQuotes as never, {
      clientId: customer, quoteDate: '2026-09-01', lines: [{ description: 'Build', quantity: 1, unitPrice: 100_000, taxRate: 15 }],
    }, '/api/accounting/customer-quotes'));
    await as(u.runner, c, customerQuotesAction as never, { id: quote.id, action: 'accept' }, '/api/accounting/customer-quotes-action');
    const converted = await as(u.runner, c, customerQuotesAction as never, { id: quote.id, action: 'convert' },
      '/api/accounting/customer-quotes-action');
    expect(converted.state.statusCode, JSON.stringify(converted.state.body)).toBe(200);
    const invoiceId = dataOf<{ invoiceId: string }>(converted).invoiceId;
    expect(await storedAuthors(invoiceId)).toEqual([]); // derived, not written
    expect(await authorsOf(c, invoiceId)).toEqual([u.runner, u.author].sort());
    await authorRefusedOtherApproves(c, invoiceId);
  });

  it('sales order → invoice', async () => {
    const { c, customer } = await fixture();
    const order = crypto.randomUUID();
    await pool.query(
      `INSERT INTO customer_sales_orders(id,company_id,order_number,customer_id,order_date,subtotal,tax_amount,total_amount,status,created_by)
       VALUES($1,$2,$3,$4,DATE '2026-09-01',1000,150,1150,'confirmed',$5)`, [order, c, `SO-${order.slice(0, 6)}`, customer, u.author]);
    await pool.query(
      `INSERT INTO customer_sales_order_items(sales_order_id,description,quantity,unit_price,tax_rate,line_total)
       VALUES($1,'Goods',1,1000,15,1000)`, [order]);
    const { invoiceId } = await inRequest(c, u.runner, () => convertSalesOrderToInvoice(c, order, u.runner));
    expect(await authorsOf(c, invoiceId)).toEqual([u.runner, u.author].sort());
    await authorRefusedOtherApproves(c, invoiceId);
  });

  it("quote → sales order → invoice: the quote's author, behind the order someone else created", async () => {
    const { c, customer } = await fixture();
    const quote = crypto.randomUUID();
    await pool.query(
      `INSERT INTO customer_quotes(id,company_id,quote_number,client_id,quote_date,subtotal,tax_amount,total,status,created_by)
       VALUES($1,$2,$3,$4,DATE '2026-09-01',1000,150,1150,'converted_to_order',$5)`, [quote, c, `Q-${quote.slice(0, 6)}`, customer, u.author]);
    const order = crypto.randomUUID();
    await pool.query(
      `INSERT INTO customer_sales_orders(id,company_id,order_number,customer_id,quote_id,order_date,subtotal,tax_amount,total_amount,
         status,created_by)
       VALUES($1,$2,$3,$4,$5,DATE '2026-09-01',1000,150,1150,'confirmed',$6)`, [order, c, `SO-${order.slice(0, 6)}`, customer, quote, u.clerk]);
    await pool.query(
      `INSERT INTO customer_sales_order_items(sales_order_id,description,quantity,unit_price,tax_rate,line_total)
       VALUES($1,'Goods',1,1000,15,1000)`, [order]);
    const { invoiceId } = await inRequest(c, u.runner, () => convertSalesOrderToInvoice(c, order, u.runner));
    expect(await authorsOf(c, invoiceId)).toEqual([u.runner, u.author, u.clerk].sort());
    await authorRefusedOtherApproves(c, invoiceId);
  });

  it("a sales order whose quote_id names another company's quote adds no quote author", async () => {
    const { c, customer } = await fixture();
    const foreign = await fixture();
    const quote = crypto.randomUUID();
    await pool.query(
      `INSERT INTO customer_quotes(id,company_id,quote_number,client_id,quote_date,subtotal,tax_amount,total,status,created_by)
       VALUES($1,$2,$3,$4,DATE '2026-09-01',1,0,1,'converted_to_order',$5)`, [quote, foreign.c, `Q-${quote.slice(0, 6)}`, foreign.customer, u.author]);
    const order = crypto.randomUUID();
    await pool.query(
      `INSERT INTO customer_sales_orders(id,company_id,order_number,customer_id,quote_id,order_date,subtotal,tax_amount,total_amount,
         status,created_by)
       VALUES($1,$2,$3,$4,$5,DATE '2026-09-01',1000,150,1150,'confirmed',$6)`, [order, c, `SO-${order.slice(0, 6)}`, customer, quote, u.clerk]);
    await pool.query(
      `INSERT INTO customer_sales_order_items(sales_order_id,description,quantity,unit_price,tax_rate,line_total)
       VALUES($1,'Goods',1,1000,15,1000)`, [order]);
    const { invoiceId } = await inRequest(c, u.runner, () => convertSalesOrderToInvoice(c, order, u.runner));
    expect(await authorsOf(c, invoiceId)).toEqual([u.runner, u.clerk].sort());
  });

  it("time entries → invoice: an entry's user_id alone (no stamp) makes nobody an author (decision 1)", async () => {
    const { c, customer } = await fixture();
    const ids = [await timeEntry(c, u.author), await timeEntry(c, u.author)];
    const res = await as(u.runner, c, timeEntriesInvoice as never, { timeEntryIds: ids, customerId: customer },
      '/api/accounting/time-entries-invoice');
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(201);
    const invoiceId = dataOf<{ invoiceId: string }>(res).invoiceId;
    expect(await authorsOf(c, invoiceId)).toEqual([u.runner]);
    // The logger, an owner, may approve the invoice of the time they logged; a rate EDITOR may not (r035-pr4-editors).
    const requestId = dataOf<{ id: string }>(await r.raise(u.runner, c, invoiceId)).id;
    expect((await r.decide(pool, u.author, c, requestId)).state.statusCode).toBe(200);
  });

  it('WIP billing → invoice: a re-pricing editor through the time_entries link, never the loggers', async () => {
    const { c, customer } = await fixture();
    const practiceClientId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO practice_clients(id,company_id,legal_name,billing_model,status,link_customer_id)
       VALUES($1,$2,'R035 practice client','hourly','active',$3)`, [practiceClientId, c, customer]);
    const ids = [await timeEntry(c, u.author, { status: 'approved', practiceClientId }),
      await timeEntry(c, u.other, { status: 'approved', practiceClientId })];
    await pool.query('UPDATE time_entries SET content_authors = ARRAY[$2::UUID] WHERE id = $1', [ids[1], u.clerk]);
    const out = await inRequest(c, u.runner, () => generateWipInvoice(c, u.runner, { practiceClientId, timeEntryIds: ids }));
    expect(await authorsOf(c, out.invoiceId)).toEqual([u.runner, u.clerk].sort());
  });

  it("another company's link names nobody here", async () => {
    const { c, customer } = await fixture();
    const other = await fixture();
    const invoiceId = (await as(u.runner, c, timeEntriesInvoice as never,
      { timeEntryIds: [await timeEntry(c, u.runner)], customerId: customer }, '/api/accounting/time-entries-invoice')).state;
    const id = (invoiceId.body as { data: { invoiceId: string } }).data.invoiceId;
    // A row in ANOTHER company pointing at this invoice is no source of it.
    await pool.query(
      `INSERT INTO customer_quotes(company_id,quote_number,client_id,quote_date,subtotal,tax_amount,total,status,created_by,converted_invoice_id)
       VALUES($1,'Q-FOREIGN',$2,DATE '2026-09-01',1,0,1,'converted',$3,$4)`, [other.c, other.customer, u.author, id]);
    expect(await authorsOf(c, id)).toEqual([u.runner]);
  });
});

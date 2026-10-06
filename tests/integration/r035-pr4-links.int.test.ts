/**
 * R-035 PR4 round 2 (REPRO B): a conversion's authors are derived from the
 * link the source keeps to its invoice, so that link must not move.
 *
 *  - A converted quote is terminal: it cannot be re-accepted (or sent or
 *    declined) and converted again, which re-pointed converted_invoice_id at a
 *    throwaway invoice and dropped the quote's author from the first one.
 *  - An invoiced sales order cannot be invoiced again; a billed time entry
 *    cannot be billed again (both pinned, already true).
 *  - Q2: the only owner, who authored the quote another member converted, may
 *    still approve the invoice through the sole-approver route.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import customerQuotes from '../../pages/api/accounting/customer-quotes';
import quoteAction from '../../pages/api/accounting/customer-quotes-action';
import salesOrders from '../../pages/api/accounting/customer-sales-orders';
import salesOrderAction from '../../pages/api/accounting/customer-sales-orders-action';
import timeEntries from '../../pages/api/accounting/time-entries';
import timeEntriesInvoice from '../../pages/api/accounting/time-entries-invoice';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantRule } from './r035-approval.helpers';
import { dataOf } from './r035-pr2.helpers';
import { cleanupPr4, enforceInvoices, invoiceCompany, invoiceRoutes } from './r035-pr4.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { alice: '', bob: '', sole: '', clerk: '' };
const r = invoiceRoutes(tokens);

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(() => cleanupPr4(pool, companies, Object.values(u)));

/** alice: admin (creator / converter / requester); bob: owner (the rule's rank). Owner rule over R1 000. */
async function fixture(members: [string, string][] = [[u.alice, 'admin'], [u.bob, 'owner']]) {
  const c = await invoiceCompany(pool, members, companies);
  await plantRule(pool, c, 'owner', { documentType: 'customer_invoice', operator: 'greater_than', value: 1000 });
  await enforceInvoices(pool, c, members.find(([, role]) => role === 'owner')![0]);
  const customer = crypto.randomUUID();
  await pool.query("INSERT INTO customers(id,company_id,name) VALUES($1,$2,'R035 links')", [customer, c]);
  return { c, customer };
}

const call = (h: never, user: string, c: string, method: string, body: Record<string, unknown>, url: string) =>
  callRoute(h, tokens[user]!, c, method, body, url);
const ok = <T>(res: Awaited<ReturnType<typeof callRoute>>): T => {
  expect([200, 201], JSON.stringify(res.state.body)).toContain(res.state.statusCode);
  return dataOf<T>(res);
};
const newQuote = async (user: string, c: string, customer: string, price: number) => ok<{ id: string }>(await call(
  customerQuotes as never, user, c, 'POST', { customerName: 'R035 links', clientId: customer,
    lines: [{ description: 'Consulting', quantity: 1, unitPrice: price, taxRate: 15 }] }, '/api/accounting/customer-quotes')).id;
const quoteDo = (user: string, c: string, id: string, action: string) =>
  call(quoteAction as never, user, c, 'POST', { id, action }, '/api/accounting/customer-quotes-action');
const quoteRow = async (id: string) => (await pool.query(
  'SELECT status, converted_invoice_id, converted_order_id FROM customer_quotes WHERE id = $1', [id])).rows[0];

describe('a converted quote is terminal (REPRO B)', () => {
  it('bob authors, alice converts; bob cannot re-accept or re-convert, and stays an author of the first invoice', async () => {
    const { c, customer } = await fixture();
    const quoteId = await newQuote(u.bob, c, customer, 100_000);
    ok(await quoteDo(u.alice, c, quoteId, 'accept'));
    const first = ok<{ invoiceId: string }>(await quoteDo(u.alice, c, quoteId, 'convert')).invoiceId;
    for (const action of ['accept', 'send', 'decline']) {
      const res = await quoteDo(u.bob, c, quoteId, action);
      expect(res.state.statusCode, `${action}: ${JSON.stringify(res.state.body)}`).toBe(409);
    }
    expect((await quoteDo(u.bob, c, quoteId, 'convert')).state.statusCode).toBe(409);
    expect((await quoteDo(u.bob, c, quoteId, 'convert-to-order')).state.statusCode).toBe(409);
    expect(await quoteRow(quoteId)).toMatchObject({ status: 'converted', converted_invoice_id: first, converted_order_id: null });

    const requestId = ok<{ id: string }>(await r.raise(u.alice, c, first)).id;
    expect((await r.decide(pool, u.bob, c, requestId)).state.statusCode).toBe(403);
  });

  it('a quote converted to an order cannot be re-accepted or converted to an invoice', async () => {
    const { c, customer } = await fixture();
    const quoteId = await newQuote(u.bob, c, customer, 100_000);
    ok(await quoteDo(u.alice, c, quoteId, 'accept'));
    const orderId = ok<{ salesOrderId: string }>(await quoteDo(u.alice, c, quoteId, 'convert-to-order')).salesOrderId;
    expect((await quoteDo(u.bob, c, quoteId, 'accept')).state.statusCode).toBe(409);
    expect((await quoteDo(u.bob, c, quoteId, 'convert')).state.statusCode).toBe(409);
    expect(await quoteRow(quoteId)).toMatchObject({ status: 'converted_to_order', converted_order_id: orderId, converted_invoice_id: null });
  });

  it('even forced back to accepted, a quote holding a conversion link converts no second time', async () => {
    const { c, customer } = await fixture();
    const toInvoice = await newQuote(u.bob, c, customer, 100_000);
    ok(await quoteDo(u.alice, c, toInvoice, 'accept'));
    ok(await quoteDo(u.alice, c, toInvoice, 'convert'));
    const toOrder = await newQuote(u.bob, c, customer, 100_000);
    ok(await quoteDo(u.alice, c, toOrder, 'accept'));
    ok(await quoteDo(u.alice, c, toOrder, 'convert-to-order'));
    await pool.query("UPDATE customer_quotes SET status = 'accepted' WHERE id = ANY($1)", [[toInvoice, toOrder]]);
    for (const id of [toInvoice, toOrder]) {
      expect((await quoteDo(u.bob, c, id, 'convert')).state.statusCode, `convert ${id}`).toBe(409);
      expect((await quoteDo(u.bob, c, id, 'convert-to-order')).state.statusCode, `convert-to-order ${id}`).toBe(409);
    }
  });

  it('a quote that is not converted still moves between its open statuses', async () => {
    const { c, customer } = await fixture();
    const quoteId = await newQuote(u.alice, c, customer, 100);
    ok(await quoteDo(u.alice, c, quoteId, 'send'));
    ok(await quoteDo(u.alice, c, quoteId, 'decline'));
    ok(await quoteDo(u.alice, c, quoteId, 'accept'));
    expect((await quoteRow(quoteId)).status).toBe('accepted');
  });
});

describe('the other links do not move (pins)', () => {
  it('an invoiced sales order cannot be invoiced again; its invoice link stands', async () => {
    const { c, customer } = await fixture();
    const orderId = ok<{ id: string }>(await call(salesOrders as never, u.bob, c, 'POST',
      { customer_id: customer, items: [{ description: 'Goods', quantity: 1, unit_price: 100 }] }, '/api/accounting/customer-sales-orders')).id;
    ok(await call(salesOrderAction as never, u.alice, c, 'POST', { id: orderId, action: 'confirm' }, '/api/accounting/customer-sales-orders-action'));
    const { invoiceId } = ok<{ invoiceId: string }>(await call(salesOrderAction as never, u.alice, c, 'POST',
      { id: orderId, action: 'invoice' }, '/api/accounting/customer-sales-orders-action'));
    const again = await call(salesOrderAction as never, u.bob, c, 'POST', { id: orderId, action: 'invoice' }, '/api/accounting/customer-sales-orders-action');
    expect(again.state.statusCode).toBe(409);
    expect((await pool.query('SELECT invoice_id FROM customer_sales_orders WHERE id = $1', [orderId])).rows[0].invoice_id).toBe(invoiceId);
  });

  it('a billed time entry cannot be billed again; its invoice link stands', async () => {
    const { c, customer } = await fixture();
    const entry = ok<{ id: string }>(await call(timeEntries as never, u.alice, c, 'POST',
      { taskDescription: 'Advice', hours: 1, rate: 100, billable: true, customerId: customer }, '/api/accounting/time-entries')).id;
    const bill = () => call(timeEntriesInvoice as never, u.alice, c, 'POST', { timeEntryIds: [entry], customerId: customer },
      '/api/accounting/time-entries-invoice');
    const { invoiceId } = ok<{ invoiceId: string }>(await bill());
    expect((await bill()).state.statusCode).toBe(400);
    // Nor can its price be edited once billed.
    expect((await call(timeEntries as never, u.bob, c, 'PUT', { id: entry, rate: 5 }, '/api/accounting/time-entries')).state.statusCode)
      .toBe(400);
    expect((await pool.query('SELECT invoice_id, rate::FLOAT8 AS rate FROM time_entries WHERE id = $1', [entry])).rows[0])
      .toEqual({ invoice_id: invoiceId, rate: 100 });
  });
});

describe('Q2 sole approver with a derived author', () => {
  it("the only owner authored the quote; after rejecting the clerk's request and raising their own, they may approve", async () => {
    const { c, customer } = await fixture([[u.sole, 'owner'], [u.clerk, 'admin']]);
    const quoteId = await newQuote(u.sole, c, customer, 100_000);
    ok(await quoteDo(u.clerk, c, quoteId, 'accept'));
    const { invoiceId } = ok<{ invoiceId: string }>(await quoteDo(u.clerk, c, quoteId, 'convert'));
    const clerkReq = ok<{ id: string }>(await r.raise(u.clerk, c, invoiceId)).id;
    expect((await r.decide(pool, u.sole, c, clerkReq)).state.statusCode).toBe(403);
    expect((await r.decide(pool, u.sole, c, clerkReq, 'reject')).state.statusCode).toBe(200);
    const own = ok<{ id: string }>(await r.raise(u.sole, c, invoiceId)).id;
    const decided = await r.decide(pool, u.sole, c, own);
    expect(decided.state.statusCode, JSON.stringify(decided.state.body)).toBe(200);
  });
});

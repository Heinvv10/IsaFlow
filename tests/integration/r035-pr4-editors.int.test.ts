/**
 * R-035 PR4 round 2 (Hein, 2026-10-06, decision 2): whoever SETS THE PRICE
 * upstream of a customer invoice is one of its authors — the creator of the
 * quote or sales order it came from (derived from created_by), and every user
 * whose EDIT changed what they bill (customer_quotes / customer_sales_orders
 * .content_authors, stamped only on a content-changing update, never at
 * creation). Time entries: r035-pr4-time-authors.
 *
 * Each case: someone other than the converter edits the price, the converter
 * converts and raises, and the editor is refused 403 while another owner of
 * the rule's rank exists. An edit that changes nothing billed stamps nobody.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import customerQuotes from '../../pages/api/accounting/customer-quotes';
import quoteAction from '../../pages/api/accounting/customer-quotes-action';
import salesOrders from '../../pages/api/accounting/customer-sales-orders';
import salesOrderAction from '../../pages/api/accounting/customer-sales-orders-action';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantRule } from './r035-approval.helpers';
import { dataOf, messageOf } from './r035-pr2.helpers';
import { cleanupPr4, enforceInvoices, invoiceCompany, invoiceRoutes } from './r035-pr4.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
/** alice: admin who creates and converts; bob: owner who edits the price; carol: a second owner. */
const u = { alice: '', bob: '', carol: '' };
const r = invoiceRoutes(tokens);

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(() => cleanupPr4(pool, companies, Object.values(u)));

async function fixture() {
  const c = await invoiceCompany(pool, [[u.alice, 'admin'], [u.bob, 'owner'], [u.carol, 'owner']], companies);
  await plantRule(pool, c, 'owner', { documentType: 'customer_invoice', operator: 'greater_than', value: 1000 });
  await enforceInvoices(pool, c, u.carol);
  const customer = crypto.randomUUID();
  await pool.query("INSERT INTO customers(id,company_id,name) VALUES($1,$2,'R035 editors')", [customer, c]);
  return { c, customer };
}

const call = (h: never, user: string, c: string, method: string, body: Record<string, unknown>, url: string) =>
  callRoute(h, tokens[user]!, c, method, body, url);
const ok = <T>(res: Awaited<ReturnType<typeof callRoute>>): T => {
  expect([200, 201], JSON.stringify(res.state.body)).toContain(res.state.statusCode);
  return dataOf<T>(res);
};
const authorsOf = async (c: string, invoiceId: string) => ((await pool.query(
  "SELECT approval_document_authors($1,'customer_invoice',$2)::TEXT[] AS a", [c, invoiceId])).rows[0].a as string[]).sort();
const stamped = async (table: string, id: string) => (await pool.query(
  `SELECT content_authors::TEXT[] AS a FROM ${table} WHERE id = $1`, [id])).rows[0].a as string[];

/** alice raises; bob is refused 403 as an author; carol approves. */
async function bobRefusedCarolApproves(c: string, invoiceId: string): Promise<void> {
  const requestId = ok<{ id: string }>(await r.raise(u.alice, c, invoiceId)).id;
  const refused = await r.decide(pool, u.bob, c, requestId);
  expect(refused.state.statusCode, JSON.stringify(refused.state.body)).toBe(403);
  expect(messageOf(refused)).toMatch(/you authored the content/);
  expect((await r.decide(pool, u.carol, c, requestId)).state.statusCode).toBe(200);
}

const quoteLines = (price: number) => [{ description: 'Consulting', quantity: 1, unitPrice: price, taxRate: 15 }];

describe('a quote editor (REPRO A)', () => {
  it("bob re-prices alice's draft quote; alice converts and raises; bob may not approve", async () => {
    const { c, customer } = await fixture();
    const quoteId = ok<{ id: string }>(await call(customerQuotes as never, u.alice, c, 'POST',
      { customerName: 'R035', clientId: customer, lines: quoteLines(100) }, '/api/accounting/customer-quotes')).id;
    expect(await stamped('customer_quotes', quoteId)).toEqual([]); // nothing written at creation
    // Notes only: nothing billed changes, nobody is stamped.
    ok(await call(customerQuotes as never, u.carol, c, 'PUT',
      { id: quoteId, customerName: 'R035', clientId: customer, lines: quoteLines(100), notes: 'thanks' }, '/api/accounting/customer-quotes'));
    expect(await stamped('customer_quotes', quoteId)).toEqual([]);
    ok(await call(customerQuotes as never, u.bob, c, 'PUT',
      { id: quoteId, customerName: 'R035', clientId: customer, lines: quoteLines(100_000) }, '/api/accounting/customer-quotes'));
    expect(await stamped('customer_quotes', quoteId)).toEqual([u.bob]);
    ok(await call(quoteAction as never, u.alice, c, 'POST', { id: quoteId, action: 'accept' }, '/api/accounting/customer-quotes-action'));
    const { invoiceId } = ok<{ invoiceId: string }>(await call(quoteAction as never, u.alice, c, 'POST',
      { id: quoteId, action: 'convert' }, '/api/accounting/customer-quotes-action'));
    expect(await authorsOf(c, invoiceId)).toEqual([u.alice, u.bob].sort());
    await bobRefusedCarolApproves(c, invoiceId);
  });
});

describe('a quote editor behind a sales order', () => {
  it("bob re-prices alice's quote; alice turns it into an order, confirms and invoices; bob is an author", async () => {
    const { c, customer } = await fixture();
    const quoteId = ok<{ id: string }>(await call(customerQuotes as never, u.alice, c, 'POST',
      { customerName: 'R035', clientId: customer, lines: quoteLines(100) }, '/api/accounting/customer-quotes')).id;
    ok(await call(customerQuotes as never, u.bob, c, 'PUT',
      { id: quoteId, customerName: 'R035', clientId: customer, lines: quoteLines(100_000) }, '/api/accounting/customer-quotes'));
    ok(await call(quoteAction as never, u.alice, c, 'POST', { id: quoteId, action: 'accept' }, '/api/accounting/customer-quotes-action'));
    const { salesOrderId } = ok<{ salesOrderId: string }>(await call(quoteAction as never, u.alice, c, 'POST',
      { id: quoteId, action: 'convert-to-order' }, '/api/accounting/customer-quotes-action'));
    ok(await call(salesOrderAction as never, u.alice, c, 'POST', { id: salesOrderId, action: 'confirm' }, '/api/accounting/customer-sales-orders-action'));
    const { invoiceId } = ok<{ invoiceId: string }>(await call(salesOrderAction as never, u.alice, c, 'POST',
      { id: salesOrderId, action: 'invoice' }, '/api/accounting/customer-sales-orders-action'));
    expect(await authorsOf(c, invoiceId)).toEqual([u.alice, u.bob].sort());
    await bobRefusedCarolApproves(c, invoiceId);
  });
});

describe('a sales-order editor', () => {
  it("bob re-prices alice's draft order; alice confirms, invoices and raises; bob may not approve", async () => {
    const { c, customer } = await fixture();
    const items = (price: number) => [{ description: 'Goods', quantity: 1, unit_price: price, tax_rate: 15 }];
    const orderId = ok<{ id: string }>(await call(salesOrders as never, u.alice, c, 'POST',
      { customer_id: customer, items: items(100) }, '/api/accounting/customer-sales-orders')).id;
    ok(await call(salesOrders as never, u.carol, c, 'PUT',
      { id: orderId, customer_id: customer, items: items(100), notes: 'x' }, '/api/accounting/customer-sales-orders'));
    expect(await stamped('customer_sales_orders', orderId)).toEqual([]);
    ok(await call(salesOrders as never, u.bob, c, 'PUT',
      { id: orderId, customer_id: customer, items: items(100_000) }, '/api/accounting/customer-sales-orders'));
    expect(await stamped('customer_sales_orders', orderId)).toEqual([u.bob]);
    ok(await call(salesOrderAction as never, u.alice, c, 'POST', { id: orderId, action: 'confirm' }, '/api/accounting/customer-sales-orders-action'));
    const { invoiceId } = ok<{ invoiceId: string }>(await call(salesOrderAction as never, u.alice, c, 'POST',
      { id: orderId, action: 'invoice' }, '/api/accounting/customer-sales-orders-action'));
    expect(await authorsOf(c, invoiceId)).toEqual([u.alice, u.bob].sort());
    await bobRefusedCarolApproves(c, invoiceId);
  });
});

describe('the customer merge', () => {
  it("re-pointing a draft quote's and order's customer makes the merging user an author of each", async () => {
    const { c, customer } = await fixture();
    const target = crypto.randomUUID();
    await pool.query("INSERT INTO customers(id,company_id,name) VALUES($1,$2,'R035 merge target')", [target, c]);
    const quoteId = ok<{ id: string }>(await call(customerQuotes as never, u.alice, c, 'POST',
      { customerName: 'R035', clientId: customer, lines: quoteLines(100) }, '/api/accounting/customer-quotes')).id;
    const orderId = ok<{ id: string }>(await call(salesOrders as never, u.alice, c, 'POST',
      { customer_id: customer, items: [{ description: 'Goods', quantity: 1, unit_price: 100 }] }, '/api/accounting/customer-sales-orders')).id;
    expect((await r.merge(u.bob, c, customer, target)).state.statusCode).toBe(200);
    expect(await stamped('customer_quotes', quoteId)).toEqual([u.bob]);
    expect(await stamped('customer_sales_orders', orderId)).toEqual([u.bob]);
  });
});

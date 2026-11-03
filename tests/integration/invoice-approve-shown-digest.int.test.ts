/**
 * PR S round eleven: the digest Approve sends back covers what the invoice shows beyond the approval digest (notes,
 * due date, billing period), every reply that hands the page an invoice carries it, and the route requires it with
 * `expectedTotal`. Through the real routes:
 * - create → approve with the digest the create returned: 200; the same after a draft PUT, and after a GET;
 * - notes, due date or billing period changed after it was shown: 409 STALE_VIEW saying the content changed (not the
 *   total), nothing written; a changed total still names the total;
 * - `expectedTotal` without `expectedContentDigest` (a page from before the digest): 409
 *   INVOICE_APPROVE_VIEW_INCOMPLETE, "reload", nothing written. No `expectedTotal` at all: approved as before.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import customerInvoicesCreate from '../../pages/api/accounting/customer-invoices-create';
import customerInvoicesDetail from '../../pages/api/accounting/customer-invoices-detail';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, reasonOf } from './r035-approval.helpers';
import { messageOf } from './r035-pr2.helpers';
import { cleanupPr4, invoiceCompany, invoiceState, plantInvoice } from './r035-pr4.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let owner = '';
let company = '';
const URL = '/api/accounting/customer-invoices-detail';

const call = (method: string, body: unknown, query: Record<string, string> = {}) =>
  callRoute(customerInvoicesDetail, tokens[owner]!, company, method, body, URL, query);
const approve = (body: Record<string, unknown>) => call('POST', { action: 'approve', ...body });
const dataOf = <T>(res: { state: { body: unknown } }) => (res.state.body as { data: T }).data;
const seen = async (id: string) => dataOf<{ approval_content_digest: string }>(await call('GET', undefined, { id })).approval_content_digest;
const codeOf = (res: { state: { body: unknown } }) => (res.state.body as { error?: { details?: { code?: string } } }).error?.details?.code;

beforeAll(async () => {
  owner = await createUser(pool, tokens);
  company = await invoiceCompany(pool, [[owner, 'owner']], companies);
}, 60_000);
afterAll(async () => { await cleanupPr4(pool, companies, [owner]); });

describe('every reply that hands the page an invoice carries the digest Approve sends back', () => {
  it('create, then approve with the digest the create returned: approved', async () => {
    const customer = crypto.randomUUID();
    await pool.query('INSERT INTO customers(id, company_id, name) VALUES($1, $2, $3)', [customer, company, 'shown digest']);
    const made = await callRoute(customerInvoicesCreate, tokens[owner]!, company, 'POST', {
      clientId: customer, invoiceDate: '2026-09-01', dueDate: '2026-10-01', notes: 'Pay by EFT',
      items: [{ description: 'Created', quantity: 1, unitPrice: 100 }],
    }, '/api/accounting/customer-invoices-create');
    expect(made.state.statusCode, JSON.stringify(made.state.body)).toBe(201);
    const { id, approvalContentDigest } = dataOf<{ id: string; approvalContentDigest: string }>(made);
    expect(approvalContentDigest).toMatch(/^[0-9a-f]{64}$/);
    const total = Number((await pool.query('SELECT total_amount FROM customer_invoices WHERE id = $1', [id])).rows[0].total_amount);
    const res = await approve({ id, expectedTotal: total, expectedContentDigest: approvalContentDigest });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  });

  it('a draft PUT, then approve with the digest the PUT returned: approved', async () => {
    const inv = await plantInvoice(pool, company, owner);
    const put = await call('PUT', { id: inv.id, notes: 'Edited', items: [{ description: 'Line A', quantity: 2, unitPrice: 300, taxRate: 15 }] });
    expect(put.state.statusCode, JSON.stringify(put.state.body)).toBe(200);
    const res = await approve({ id: inv.id, expectedTotal: 690, expectedContentDigest: dataOf<{ approvalContentDigest: string }>(put).approvalContentDigest });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  });

  it('a GET, then approve with the digest it carried: approved', async () => {
    const inv = await plantInvoice(pool, company, owner);
    expect((await approve({ id: inv.id, expectedTotal: 1150, expectedContentDigest: await seen(inv.id) })).state.statusCode).toBe(200);
  });
});

describe('what the invoice shows beyond the approval digest', () => {
  it.each([
    ['notes', 'notes = \'Changed after it was shown\''],
    ['the due date', 'due_date = DATE \'2026-12-31\''],
    ['the billing period start', 'billing_period_start = DATE \'2026-08-01\''],
    ['the billing period end', 'billing_period_end = DATE \'2026-08-31\''],
  ])('%s changed after it was shown: 409 STALE_VIEW saying the content changed, not the total; nothing written', async (_name, set) => {
    const inv = await plantInvoice(pool, company, owner);
    const digest = await seen(inv.id);
    await pool.query(`UPDATE customer_invoices SET ${set} WHERE id = $1`, [inv.id]);
    const before = (await pool.query('SELECT * FROM customer_invoices WHERE id = $1', [inv.id])).rows[0];
    const res = await approve({ id: inv.id, expectedTotal: 1150, expectedContentDigest: digest });
    expect(res.state.statusCode).toBe(409);
    expect(reasonOf(res)).toBe('STALE_VIEW');
    expect(messageOf(res)).toMatch(/changed after it was shown/);
    expect(messageOf(res)).not.toMatch(/total/);
    expect((await pool.query('SELECT * FROM customer_invoices WHERE id = $1', [inv.id])).rows[0]).toEqual(before);
    expect(await invoiceState(pool, inv.id)).toMatchObject({ status: 'draft', journals: 0 });
  });

  it('a mismatched digest at the stored total still names nothing about the total; a changed total names it', async () => {
    const inv = await plantInvoice(pool, company, owner);
    const wrong = await approve({ id: inv.id, expectedTotal: 1150, expectedContentDigest: 'f'.repeat(64) });
    expect(wrong.state.statusCode).toBe(409);
    expect(messageOf(wrong)).not.toMatch(/total/);
    const total = await approve({ id: inv.id, expectedTotal: 999, expectedContentDigest: await seen(inv.id) });
    expect(messageOf(total)).toMatch(/its total is now R\s?1\s?150\.00/);
  });
});

describe('the route requires the digest with the total', () => {
  it('expectedTotal without expectedContentDigest: 409 INVOICE_APPROVE_VIEW_INCOMPLETE, reload, nothing written', async () => {
    const inv = await plantInvoice(pool, company, owner);
    const res = await approve({ id: inv.id, expectedTotal: 1150 });
    expect(res.state.statusCode).toBe(409);
    expect(codeOf(res)).toBe('INVOICE_APPROVE_VIEW_INCOMPLETE');
    expect(messageOf(res)).toMatch(/reload/i);
    expect(await invoiceState(pool, inv.id)).toMatchObject({ status: 'draft', journals: 0 });
  });

  it('no expectedTotal at all (an API client without a screen): approved as before', async () => {
    const inv = await plantInvoice(pool, company, owner);
    expect((await approve({ id: inv.id })).state.statusCode).toBe(200);
  });
});

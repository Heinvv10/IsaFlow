/**
 * PR S rounds eleven to fourteen: the shown digest (`shown_digest`) is the hash of the model the PDF renders
 * (invoicePdfModel: header, lines, the customer and the issuing company as printed, bank details, terms, totals,
 * notes, dates, the job) with the approval digest, so anything printed is in it by construction; every reply that hands the page an invoice carries it, the
 * route requires it with any `expected*` field, and a draft PUT that sends `expectedShownDigest` is refused (409
 * STALE_VIEW, nothing written) when the invoice moved since that read. Through the real routes:
 * - create → approve with the digest the create returned: 200; the same after a draft PUT, and after a GET;
 * - notes, due date or billing period changed after it was shown: 409 STALE_VIEW saying the content changed (not the
 *   total), nothing written; a changed total still names the total;
 * - any `expected*` without `expectedContentDigest` (a page from before the digest): 409
 *   INVOICE_APPROVE_VIEW_INCOMPLETE, "reload", nothing written. None at all: approved as before;
 * - tab A reads, tab B sets the due date, A's line edit (with A's digest): 409 STALE_VIEW, nothing written.
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
const seen = async (id: string) => dataOf<{ shown_digest: string }>(await call('GET', undefined, { id })).shown_digest;
/** Every field the shown digest reads beyond the approval digest, set (non-null) on a planted invoice. */
async function everyShownField(id: string): Promise<void> {
  const project = (await pool.query(
    `INSERT INTO projects (company_id, project_number, name) VALUES ($1, $2, 'Shown job') RETURNING id`, [company, `P-${id.slice(0, 8)}`])).rows[0].id;
  await pool.query(`UPDATE customer_invoices SET notes = 'Pay by EFT', due_date = DATE '2026-10-15',
    billing_period_start = DATE '2026-08-01', billing_period_end = DATE '2026-08-31', project_id = $2 WHERE id = $1`, [id, project]);
}
const codeOf = (res: { state: { body: unknown } }) => (res.state.body as { error?: { details?: { code?: string } } }).error?.details?.code;

beforeAll(async () => {
  owner = await createUser(pool, tokens);
  company = await invoiceCompany(pool, [[owner, 'owner']], companies);
}, 60_000);
afterAll(async () => {
  await pool.query('UPDATE customer_invoices SET project_id = NULL WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM projects WHERE company_id = ANY($1)', [companies]);
  await cleanupPr4(pool, companies, [owner]);
});

describe('every reply that hands the page an invoice carries the digest Approve sends back', () => {
  it('create, then approve with the digest the create returned: approved', async () => {
    const customer = crypto.randomUUID();
    await pool.query('INSERT INTO customers(id, company_id, name) VALUES($1, $2, $3)', [customer, company, 'shown digest']);
    const made = await callRoute(customerInvoicesCreate, tokens[owner]!, company, 'POST', {
      clientId: customer, invoiceDate: '2026-09-01', dueDate: '2026-10-01', notes: 'Pay by EFT',
      items: [{ description: 'Created', quantity: 1, unitPrice: 100 }],
    }, '/api/accounting/customer-invoices-create');
    expect(made.state.statusCode, JSON.stringify(made.state.body)).toBe(201);
    const { id, shownDigest } = dataOf<{ id: string; shownDigest: string }>(made);
    expect(shownDigest).toMatch(/^[0-9a-f]{64}$/);
    const total = Number((await pool.query('SELECT total_amount FROM customer_invoices WHERE id = $1', [id])).rows[0].total_amount);
    const res = await approve({ id, expectedTotal: total, expectedContentDigest: shownDigest });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  });

  it('every shown field set (notes, due date, both period dates, a job): a draft PUT, then approve with the digest it returned', async () => {
    const inv = await plantInvoice(pool, company, owner);
    await everyShownField(inv.id);
    const put = await call('PUT', { id: inv.id, notes: 'Edited', expectedShownDigest: await seen(inv.id),
      items: [{ description: 'Line A', quantity: 2, unitPrice: 300, taxRate: 15 }] });
    expect(put.state.statusCode, JSON.stringify(put.state.body)).toBe(200);
    const res = await approve({ id: inv.id, expectedTotal: 690, expectedContentDigest: dataOf<{ shownDigest: string }>(put).shownDigest });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  });

  it('every shown field set: a GET, then approve with the digest it carried', async () => {
    const inv = await plantInvoice(pool, company, owner);
    await everyShownField(inv.id);
    expect((await approve({ id: inv.id, expectedTotal: 1150, expectedContentDigest: await seen(inv.id) })).state.statusCode).toBe(200);
  });
});

describe('what the invoice shows beyond the approval digest', () => {
  it.each([
    ['name', 'Changed customer'],
    ['billing_address', 'Changed customer address'],
    ['contact_person', 'Changed contact'],
    ['email', 'changed-customer@example.test'],
    ['phone', '+27 11 555 0101'],
    ['vat_number', '4123456789'],
  ])('the customer %s changed after it was shown: 409 STALE_VIEW', async (column, value) => {
    const inv = await plantInvoice(pool, company, owner);
    const digest = await seen(inv.id);
    await pool.query(`UPDATE customers SET ${column} = $2 WHERE id = $1`, [inv.customerId, value]);
    const res = await approve({ id: inv.id, expectedTotal: 1150, expectedContentDigest: digest });
    expect(res.state.statusCode).toBe(409);
    expect(reasonOf(res)).toBe('STALE_VIEW');
    expect(await invoiceState(pool, inv.id)).toMatchObject({ status: 'draft', journals: 0 });
  });

  it.each([
    ['name', 'Changed issuer'],
    ['address_line1', 'Changed issuer address'],
    ['address_line2', 'Changed issuer address line 2'],
    ['city', 'Changed city'],
    ['province', 'Changed province'],
    ['postal_code', '9999'],
    ['email', 'changed-issuer@example.test'],
    ['phone', '+27 11 555 0102'],
    ['vat_number', '4987654321'],
    ['logo_data', 'data:image/png;base64,Y2hhbmdlZA=='],
    ['primary_color', '#123456'],
    ['bank_name', 'Changed Bank'],
    ['bank_account_number', '62000000001'],
    ['bank_branch_code', '250655'],
  ])('the company %s changed after it was shown: 409 STALE_VIEW', async (column, value) => {
    const inv = await plantInvoice(pool, company, owner);
    const digest = await seen(inv.id);
    await pool.query(`UPDATE companies SET ${column} = $2 WHERE id = $1`, [company, value]);
    const res = await approve({ id: inv.id, expectedTotal: 1150, expectedContentDigest: digest });
    expect(res.state.statusCode).toBe(409);
    expect(reasonOf(res)).toBe('STALE_VIEW');
    expect(await invoiceState(pool, inv.id)).toMatchObject({ status: 'draft', journals: 0 });
  });

  it.each([
    ['a line\'s description', `UPDATE customer_invoice_items SET description = 'Changed line' WHERE invoice_id = $1 AND description = 'Line A'`],
    ['the invoice number', `UPDATE customer_invoices SET invoice_number = invoice_number || '-X' WHERE id = $1`],
  ])('%s changed after it was shown: 409 STALE_VIEW', async (_name, change) => {
    const inv = await plantInvoice(pool, company, owner);
    const digest = await seen(inv.id);
    await pool.query(change, [inv.id]);
    const res = await approve({ id: inv.id, expectedTotal: 1150, expectedContentDigest: digest });
    expect(res.state.statusCode).toBe(409);
    expect(reasonOf(res)).toBe('STALE_VIEW');
  });

  it('nothing printed changed, but something not printed did (the invoice was viewed, emailed): approved', async () => {
    const inv = await plantInvoice(pool, company, owner);
    const digest = await seen(inv.id);
    await pool.query(`UPDATE customer_invoices SET updated_at = NOW() + INTERVAL '1 minute', email_sent_at = NOW() WHERE id = $1`, [inv.id]);
    const res = await approve({ id: inv.id, expectedTotal: 1150, expectedContentDigest: digest });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  });

  it('the job\'s name changed after it was shown (the PDF prints it): 409 STALE_VIEW', async () => {
    const inv = await plantInvoice(pool, company, owner);
    await everyShownField(inv.id);
    const digest = await seen(inv.id);
    await pool.query(`UPDATE projects SET name = 'Renamed job' WHERE id = (SELECT project_id FROM customer_invoices WHERE id = $1)`, [inv.id]);
    const res = await approve({ id: inv.id, expectedTotal: 1150, expectedContentDigest: digest });
    expect(res.state.statusCode).toBe(409);
    expect(reasonOf(res)).toBe('STALE_VIEW');
  });

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
  it.each([
    ['expectedTotal', { expectedTotal: 1150 }],
    ['expectedCurrency', { expectedCurrency: 'ZAR' }],
    ['expectedExchangeRate', { expectedExchangeRate: 1 }],
  ])('%s without expectedContentDigest: 409 INVOICE_APPROVE_VIEW_INCOMPLETE, reload, nothing written', async (_name, expected) => {
    const inv = await plantInvoice(pool, company, owner);
    const res = await approve({ id: inv.id, ...expected });
    expect(res.state.statusCode).toBe(409);
    expect(codeOf(res)).toBe('INVOICE_APPROVE_VIEW_INCOMPLETE');
    expect(messageOf(res)).toMatch(/reload/i);
    expect(await invoiceState(pool, inv.id)).toMatchObject({ status: 'draft', journals: 0 });
  });

  it('no expected* at all (an API client without a screen): approved as before', async () => {
    const inv = await plantInvoice(pool, company, owner);
    expect((await approve({ id: inv.id })).state.statusCode).toBe(200);
  });
});

describe('a draft PUT and the invoice it was edited from', () => {
  it('tab A reads; tab B sets the due date; A\'s line edit with A\'s digest: 409 STALE_VIEW, nothing written', async () => {
    const inv = await plantInvoice(pool, company, owner);
    const a = await seen(inv.id);
    const b = await call('PUT', { id: inv.id, dueDate: '2026-12-31', expectedShownDigest: await seen(inv.id) });
    expect(b.state.statusCode, JSON.stringify(b.state.body)).toBe(200);
    const before = {
      invoice: (await pool.query('SELECT * FROM customer_invoices WHERE id = $1', [inv.id])).rows[0],
      lines: (await pool.query('SELECT * FROM customer_invoice_items WHERE invoice_id = $1 ORDER BY id', [inv.id])).rows,
    };
    const res = await call('PUT', { id: inv.id, expectedShownDigest: a, items: [{ description: 'A\'s edit', quantity: 1, unitPrice: 100, taxRate: 15 }] });
    expect(res.state.statusCode).toBe(409);
    expect(reasonOf(res)).toBe('STALE_VIEW');
    expect({
      invoice: (await pool.query('SELECT * FROM customer_invoices WHERE id = $1', [inv.id])).rows[0],
      lines: (await pool.query('SELECT * FROM customer_invoice_items WHERE invoice_id = $1 ORDER BY id', [inv.id])).rows,
    }).toEqual(before);
  });

  it('a PUT with the current digest is taken, and its reply carries the next one', async () => {
    const inv = await plantInvoice(pool, company, owner);
    const first = await call('PUT', { id: inv.id, notes: 'One', expectedShownDigest: await seen(inv.id) });
    expect(first.state.statusCode).toBe(200);
    const second = await call('PUT', { id: inv.id, notes: 'Two', expectedShownDigest: dataOf<{ shownDigest: string }>(first).shownDigest });
    expect(second.state.statusCode, JSON.stringify(second.state.body)).toBe(200);
  });

  it('a PUT without expectedShownDigest (an API client without a screen) is taken as before', async () => {
    const inv = await plantInvoice(pool, company, owner);
    expect((await call('PUT', { id: inv.id, notes: 'API' })).state.statusCode).toBe(200);
  });
});

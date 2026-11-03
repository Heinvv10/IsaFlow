/**
 * PR S round sixteen (review M1): an invoice's lines come back in the order they were entered, in the detail GET, the
 * PDF model (what the PDF prints) and so the PDF, after a create and after a draft PUT (an autosave). Lines written in
 * one transaction all had created_at = NOW(), so every read ordered a tie: by a random UUID in the model (round
 * fifteen's `created_at, id`), by heap order elsewhere. Create and the draft PUT now stamp each line with
 * clock_timestamp(), so created_at itself is the entry order; every read orders by created_at.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import customerInvoicesCreate from '../../pages/api/accounting/customer-invoices-create';
import customerInvoicesDetail from '../../pages/api/accounting/customer-invoices-detail';
import { loadInvoicePdfModel } from '@/modules/accounting/services/ar/invoicePdfModel';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { cleanupPr4, invoiceCompany } from './r035-pr4.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let owner = '';
let company = '';
const ENTERED = ['A first', 'B second', 'C third', 'D fourth', 'E fifth', 'F sixth'];
const lines = (suffix = '') => ENTERED.map((description, i) => ({ description: description + suffix, quantity: 1, unitPrice: 10 + i, taxRate: 15 }));

/** The order each reader gives, and whether created_at itself is strictly the entry order. */
async function orders(id: string) {
  const got = await callRoute(customerInvoicesDetail, tokens[owner]!, company, 'GET', undefined, '/api/accounting/customer-invoices-detail', { id });
  const detail = (got.state.body as { data: { items: { description: string }[] } }).data.items.map((l) => l.description);
  const model = (await loadInvoicePdfModel(company, id))!.items.map((l) => String(l.description));
  // In microseconds, as stored: a JS Date would round two distinct stamps to the same millisecond.
  const stamps = (await pool.query(
    `SELECT description, (extract(epoch FROM created_at) * 1000000)::BIGINT::TEXT AS us FROM customer_invoice_items WHERE invoice_id = $1`, [id])).rows as
    { description: string; us: string }[];
  const byEntry = [...stamps].sort((a, b) => ENTERED.findIndex((e) => a.description.startsWith(e)) - ENTERED.findIndex((e) => b.description.startsWith(e)));
  const increasing = byEntry.every((r, i) => i === 0 || BigInt(r.us) > BigInt(byEntry[i - 1]!.us));
  return { detail, model, increasing };
}

beforeAll(async () => {
  owner = await createUser(pool, tokens);
  company = await invoiceCompany(pool, [[owner, 'owner']], companies);
}, 60_000);
afterAll(async () => { await cleanupPr4(pool, companies, [owner]); });

describe('lines come back in the order they were entered', () => {
  it('after a create, then after a draft PUT: the GET, the PDF model and created_at agree with the entry order', async () => {
    const customer = crypto.randomUUID();
    await pool.query('INSERT INTO customers(id, company_id, name) VALUES($1, $2, $3)', [customer, company, 'line order']);
    const made = await callRoute(customerInvoicesCreate, tokens[owner]!, company, 'POST',
      { clientId: customer, invoiceDate: '2026-09-01', items: lines() }, '/api/accounting/customer-invoices-create');
    expect(made.state.statusCode, JSON.stringify(made.state.body)).toBe(201);
    const id = (made.state.body as { data: { id: string } }).data.id;
    expect(await orders(id)).toEqual({ detail: ENTERED, model: ENTERED, increasing: true });

    const put = await callRoute(customerInvoicesDetail, tokens[owner]!, company, 'PUT',
      { id, invoiceDate: '2026-09-01', taxRate: 15, items: lines(' (edited)') }, '/api/accounting/customer-invoices-detail');
    expect(put.state.statusCode, JSON.stringify(put.state.body)).toBe(200);
    const edited = ENTERED.map((d) => `${d} (edited)`);
    const after = await orders(id);
    expect(after).toEqual({ detail: edited, model: edited, increasing: true });
  });
});

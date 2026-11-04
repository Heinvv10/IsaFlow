/**
 * PR S round sixteen (review M1): an invoice's lines come back in the order they were entered, in the detail GET, the
 * PDF model (what the PDF prints) and so the PDF, after a create and after a draft PUT (an autosave). Lines written in
 * one transaction all have created_at = NOW(), so every read ordered a tie: by a random UUID in the model, by heap
 * order elsewhere. Create and the draft PUT write each line's index in the submitted array to line_position (migration
 * 956); both reads order by line_position NULLS LAST, created_at, id. created_at stays NOW(): the approval digest
 * (874) orders lines by created_at and then content, so it must not depend on the entry order, and a reorder moves
 * what the PDF prints (the shown digest) and not what posts (the approval digest).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import customerInvoicesCreate from '../../pages/api/accounting/customer-invoices-create';
import customerInvoicesDetail from '../../pages/api/accounting/customer-invoices-detail';
import portalInvoice from '../../pages/api/portal/invoice/[token]';
import { loadInvoicePdfModel } from '@/modules/accounting/services/ar/invoicePdfModel';
import { storedInvoiceLinesRefusal } from '@/modules/accounting/services/ar/invoiceLineCodingGuard';
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

/** The order each reader gives, and whether line_position is each line's index in the order entered. */
async function orders(id: string) {
  const got = await callRoute(customerInvoicesDetail, tokens[owner]!, company, 'GET', undefined, '/api/accounting/customer-invoices-detail', { id });
  const detail = (got.state.body as { data: { items: { description: string }[] } }).data.items.map((l) => l.description);
  const model = (await loadInvoicePdfModel(company, id))!.items.map((l) => String(l.description));
  const stored = (await pool.query(
    'SELECT description, line_position FROM customer_invoice_items WHERE invoice_id = $1', [id])).rows as { description: string; line_position: number | null }[];
  const positioned = stored.every((r) => r.line_position === ENTERED.findIndex((e) => r.description.startsWith(e)));
  return { detail, model, positioned };
}

beforeAll(async () => {
  owner = await createUser(pool, tokens);
  company = await invoiceCompany(pool, [[owner, 'owner']], companies);
}, 60_000);
afterAll(async () => { await cleanupPr4(pool, companies, [owner]); });

describe('lines come back in the order they were entered', () => {
  it('after a create, then after a draft PUT: the GET, the PDF model and line_position agree with the entry order', async () => {
    const customer = crypto.randomUUID();
    await pool.query('INSERT INTO customers(id, company_id, name) VALUES($1, $2, $3)', [customer, company, 'line order']);
    const made = await callRoute(customerInvoicesCreate, tokens[owner]!, company, 'POST',
      { clientId: customer, invoiceDate: '2026-09-01', items: lines() }, '/api/accounting/customer-invoices-create');
    expect(made.state.statusCode, JSON.stringify(made.state.body)).toBe(201);
    const id = (made.state.body as { data: { id: string } }).data.id;
    expect(await orders(id)).toEqual({ detail: ENTERED, model: ENTERED, positioned: true });

    const put = await callRoute(customerInvoicesDetail, tokens[owner]!, company, 'PUT',
      { id, invoiceDate: '2026-09-01', taxRate: 15, items: lines(' (edited)') }, '/api/accounting/customer-invoices-detail');
    expect(put.state.statusCode, JSON.stringify(put.state.body)).toBe(200);
    const edited = ENTERED.map((d) => `${d} (edited)`);
    const after = await orders(id);
    expect(after).toEqual({ detail: edited, model: edited, positioned: true });
  });

  it('a legacy invoice whose lines tie on created_at and have no line_position: the PDF model and the GET agree', async () => {
    const customer = crypto.randomUUID();
    await pool.query('INSERT INTO customers(id, company_id, name) VALUES($1, $2, $3)', [customer, company, 'legacy order']);
    const made = await callRoute(customerInvoicesCreate, tokens[owner]!, company, 'POST',
      { clientId: customer, invoiceDate: '2026-09-01', items: lines() }, '/api/accounting/customer-invoices-create');
    const id = (made.state.body as { data: { id: string } }).data.id;
    await pool.query('UPDATE customer_invoice_items SET created_at = $2, line_position = NULL WHERE invoice_id = $1', [id, '2026-09-01T10:00:00Z']); // as written before 956
    const { detail, model } = await orders(id);
    expect(model).toEqual(detail);
  });

  it('a draft PUT that only reorders the lines: the PDF prints the new order, the shown digest moves, the approval digest does not', async () => {
    const customer = crypto.randomUUID();
    await pool.query('INSERT INTO customers(id, company_id, name) VALUES($1, $2, $3)', [customer, company, 'reorder']);
    // Created F..A, then put A..F: entered against the digest's content order, so an approval digest that followed the
    // entry order (created_at stamped per line) would differ between the two.
    const made = await callRoute(customerInvoicesCreate, tokens[owner]!, company, 'POST',
      { clientId: customer, invoiceDate: '2026-09-01', items: lines().reverse() }, '/api/accounting/customer-invoices-create');
    expect(made.state.statusCode, JSON.stringify(made.state.body)).toBe(201);
    const id = (made.state.body as { data: { id: string } }).data.id;
    const digests = async () => {
      const got = await callRoute(customerInvoicesDetail, tokens[owner]!, company, 'GET', undefined, '/api/accounting/customer-invoices-detail', { id });
      const approval = (await pool.query(`SELECT approval_document_digest($1::UUID, 'customer_invoice', $2::UUID) AS d`, [company, id])).rows[0]!.d as string;
      return { shown: (got.state.body as { data: { shown_digest: string } }).data.shown_digest, approval };
    };
    const before = await digests();

    expect((await loadInvoicePdfModel(company, id))!.items.map((l) => String(l.description))).toEqual([...ENTERED].reverse());
    const put = await callRoute(customerInvoicesDetail, tokens[owner]!, company, 'PUT',
      { id, invoiceDate: '2026-09-01', taxRate: 15, items: lines() }, '/api/accounting/customer-invoices-detail');
    expect(put.state.statusCode, JSON.stringify(put.state.body)).toBe(200);
    const printed = (await loadInvoicePdfModel(company, id))!.items.map((l) => String(l.description));
    expect(printed).toEqual(ENTERED);
    const after = await digests();
    expect(after.approval).toBe(before.approval);
    expect(after.shown).not.toBe(before.shown);
  });

  it('the customer portal lists the lines in the order the PDF prints them, by line_position before created_at', async () => {
    const customer = crypto.randomUUID();
    await pool.query('INSERT INTO customers(id, company_id, name) VALUES($1, $2, $3)', [customer, company, 'portal order']);
    const made = await callRoute(customerInvoicesCreate, tokens[owner]!, company, 'POST',
      { clientId: customer, invoiceDate: '2026-09-01', items: lines() }, '/api/accounting/customer-invoices-create');
    const id = (made.state.body as { data: { id: string } }).data.id;
    const put = await callRoute(customerInvoicesDetail, tokens[owner]!, company, 'PUT',
      { id, invoiceDate: '2026-09-01', taxRate: 15, items: lines().reverse() }, '/api/accounting/customer-invoices-detail');
    expect(put.state.statusCode, JSON.stringify(put.state.body)).toBe(200);
    // created_at made to disagree with the position (one tie from NOW() leaves the order to the plan): only an order by
    // line_position first lists the lines as entered.
    await pool.query(`UPDATE customer_invoice_items SET created_at = '2026-09-01T10:00:00Z'::TIMESTAMPTZ + line_position * INTERVAL '-1 second'
                      WHERE invoice_id = $1`, [id]);
    const token = randomBytes(32).toString('hex');
    await pool.query('UPDATE customer_invoices SET portal_token = $2 WHERE id = $1', [id, token]);
    const got = await callRoute(portalInvoice, '', company, 'GET', undefined, `/api/portal/invoice/${token}`, { token });
    expect(got.state.statusCode, JSON.stringify(got.state.body)).toBe(200);
    const portal = (got.state.body as { data: { items: { description: string }[] } }).data.items.map((l) => l.description);
    const printed = (await loadInvoicePdfModel(company, id))!.items.map((l) => String(l.description));
    expect(portal).toEqual([...ENTERED].reverse());
    expect(portal).toEqual(printed);
  });

  it('an approve refusal names the line by its printed position', async () => {
    const fno = String((await pool.query(
      "INSERT INTO cost_centres(company_id, code, name, cc_type, is_active) VALUES($1, 'FNO-ORD', 'FNO line order', 'cc1', true) RETURNING id",
      [company])).rows[0]!.id);
    const customer = crypto.randomUUID();
    await pool.query('INSERT INTO customers(id, company_id, name) VALUES($1, $2, $3)', [customer, company, 'refusal order']);
    const made = await callRoute(customerInvoicesCreate, tokens[owner]!, company, 'POST',
      { clientId: customer, invoiceDate: '2026-09-01', items: lines() }, '/api/accounting/customer-invoices-create');
    expect(made.state.statusCode, JSON.stringify(made.state.body)).toBe(201);
    const id = (made.state.body as { data: { id: string } }).data.id;
    try {
      // The customer gains an FNO after the save; every line carries it but the one printed second.
      await pool.query('UPDATE customers SET default_cc1_id = $2 WHERE id = $1', [customer, fno]);
      await pool.query('UPDATE customer_invoice_items SET cc1_id = CASE WHEN line_position = 1 THEN NULL ELSE $2::UUID END WHERE invoice_id = $1', [id, fno]);
      // created_at made to run against the position (it ties in practice, leaving the order to the random line id).
      await pool.query(`UPDATE customer_invoice_items SET created_at = '2026-09-01T10:00:00Z'::TIMESTAMPTZ + line_position * INTERVAL '-1 second'
                        WHERE invoice_id = $1`, [id]);
      expect(await storedInvoiceLinesRefusal(company, id, { lock: false })).toMatch(/\bline 2 carries no CC1/);
    } finally {
      await pool.query('UPDATE customer_invoice_items SET cc1_id = NULL WHERE invoice_id = $1', [id]);
      await pool.query('UPDATE customers SET default_cc1_id = NULL WHERE id = $1', [customer]);
      await pool.query('DELETE FROM cost_centres WHERE id = $1', [fno]);
    }
  });
});

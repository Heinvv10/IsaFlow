/**
 * Payment-terms programme, Part A: editing a draft's invoice date (a customer invoice's customer too) re-dates a due
 * date that came from terms, on the server, through the real routes. A manual / document / legacy date is never moved;
 * a due date the edit names that differs from the stored one and from the terms' is kept (and recorded manual); one
 * the edit re-sends, or the terms' own, re-dates and stays `terms`. One history row per save.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import arRoute from '../../pages/api/accounting/customer-invoices-detail';
import apRoute from '../../pages/api/accounting/supplier-invoices-detail';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute } from './r035-approval.helpers';
import { messageOf } from './r035-pr2.helpers';
import { changesOf, cleanupEntityChanges, members, newCompany } from './entity-changes.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let admin = '';

beforeAll(async () => { [admin] = await members(pool, tokens, 1); });
afterAll(async () => {
  await pool.query('DELETE FROM customer_invoices WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM supplier_invoices WHERE company_id = ANY($1)', [companies]);
  await cleanupEntityChanges(pool, companies, [admin]); // ends the pool
});

const company = () => newCompany(pool, [[admin, 'admin']], companies);
type Terms = [number | null, string | null];

async function customer(c: string, [n, type]: Terms): Promise<string> {
  const { rows } = await pool.query('INSERT INTO customers(company_id, name, payment_terms, payment_terms_type) VALUES($1,$2,$3,$4) RETURNING id',
    [c, `Cust ${crypto.randomUUID().slice(0, 6)}`, n, type]);
  return rows[0].id as string;
}
async function supplier(c: string, [n, type]: Terms): Promise<string> {
  const { rows } = await pool.query('INSERT INTO suppliers(company_id, name, payment_terms, payment_terms_type) VALUES($1,$2,$3,$4) RETURNING id',
    [c, `Sup ${crypto.randomUUID().slice(0, 6)}`, n, type]);
  return rows[0].id as string;
}
async function draftInvoice(c: string, cust: string, source: string, due = '2026-10-16', status = 'draft'): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO customer_invoices(company_id, invoice_number, customer_id, client_id, invoice_date, due_date, due_date_source,
       subtotal, tax_amount, total_amount, status, created_by)
     VALUES($1,$2,$3,$3,DATE '2026-09-16',$4,$5,100,15,115,$6,$7) RETURNING id`,
    [c, `RD-${crypto.randomUUID().slice(0, 8)}`, cust, due, source, status, admin]);
  return rows[0].id as string;
}
async function draftBill(c: string, sup: string, source: string, opts: { due?: string; status?: string; terms?: string | null } = {}): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO supplier_invoices(company_id, invoice_number, supplier_id, invoice_date, due_date, due_date_source, payment_terms,
       subtotal, tax_amount, total_amount, status, created_by)
     VALUES($1,$2,$3,DATE '2026-09-16',$4,$5,$6,1000,150,1150,$7,$8) RETURNING id`,
    [c, `RB-${crypto.randomUUID().slice(0, 8)}`, sup, opts.due ?? '2026-10-16', source, opts.terms ?? null, opts.status ?? 'draft', admin]);
  return rows[0].id as string;
}
const putAr = (c: string, body: Record<string, unknown>) => callRoute(arRoute, tokens[admin]!, c, 'PUT', body, '/api/accounting/customer-invoices-detail');
const putAp = (c: string, body: Record<string, unknown>) => callRoute(apRoute, tokens[admin]!, c, 'PUT', body, '/api/accounting/supplier-invoices-detail');
const stored = async (table: 'customer_invoices' | 'supplier_invoices', id: string) =>
  (await pool.query(`SELECT to_char(invoice_date,'YYYY-MM-DD') AS i, to_char(due_date,'YYYY-MM-DD') AS d, due_date_source AS s FROM ${table} WHERE id=$1`, [id])).rows[0] as { i: string; d: string; s: string };

const THIRTY: Terms = [30, 'invoice_days'];

describe('a customer invoice draft', () => {
  it.each([
    ['names no due date', {}],
    ['re-sends the stored due date', { dueDate: '2026-10-16' }],
    ['sends the recalculated due date back', { dueDate: '2026-10-31' }],
  ])('a terms-sourced draft whose invoice date moves is re-dated by the customer\'s terms (edit %s)', async (_n, extra) => {
    const c = await company();
    const id = await draftInvoice(c, await customer(c, THIRTY), 'terms');
    const res = await putAr(c, { id, invoiceDate: '2026-10-01', ...extra });
    expect(res.state.statusCode, messageOf(res)).toBe(200);
    expect(await stored('customer_invoices', id)).toEqual({ i: '2026-10-01', d: '2026-10-31', s: 'terms' });
    const history = await changesOf(pool, id);
    expect(history).toHaveLength(1);
    expect(history[0]!.after).toMatchObject({ due_date: '2026-10-31', due_date_source: 'terms' });
  });

  it('a due date the edit names that is neither the stored one nor the terms\' stays, and is manual', async () => {
    const c = await company();
    const id = await draftInvoice(c, await customer(c, THIRTY), 'terms');
    expect((await putAr(c, { id, invoiceDate: '2026-10-01', dueDate: '2026-12-01' })).state.statusCode).toBe(200);
    expect(await stored('customer_invoices', id)).toEqual({ i: '2026-10-01', d: '2026-12-01', s: 'manual' });
  });

  it.each(['manual', 'document', 'legacy'])('a %s due date does not move with the invoice date', async (source) => {
    const c = await company();
    const id = await draftInvoice(c, await customer(c, THIRTY), source);
    expect((await putAr(c, { id, invoiceDate: '2026-10-01', dueDate: '2026-10-16' })).state.statusCode).toBe(200);
    expect(await stored('customer_invoices', id)).toEqual({ i: '2026-10-01', d: '2026-10-16', s: source });
    expect(await changesOf(pool, id)).toHaveLength(0);
  });

  it('an edit that moves neither the date nor the customer leaves a terms-sourced date alone', async () => {
    const c = await company();
    const id = await draftInvoice(c, await customer(c, THIRTY), 'terms', '2026-11-20'); // not what the terms give
    expect((await putAr(c, { id, notes: 'hello', invoiceDate: '2026-09-16', dueDate: '2026-11-20' })).state.statusCode).toBe(200);
    expect(await stored('customer_invoices', id)).toEqual({ i: '2026-09-16', d: '2026-11-20', s: 'terms' });
  });

  it('a change of customer re-dates a terms-sourced draft by the NEW customer\'s terms', async () => {
    const c = await company();
    const id = await draftInvoice(c, await customer(c, THIRTY), 'terms');
    const other = await customer(c, [3, 'statement_months']);
    expect((await putAr(c, { id, clientId: other, invoiceDate: '2026-09-16' })).state.statusCode).toBe(200);
    expect(await stored('customer_invoices', id)).toEqual({ i: '2026-09-16', d: '2026-12-31', s: 'terms' });
  });

  it('a change of customer does not move a manual date', async () => {
    const c = await company();
    const id = await draftInvoice(c, await customer(c, THIRTY), 'manual');
    expect((await putAr(c, { id, clientId: await customer(c, [3, 'statement_months']) })).state.statusCode).toBe(200);
    expect(await stored('customer_invoices', id)).toEqual({ i: '2026-09-16', d: '2026-10-16', s: 'manual' });
  });

  it('a customer with no terms is dated by the company default (30 days from invoice)', async () => {
    const c = await company();
    const id = await draftInvoice(c, await customer(c, [null, null]), 'terms');
    expect((await putAr(c, { id, invoiceDate: '2026-10-05' })).state.statusCode).toBe(200);
    expect(await stored('customer_invoices', id)).toEqual({ i: '2026-10-05', d: '2026-11-04', s: 'terms' });
  });

  it('an approved invoice is refused and untouched', async () => {
    const c = await company();
    const id = await draftInvoice(c, await customer(c, THIRTY), 'terms', '2026-10-16', 'approved');
    expect((await putAr(c, { id, invoiceDate: '2026-10-01' })).state.statusCode).toBe(400);
    expect(await stored('customer_invoices', id)).toEqual({ i: '2026-09-16', d: '2026-10-16', s: 'terms' });
  });
});

describe('a supplier bill draft', () => {
  it.each([['draft'], ['pending_approval']])('a terms-sourced %s bill whose invoice date moves is re-dated by the supplier\'s terms', async (status) => {
    const c = await company();
    const id = await draftBill(c, await supplier(c, [3, 'statement_months']), 'terms', { status });
    const res = await putAp(c, { id, invoiceDate: '2026-10-05', dueDate: '2026-10-16' }); // the stored date re-sent
    expect(res.state.statusCode, messageOf(res)).toBe(200);
    expect(await stored('supplier_invoices', id)).toEqual({ i: '2026-10-05', d: '2027-01-31', s: 'terms' });
    expect(await changesOf(pool, id)).toHaveLength(1);
  });

  it('the bill\'s own chosen terms take precedence, as at creation (recorded manual)', async () => {
    const c = await company();
    const id = await draftBill(c, await supplier(c, THIRTY), 'terms', { terms: 'net60' });
    expect((await putAp(c, { id, invoiceDate: '2026-10-01' })).state.statusCode).toBe(200);
    expect(await stored('supplier_invoices', id)).toEqual({ i: '2026-10-01', d: '2026-11-30', s: 'manual' });
  });

  it('a due date the edit names that differs from the stored one and the terms\' stays, manual', async () => {
    const c = await company();
    const id = await draftBill(c, await supplier(c, THIRTY), 'terms');
    expect((await putAp(c, { id, invoiceDate: '2026-10-01', dueDate: '2026-12-24' })).state.statusCode).toBe(200);
    expect(await stored('supplier_invoices', id)).toEqual({ i: '2026-10-01', d: '2026-12-24', s: 'manual' });
  });

  it.each(['manual', 'document', 'legacy'])('a %s due date does not move with the invoice date', async (source) => {
    const c = await company();
    const id = await draftBill(c, await supplier(c, THIRTY), source);
    expect((await putAp(c, { id, invoiceDate: '2026-10-01', dueDate: '2026-10-16' })).state.statusCode).toBe(200);
    expect(await stored('supplier_invoices', id)).toEqual({ i: '2026-10-01', d: '2026-10-16', s: source });
  });

  it('an edit that leaves the invoice date alone leaves the due date alone', async () => {
    const c = await company();
    const id = await draftBill(c, await supplier(c, THIRTY), 'terms', { due: '2026-11-20' });
    expect((await putAp(c, { id, notes: 'n', dueDate: '2026-11-20' })).state.statusCode).toBe(200);
    expect(await stored('supplier_invoices', id)).toEqual({ i: '2026-09-16', d: '2026-11-20', s: 'terms' });
  });

  it('an approved bill is refused and untouched', async () => {
    const c = await company();
    const id = await draftBill(c, await supplier(c, THIRTY), 'terms', { status: 'approved' });
    expect((await putAp(c, { id, invoiceDate: '2026-10-01' })).state.statusCode).toBe(400);
    expect(await stored('supplier_invoices', id)).toEqual({ i: '2026-09-16', d: '2026-10-16', s: 'terms' });
  });
});

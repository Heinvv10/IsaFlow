/**
 * The company's default payment terms (migration 958; Hein, 2026-11-05): a contact whose terms are not set is dated by
 * them. Through the real route and the real resolver: set and read the default as an owner, refused for a viewer and for
 * an unreadable value, scoped to the company; a contact's own terms win; a contact in ANOTHER company is not read.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import companySettings from '../../pages/api/accounting/company-settings';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute } from './r035-approval.helpers';
import { dataOf, messageOf } from './r035-pr2.helpers';
import { cleanupEntityChanges, members, newCompany } from './entity-changes.helpers';
import { inRequest } from './r035-pr5.helpers';
import { dueDateForContact } from '../../src/modules/accounting/services/core/paymentTermsResolver';
import { createDraftCustomerInvoice } from '../../src/modules/accounting/services/ar/customerInvoiceCreateService';
import { createSupplierInvoice } from '../../src/modules/accounting/services/ap/supplierInvoiceService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let admin = '', viewer = '', other = '';

beforeAll(async () => { [admin, viewer, other] = await members(pool, tokens, 3); });
afterAll(async () => {
  // The creators above wrote invoices: they go before the companies do (the history goes with a company).
  await pool.query('DELETE FROM customer_invoice_items WHERE invoice_id IN (SELECT id FROM customer_invoices WHERE company_id = ANY($1))', [companies]);
  await pool.query('DELETE FROM customer_invoices WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (SELECT id FROM supplier_invoices WHERE company_id = ANY($1))', [companies]);
  await pool.query('DELETE FROM supplier_invoices WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM accounting_settings WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM company_document_numbers WHERE company_id = ANY($1)', [companies]);
  await cleanupEntityChanges(pool, companies, [admin, viewer, other]);
});

const company = () => newCompany(pool, [[admin, 'admin'], [viewer, 'viewer']], companies);
const otherCompany = () => newCompany(pool, [[other, 'admin']], companies);
const call = (user: string, c: string, method: 'GET' | 'PUT', body?: unknown) =>
  callRoute(companySettings, tokens[user]!, c, method, body, '/api/accounting/company-settings', { type: 'payment-terms' });

async function contact(table: 'customers' | 'suppliers', c: string, n: number | null, type: string | null): Promise<string> {
  const { rows } = await pool.query(`INSERT INTO ${table}(company_id, name, payment_terms, payment_terms_type) VALUES($1, 'Dated', $2, $3) RETURNING id`, [c, n, type]);
  return rows[0].id as string;
}

describe('company default payment terms: the settings route', () => {
  it('starts at 30 days from invoice for a company (no row), and an admin can change it', async () => {
    const c = await company();
    expect((await pool.query("SELECT 1 FROM accounting_settings WHERE company_id = $1 AND key = 'default_payment_terms'", [c])).rows).toHaveLength(0);
    expect(dataOf(await call(admin, c, 'GET'))).toEqual({ payment_terms: 30, payment_terms_type: 'invoice_days' });
    const put = await call(admin, c, 'PUT', { payment_terms: 2, payment_terms_type: 'statement_months' });
    expect(put.state.statusCode, JSON.stringify(put.state.body)).toBe(200);
    expect(dataOf(await call(admin, c, 'GET'))).toEqual({ payment_terms: 2, payment_terms_type: 'statement_months' });
  });

  it('is per company: another company still has its own', async () => {
    const a = await company();
    const b = await otherCompany();
    await call(admin, a, 'PUT', { payment_terms: 60, payment_terms_type: 'invoice_days' });
    expect(dataOf(await call(other, b, 'GET'))).toEqual({ payment_terms: 30, payment_terms_type: 'invoice_days' });
  });

  it.each([
    [{ payment_terms: 1000, payment_terms_type: 'invoice_days' }], [{ payment_terms: -1, payment_terms_type: 'invoice_days' }],
    [{ payment_terms: 30, payment_terms_type: 'net30' }], [{ payment_terms_type: 'not_set' }], [{}], [{ payment_terms: '30', payment_terms_type: 'invoice_days' }],
  ])('refuses %j with a 400 and leaves the default as it was', async (body) => {
    const c = await company();
    const res = await call(admin, c, 'PUT', body);
    expect(res.state.statusCode, messageOf(res)).toBe(400);
    expect(dataOf(await call(admin, c, 'GET'))).toEqual({ payment_terms: 30, payment_terms_type: 'invoice_days' });
  });

  it('a viewer cannot change it', async () => {
    const c = await company();
    expect((await call(viewer, c, 'PUT', { payment_terms: 5, payment_terms_type: 'invoice_days' })).state.statusCode).toBe(403);
    expect(dataOf(await call(viewer, c, 'GET'))).toEqual({ payment_terms: 30, payment_terms_type: 'invoice_days' });
  });
});

describe('dueDateForContact: the contact\'s own terms, else the company default', () => {
  it('a contact with no terms is dated by the company default; one with terms by its own', async () => {
    const c = await company();
    expect((await call(admin, c, 'PUT', { payment_terms: 2, payment_terms_type: 'statement_months' })).state.statusCode).toBe(200);
    const none = await contact('customers', c, null, null);
    const own = await contact('suppliers', c, 10, 'invoice_days');
    const legacy = await contact('customers', c, 14, 'days');
    const bare = await contact('customers', c, 30, null);
    const date = (kind: 'customer' | 'supplier', id: string | null) => inRequest(pool, admin, c, () => dueDateForContact(c, kind, id, '2026-10-15'));
    expect(await date('customer', none)).toBe('2026-12-31');
    expect(await date('supplier', own)).toBe('2026-10-25');
    expect(await date('customer', legacy)).toBe('2026-10-29');
    expect(await date('customer', bare)).toBe('2026-11-14');
    expect(await date('customer', null)).toBe('2026-12-31');
  });

  it('a contact of ANOTHER company is not read: the answer is this company\'s default', async () => {
    const a = await company();
    const b = await otherCompany();
    const theirs = await contact('customers', b, 5, 'invoice_days');
    const due = await inRequest(pool, admin, a, () => dueDateForContact(a, 'customer', theirs, '2026-10-15'));
    expect(due).toBe('2026-11-14'); // a's default, 30 days; not b's customer's 5
  });
});

describe('the real document creators date a document by the contact, then the company default', () => {
  const dueOf = async (table: 'customer_invoices' | 'supplier_invoices', id: string) =>
    (await pool.query(`SELECT to_char(due_date, 'YYYY-MM-DD') AS d FROM ${table} WHERE id = $1`, [id])).rows[0].d as string | null;
  const line = { description: 'Cable', quantity: 1, unitPrice: 100, taxRate: 15 };

  it('a customer invoice with no date given: the customer\'s terms; none: the company\'s default; the date given wins', async () => {
    const c = await company();
    await call(admin, c, 'PUT', { payment_terms: 2, payment_terms_type: 'statement_months' });
    const none = await contact('customers', c, null, null);
    const own = await contact('customers', c, 7, 'invoice_days');
    const make = (clientId: string, dueDate?: string) => inRequest(pool, admin, c, () => createDraftCustomerInvoice(c, admin, {
      clientId, invoiceDate: '2026-10-15', ...(dueDate ? { dueDate } : {}), items: [{ description: 'Work', unitPrice: 100, quantity: 1 }],
    }));
    expect(await dueOf('customer_invoices', (await make(none)).id)).toBe('2026-12-31');
    expect(await dueOf('customer_invoices', (await make(own)).id)).toBe('2026-10-22');
    expect(await dueOf('customer_invoices', (await make(none, '2026-11-01')).id)).toBe('2026-11-01');
  });

  it('a supplier bill: given date > the bill\'s own terms > the supplier\'s > the company default', async () => {
    const c = await company();
    await call(admin, c, 'PUT', { payment_terms: 60, payment_terms_type: 'invoice_days' });
    const none = await contact('suppliers', c, null, null);
    const own = await contact('suppliers', c, 3, 'statement_months');
    let n = 0;
    const make = (supplierId: string, extra: { dueDate?: string; paymentTerms?: string } = {}) => inRequest(pool, admin, c, () => createSupplierInvoice(c, {
      supplierId, invoiceNumber: `PT-${++n}-${c.slice(0, 6)}`, invoiceDate: '2026-10-15', taxRate: 15, items: [line], ...extra,
    }, admin));
    expect(await dueOf('supplier_invoices', (await make(none)).id)).toBe('2026-12-14');
    expect(await dueOf('supplier_invoices', (await make(own)).id)).toBe('2027-01-31');
    expect(await dueOf('supplier_invoices', (await make(own, { paymentTerms: 'net30' })).id)).toBe('2026-11-14');
    expect(await dueOf('supplier_invoices', (await make(own, { paymentTerms: 'net30', dueDate: '2026-11-01' })).id)).toBe('2026-11-01');
  });
});

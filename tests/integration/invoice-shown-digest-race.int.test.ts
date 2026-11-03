/**
 * PR S round fifteen (review M3): the detail GET computes its shown digest BEFORE it reads the invoice it returns, so a
 * change landing between the two leaves the page NEWER than its digest (the approve is refused, 409), never older (an
 * approve of a view nobody saw would pass). The window is opened deterministically: `sql` is wrapped, and right after
 * the digest loader's read a hook changes the customer's printed name through a separate pool.
 * Also: the model the digest loader reads has exactly the keys its interfaces name (nothing unprinted leaks in), and
 * another company's customer or job, named by a drifted id, is never read into it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const hooks = vi.hoisted(() => ({ afterDigestRead: null as null | (() => Promise<void>), fired: 0 }));
vi.mock('@/lib/neon', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const realSql = real.sql as (s: TemplateStringsArray, ...v: unknown[]) => unknown;
  // Lazy for every statement but the hooked one (sql.transaction reads a LazyQuery's text).
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    if (!hooks.afterDigestRead || !text.includes('approval_document_digest') || !text.includes('LEFT JOIN companies')) return realSql(strings, ...values);
    return (async () => {
      const rows = await (realSql(strings, ...values) as Promise<unknown>);
      const hook = hooks.afterDigestRead;
      hooks.afterDigestRead = null;
      if (hook) { hooks.fired++; await hook(); }
      return rows;
    })();
  };
  return { ...real, sql: Object.assign(sql, realSql) };
});

import customerInvoicesDetail from '../../pages/api/accounting/customer-invoices-detail';
import { loadInvoicePdfModel } from '@/modules/accounting/services/ar/invoicePdfModel';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, reasonOf } from './r035-approval.helpers';
import { cleanupPr4, invoiceCompany, plantInvoice } from './r035-pr4.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let owner = '';
let company = '';
const URL = '/api/accounting/customer-invoices-detail';
const call = (method: string, body: unknown, query: Record<string, string> = {}) =>
  callRoute(customerInvoicesDetail, tokens[owner]!, company, method, body, URL, query);

beforeAll(async () => {
  owner = await createUser(pool, tokens);
  company = await invoiceCompany(pool, [[owner, 'owner']], companies);
}, 60_000);
afterAll(async () => { await cleanupPr4(pool, companies, [owner]); });

describe('the detail GET reads its digest before the invoice it returns', () => {
  it('a printed field changing between the two: the page shows the new value, and approve with its digest is refused', async () => {
    const inv = await plantInvoice(pool, company, owner);
    hooks.fired = 0;
    hooks.afterDigestRead = async () => { await pool.query(`UPDATE customers SET name = 'Renamed mid-read' WHERE id = $1`, [inv.customerId]); };
    const got = await call('GET', undefined, { id: inv.id });
    hooks.afterDigestRead = null;
    expect(hooks.fired).toBe(1); // the window really opened (a renamed query would make this test vacuous)
    const shown = (got.state.body as { data: { client_name: string; shown_digest: string } }).data;
    expect(shown.client_name).toBe('Renamed mid-read'); // the page is newer than its digest
    const res = await call('POST', { id: inv.id, action: 'approve', expectedTotal: 1150, expectedContentDigest: shown.shown_digest });
    expect(res.state.statusCode).toBe(409);
    expect(reasonOf(res)).toBe('STALE_VIEW');
  });
});

describe('the digest model', () => {
  it('has exactly the keys its interfaces name: nothing unprinted is read into it', async () => {
    const inv = await plantInvoice(pool, company, owner);
    const model = (await loadInvoicePdfModel(company, inv.id, { forDigest: true }))!;
    expect(Object.keys(model).sort()).toEqual(['company', 'invoice', 'items']);
    expect(Object.keys(model.company).sort()).toEqual(['address', 'bankAccountName', 'bankAccountNumber', 'bankBranchCode',
      'bankName', 'email', 'logoData', 'name', 'phone', 'primaryColor', 'vatNumber']);
    expect(Object.keys(model.invoice).sort()).toEqual(['amount_paid', 'billing_period_end', 'billing_period_start',
      'client_address', 'client_contact', 'client_email', 'client_name', 'client_phone', 'client_vat', 'currency_code',
      'due_date', 'exchange_rate', 'invoice_date', 'invoice_number', 'notes', 'payment_terms', 'project_name', 'status',
      'subtotal', 'tax_amount', 'tax_rate', 'total_amount']);
    for (const line of model.items) expect(Object.keys(line).sort()).toEqual(['amount', 'description', 'quantity', 'tax_rate', 'unit_price']);
  });

  it('an invoice whose client and job ids name ANOTHER company\'s rows prints neither (each join carries company_id)', async () => {
    const other = await invoiceCompany(pool, [[owner, 'owner']], companies);
    const theirCustomer = crypto.randomUUID();
    await pool.query('INSERT INTO customers(id, company_id, name) VALUES($1, $2, $3)', [theirCustomer, other, 'Their customer']);
    const theirProject = (await pool.query(`INSERT INTO projects (company_id, project_number, name) VALUES ($1, 'P-THEIRS', 'Their job') RETURNING id`, [other])).rows[0].id;
    const inv = await plantInvoice(pool, company, owner);
    await pool.query('UPDATE customer_invoices SET client_id = $2, customer_id = $2, project_id = $3 WHERE id = $1', [inv.id, theirCustomer, theirProject]);
    const model = (await loadInvoicePdfModel(company, inv.id, { forDigest: true }))!;
    expect(model.invoice.client_name).toBeNull();
    expect(model.invoice.project_name).toBeNull();
    await pool.query('UPDATE customer_invoices SET project_id = NULL WHERE id = $1', [inv.id]);
    await pool.query('DELETE FROM projects WHERE id = $1', [theirProject]);
  });
});

/**
 * Migration 962: every way a document is created or draft-edited records where its due date came from. Through the
 * real creators: no date given -> terms; a given date the terms would give anyway -> terms (the capture pages prefill
 * it); any other given date -> manual; a bill's own chosen terms -> manual; a document's printed date or terms ->
 * document (even where the terms agree); a draft edit that moves the date -> manual, one that does not -> unchanged.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import supplierInvoicesDetail from '../../pages/api/accounting/supplier-invoices-detail';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute } from './r035-approval.helpers';
import { messageOf } from './r035-pr2.helpers';
import { cleanupEntityChanges, members, newCompany } from './entity-changes.helpers';
import { inRequest } from './r035-pr5.helpers';
import { createSupplierInvoice } from '../../src/modules/accounting/services/ap/supplierInvoiceService';
import { createDraftCustomerInvoice } from '../../src/modules/accounting/services/ar/customerInvoiceCreateService';
import { editDraftCustomerInvoice } from '../../src/modules/accounting/services/ar/customerInvoiceDraftEdit';
import { extractedBillDueDate } from '../../src/modules/accounting/services/capture/captureBillLines';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let admin = '';

beforeAll(async () => { [admin] = await members(pool, tokens, 1); });
afterAll(async () => {
  await pool.query('DELETE FROM customer_invoice_items WHERE invoice_id IN (SELECT id FROM customer_invoices WHERE company_id = ANY($1))', [companies]);
  await pool.query('DELETE FROM customer_invoices WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (SELECT id FROM supplier_invoices WHERE company_id = ANY($1))', [companies]);
  await pool.query('DELETE FROM supplier_invoices WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM company_document_numbers WHERE company_id = ANY($1)', [companies]);
  await cleanupEntityChanges(pool, companies, [admin]); // ends the pool
});

const company = () => newCompany(pool, [[admin, 'admin']], companies);
async function contact(table: 'customers' | 'suppliers', c: string, n: number | null, type: string | null): Promise<string> {
  const { rows } = await pool.query(`INSERT INTO ${table}(company_id, name, payment_terms, payment_terms_type) VALUES($1, $2, $3, $4) RETURNING id`,
    [c, `Src ${crypto.randomUUID().slice(0, 6)}`, n, type]);
  return rows[0].id as string;
}
const stored = async (table: 'customer_invoices' | 'supplier_invoices', id: string) =>
  (await pool.query(`SELECT to_char(due_date, 'YYYY-MM-DD') AS due, due_date_source AS source FROM ${table} WHERE id = $1`, [id])).rows[0] as { due: string; source: string };
const line = { description: 'Cable', quantity: 1, unitPrice: 100, taxRate: 15 };

describe('a new supplier bill', () => {
  // Supplier: 10 days from invoice. Invoice 2026-10-15 -> terms give 2026-10-25.
  const make = (c: string, supplierId: string, extra: Record<string, unknown>) => inRequest(pool, admin, c, () => createSupplierInvoice(c, {
    supplierId, invoiceNumber: `S-${crypto.randomUUID().slice(0, 8)}`, invoiceDate: '2026-10-15', items: [line], ...extra,
  }, admin));

  it.each([
    ['no date given', {}, '2026-10-25', 'terms'],
    ['the terms\' own date given', { dueDate: '2026-10-25' }, '2026-10-25', 'terms'],
    ['another date given', { dueDate: '2026-11-30' }, '2026-11-30', 'manual'],
    ['the bill\'s own chosen terms', { paymentTerms: 'net7' }, '2026-10-22', 'manual'],
    ['a document\'s date', { dueDate: '2026-11-30', dueDateGivenAs: 'document' }, '2026-11-30', 'document'],
    ['a document\'s date the terms agree with', { dueDate: '2026-10-25', dueDateGivenAs: 'document' }, '2026-10-25', 'document'],
  ])('%s', async (_name, extra, due, source) => {
    const c = await company();
    const s = await contact('suppliers', c, 10, 'invoice_days');
    expect(await stored('supplier_invoices', (await make(c, s, extra)).id)).toEqual({ due, source });
  });
});

describe('a new customer invoice', () => {
  const make = (c: string, clientId: string, dueDate?: string) => inRequest(pool, admin, c, () => createDraftCustomerInvoice(c, admin, {
    clientId, invoiceDate: '2026-10-15', ...(dueDate ? { dueDate } : {}), items: [{ description: 'Work', unitPrice: 100, quantity: 1 }],
  }));

  it.each([[undefined, '2026-10-22', 'terms'], ['2026-10-22', '2026-10-22', 'terms'], ['2026-11-01', '2026-11-01', 'manual']])(
    'given %s', async (given, due, source) => {
      const c = await company();
      const cust = await contact('customers', c, 7, 'invoice_days');
      expect(await stored('customer_invoices', (await make(c, cust, given)).id)).toEqual({ due, source });
    });

  it('a draft edit that moves the due date makes it manual; one that resends the same date leaves it', async () => {
    const c = await company();
    const cust = await contact('customers', c, 7, 'invoice_days');
    const { id } = await make(c, cust);
    expect((await inRequest(pool, admin, c, () => editDraftCustomerInvoice(c, admin, { id, dueDate: '2026-10-22' } as never))).kind).toBe('ok');
    expect(await stored('customer_invoices', id)).toEqual({ due: '2026-10-22', source: 'terms' });
    expect((await inRequest(pool, admin, c, () => editDraftCustomerInvoice(c, admin, { id, dueDate: '2026-12-01' } as never))).kind).toBe('ok');
    expect(await stored('customer_invoices', id)).toEqual({ due: '2026-12-01', source: 'manual' });
  });
});

describe('a scanned bill and the draft-bill edit route', () => {
  it('a printed date or the scan\'s terms are the document\'s; a confirmed supplier\'s terms are terms', async () => {
    const c = await company();
    const unset = await contact('suppliers', c, null, null);
    const confirmed = await contact('suppliers', c, 10, 'invoice_days');
    const scan = (s: string, extracted: { dueDate?: string | null; paymentTerms?: string | null }) =>
      inRequest(pool, admin, c, () => extractedBillDueDate(c, s, { invoiceDate: '2026-10-15', ...extracted }));
    expect(await scan(confirmed, { dueDate: '2026-11-11' })).toEqual({ dueDate: '2026-11-11', source: 'document' });
    expect(await scan(unset, { paymentTerms: 'Net 14' })).toEqual({ dueDate: '2026-10-29', source: 'document' });
    expect(await scan(confirmed, { paymentTerms: 'Net 14' })).toEqual({ dueDate: '2026-10-25', source: 'terms' });
    expect(await scan(unset, {})).toEqual({ dueDate: '2026-11-14', source: 'terms' }); // the company default
  });

  it('the draft-bill PUT makes a moved due date manual and leaves an unmoved one', async () => {
    const c = await company();
    const s = await contact('suppliers', c, 10, 'invoice_days');
    const { id } = await inRequest(pool, admin, c, () => createSupplierInvoice(c, {
      supplierId: s, invoiceNumber: `S-${crypto.randomUUID().slice(0, 8)}`, invoiceDate: '2026-10-15', items: [line],
    }, admin));
    const putDetail = (body: unknown) => callRoute(supplierInvoicesDetail, tokens[admin]!, c, 'PUT', body, '/api/accounting/supplier-invoices-detail');
    let res = await putDetail({ id, notes: 'only notes' });
    expect(res.state.statusCode, messageOf(res)).toBe(200);
    expect(await stored('supplier_invoices', id)).toEqual({ due: '2026-10-25', source: 'terms' });
    res = await putDetail({ id, dueDate: '2026-10-25' });
    expect(await stored('supplier_invoices', id)).toEqual({ due: '2026-10-25', source: 'terms' });
    res = await putDetail({ id, dueDate: '2026-12-01' });
    expect(res.state.statusCode, messageOf(res)).toBe(200);
    expect(await stored('supplier_invoices', id)).toEqual({ due: '2026-12-01', source: 'manual' });
  });
});

/**
 * FX PR0, the creators: every route that writes a document's currency refuses
 * a foreign one while the company has not enabled foreign-currency documents,
 * and refuses the functional currency at a rate other than 1 — with a 400,
 * before any write (withAuth COMMITs a 4xx, so a number reserved first would
 * be burned). The database refuses the same (fx-pr0-db.int.test.ts); these
 * prove the services answer first.
 *
 * Where a foreign document IS allowed, functional_total is the SQL conversion
 * public.fx_functional(total, rate), never a float multiplication.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import customerInvoicesCreate from '../../pages/api/accounting/customer-invoices-create';
import customerInvoicesDetail from '../../pages/api/accounting/customer-invoices-detail';
import supplierInvoices from '../../pages/api/accounting/supplier-invoices';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantBill } from './r035-approval.helpers';
import { cleanupPr2, messageOf, postableCompany } from './r035-pr2.helpers';
import { als } from '@/lib/als';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import {
  applySupplierInvoiceDraftUpdate, lockAndPlanSupplierInvoiceDraftUpdate,
} from '@/modules/accounting/services/ap/supplierInvoiceDraftUpdate';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let owner = '';

beforeAll(async () => { owner = await createUser(pool, tokens); });
afterAll(async () => {
  await pool.query('DELETE FROM company_document_numbers WHERE company_id = ANY($1)', [companies]);
  await pool.query(
    'DELETE FROM customer_invoice_items WHERE invoice_id IN (SELECT id FROM customer_invoices WHERE company_id = ANY($1))', [companies]);
  await pool.query('DELETE FROM customer_invoices WHERE company_id = ANY($1)', [companies]);
  await cleanupPr2(pool, companies, [owner]);
});

async function fixture(fxEnabled = false) {
  const c = await postableCompany(pool, [[owner, 'owner']], companies);
  if (fxEnabled) await pool.query('UPDATE companies SET fx_documents_enabled = true WHERE id = $1', [c]);
  const customer = crypto.randomUUID();
  await pool.query('INSERT INTO customers(id, company_id, name) VALUES($1,$2,$3)', [customer, c, 'fx pr0 customer']);
  const bill = await plantBill(pool, c, owner);
  return { c, customer, supplierId: bill.supplierId, account: bill.accountA };
}
const count = async (table: string, c: string) =>
  (await pool.query(`SELECT count(*)::INT AS n FROM ${table} WHERE company_id = $1`, [c])).rows[0].n as number;
const numbers = async (c: string) =>
  (await pool.query('SELECT count(*)::INT AS n FROM company_document_numbers WHERE company_id = $1', [c])).rows[0].n as number;

const invoiceBody = (customer: string, currencyCode?: string, exchangeRate?: number) => ({
  clientId: customer, invoiceDate: '2026-09-01', currencyCode, exchangeRate,
  items: [{ description: 'Consulting', quantity: 1, unitPrice: 1000 }],
});
const createInvoice = (c: string, body: unknown) =>
  callRoute(customerInvoicesCreate, tokens[owner]!, c, 'POST', body, '/api/accounting/customer-invoices-create');
const createBill = (c: string, supplierId: string, account: string, currencyCode: string, exchangeRate: number, useSequence = false) =>
  callRoute(supplierInvoices, tokens[owner]!, c, 'POST', {
    supplierId, invoiceDate: '2026-09-01', currencyCode, exchangeRate, useSequence,
    invoiceNumber: useSequence ? undefined : `FX-${crypto.randomUUID().slice(0, 8)}`,
    items: [{ description: 'Fibre build', quantity: 1, unitPrice: 1000, taxRate: 15, glAccountId: account }],
  }, '/api/accounting/supplier-invoices');
const editInvoice = (c: string, body: unknown) =>
  callRoute(customerInvoicesDetail, tokens[owner]!, c, 'PUT', body, '/api/accounting/customer-invoices-detail');

describe('customer invoice create', () => {
  it('refuses USD while the company has not enabled it — 400, no invoice, no number burned', async () => {
    const { c, customer } = await fixture();
    const res = await createInvoice(c, invoiceBody(customer, 'USD', 18.5));
    expect(res.state.statusCode).toBe(400);
    expect(messageOf(res)).toMatch(/USD invoices are not enabled for this company/);
    expect(await count('customer_invoices', c)).toBe(0);
    expect(await numbers(c)).toBe(0);
  });

  it('refuses ZAR at a rate other than 1, flag or no flag', async () => {
    for (const enabled of [false, true]) {
      const { c, customer } = await fixture(enabled);
      const res = await createInvoice(c, invoiceBody(customer, 'ZAR', 0.5));
      expect(res.state.statusCode).toBe(400);
      expect(messageOf(res)).toMatch(/exchange rate must be 1/);
      expect(await count('customer_invoices', c)).toBe(0);
    }
  });

  it('enabled, writes USD with functional_total = fx_functional(total, rate)', async () => {
    const { c, customer } = await fixture(true);
    const res = await createInvoice(c, invoiceBody(customer, 'usd', 18.333));
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(201);
    const { rows } = await pool.query(
      'SELECT currency_code, exchange_rate::float AS rate, total_amount::float AS total, functional_total::text AS f FROM customer_invoices WHERE company_id = $1', [c]);
    expect(rows).toEqual([{ currency_code: 'USD', rate: 18.333, total: 1150, f: '21082.95' }]);
  });

  it('a plain ZAR invoice is unchanged', async () => {
    const { c, customer } = await fixture();
    expect((await createInvoice(c, invoiceBody(customer))).state.statusCode).toBe(201);
    const { rows } = await pool.query('SELECT currency_code, functional_total::float AS f FROM customer_invoices WHERE company_id = $1', [c]);
    expect(rows).toEqual([{ currency_code: 'ZAR', f: 1150 }]);
  });
});

describe('customer invoice draft edit', () => {
  async function draft(fxEnabled: boolean) {
    const { c, customer } = await fixture(fxEnabled);
    const res = await createInvoice(c, invoiceBody(customer));
    return { c, id: (res.state.body as { data: { id: string } }).data.id };
  }
  const row = async (id: string) => (await pool.query(
    'SELECT currency_code, exchange_rate::float AS rate, functional_total::text AS f FROM customer_invoices WHERE id = $1', [id])).rows[0];
  const items = [{ description: 'Consulting', quantity: 2, unitPrice: 1000 }];

  it('refuses a change into USD while disabled, and ZAR at a rate other than 1 — nothing written', async () => {
    const { c, id } = await draft(false);
    const usd = await editInvoice(c, { id, items, currencyCode: 'USD', exchangeRate: 18.5 });
    expect(usd.state.statusCode).toBe(400);
    expect(messageOf(usd)).toMatch(/USD invoices are not enabled for this company/);
    const zar = await editInvoice(c, { id, items, currencyCode: 'ZAR', exchangeRate: 2 });
    expect(zar.state.statusCode).toBe(400);
    expect(messageOf(zar)).toMatch(/exchange rate must be 1/);
    expect(await row(id)).toEqual({ currency_code: 'ZAR', rate: 1, f: '1150.00' });
  });

  it('enabled, recomputes functional_total in SQL at the new rate', async () => {
    const { c, id } = await draft(true);
    expect((await editInvoice(c, { id, items, currencyCode: 'USD', exchangeRate: 18.333 })).state.statusCode).toBe(200);
    expect(await row(id)).toEqual({ currency_code: 'USD', rate: 18.333, f: '42165.90' });
  });
});

describe('supplier invoice create', () => {
  it('refuses USD while disabled — before the sequence reservation, so no number is burned', async () => {
    const { c, supplierId, account } = await fixture();
    const before = await count('supplier_invoices', c);
    const res = await createBill(c, supplierId, account, 'USD', 18.5, true);
    expect(res.state.statusCode).toBe(400);
    expect(messageOf(res)).toMatch(/USD bills are not enabled for this company/);
    expect(await count('supplier_invoices', c)).toBe(before);
    expect(await numbers(c)).toBe(0);
  });

  it('refuses ZAR at a rate other than 1 before the reservation too', async () => {
    const { c, supplierId, account } = await fixture();
    const res = await createBill(c, supplierId, account, 'ZAR', 0.0001, true);
    expect(res.state.statusCode).toBe(400);
    expect(messageOf(res)).toMatch(/exchange rate must be 1/);
    expect(await numbers(c)).toBe(0);
  });

  it('enabled, writes USD with functional_total = fx_functional(total, rate)', async () => {
    const { c, supplierId, account } = await fixture(true);
    const res = await createBill(c, supplierId, account, 'USD', 18.333);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(201);
    const { rows } = await pool.query(
      `SELECT currency_code, functional_total::text AS f FROM supplier_invoices WHERE company_id = $1 AND currency_code = 'USD'`, [c]);
    expect(rows).toEqual([{ currency_code: 'USD', f: '21082.95' }]);
  });
});

/** A service call in its own committed transaction, as the MCP tools make it (no route in front). */
async function inTx<T>(c: string, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run({ client, userId: owner, companyId: c, claims: {} } as never, fn);
    await client.query('COMMIT');
    return out;
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
}

describe('the supplier invoice services (the MCP tools call these with no route in front)', () => {
  const line = (account: string, unitPrice: number) => [{ description: 'Fibre build', quantity: 1, unitPrice, taxRate: 15, glAccountId: account }];

  it('createSupplierInvoice refuses USD while disabled, itself', async () => {
    const { c, supplierId, account } = await fixture();
    await expect(inTx(c, () => createSupplierInvoice(c, {
      invoiceNumber: `FX-${crypto.randomUUID().slice(0, 8)}`, supplierId, invoiceDate: '2026-09-01',
      currencyCode: 'USD', exchangeRate: 18.5, items: line(account, 1000),
    }, owner))).rejects.toThrow(/USD bills are not enabled for this company/);
  });

  it('the draft update recomputes functional_total in SQL at the bill\'s own rate', async () => {
    const { c, supplierId, account } = await fixture(true);
    const bill = await inTx(c, () => createSupplierInvoice(c, {
      invoiceNumber: `FX-${crypto.randomUUID().slice(0, 8)}`, supplierId, invoiceDate: '2026-09-01',
      currencyCode: 'USD', exchangeRate: 18.333, items: line(account, 1000),
    }, owner));
    await inTx(c, async () => {
      const plan = await lockAndPlanSupplierInvoiceDraftUpdate(c, bill.id, { items: line(account, 2000) });
      await applySupplierInvoiceDraftUpdate(c, plan, owner);
    });
    const { rows } = await pool.query('SELECT total_amount::text AS t, functional_total::text AS f FROM supplier_invoices WHERE id = $1', [bill.id]);
    expect(rows).toEqual([{ t: '2300.00', f: '42165.90' }]);
  });
});

/**
 * FX PR0 review round 1, through the real routes and services:
 *
 * - A legacy foreign draft (written while the switch was on) is refused with
 *   a 400 FOREIGN_CURRENCY_DISABLED on ANY edit once the switch is off, not
 *   the gate's raw 500; converting it to ZAR is the way out.
 * - A rate-only edit of a ZAR draft is held to rate 1.
 * - A currency code that is not three letters, or not a string, is a 400.
 * - A stored NULL or 0 exchange rate converts at 1, as the TypeScript reads it.
 * - A rate given to more than six places is stored to six, and the functional
 *   total is converted at the STORED rate.
 * - A credit note may not be linked to a foreign invoice (a 400 at create).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import customerInvoicesCreate from '../../pages/api/accounting/customer-invoices-create';
import customerInvoicesDetail from '../../pages/api/accounting/customer-invoices-detail';
import supplierInvoices from '../../pages/api/accounting/supplier-invoices';
import creditNotes from '../../pages/api/accounting/credit-notes';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, enableFxDocuments, plantBill } from './r035-approval.helpers';
import { cleanupPr2, messageOf, postableCompany } from './r035-pr2.helpers';
import { plantInvoice } from './r035-pr4.helpers';
import { als } from '@/lib/als';
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
  await pool.query('DELETE FROM credit_notes WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM customer_invoice_items WHERE invoice_id IN (SELECT id FROM customer_invoices WHERE company_id = ANY($1))', [companies]);
  await pool.query('DELETE FROM customer_invoices WHERE company_id = ANY($1)', [companies]);
  await cleanupPr2(pool, companies, [owner]);
});

const company = async (fx = false) => {
  const c = await postableCompany(pool, [[owner, 'owner']], companies);
  if (fx) await enableFxDocuments(pool, c);
  return c;
};
const put = (c: string, body: unknown) =>
  callRoute(customerInvoicesDetail, tokens[owner]!, c, 'PUT', body, '/api/accounting/customer-invoices-detail');
const create = (c: string, body: Record<string, unknown>) =>
  callRoute(customerInvoicesCreate, tokens[owner]!, c, 'POST', {
    invoiceDate: '2026-09-01', items: [{ description: 'Consulting', quantity: 1, unitPrice: 1000 }], ...body,
  }, '/api/accounting/customer-invoices-create');
const customer = async (c: string) => {
  const id = crypto.randomUUID();
  await pool.query('INSERT INTO customers(id, company_id, name) VALUES($1,$2,$3)', [id, c, 'fx edits']);
  return id;
};
const items = [{ description: 'Consulting', quantity: 2, unitPrice: 1000 }];
const row = async (table: string, id: string) => (await pool.query(
  `SELECT currency_code, exchange_rate::text AS rate, total_amount::text AS total, functional_total::text AS f FROM ${table} WHERE id = $1`, [id])).rows[0];

describe('a legacy foreign draft once the switch is off', () => {
  it('any edit, a notes edit too, is a 400 naming the currency; converting it to ZAR goes through', async () => {
    const c = await company(true);
    const inv = await plantInvoice(pool, c, owner, { currencyCode: 'USD', exchangeRate: 18.5 });
    await pool.query('UPDATE companies SET fx_documents_enabled = false WHERE id = $1', [c]);
    const notes = await put(c, { id: inv.id, notes: 'just a note' });
    expect(notes.state.statusCode, JSON.stringify(notes.state.body)).toBe(400);
    expect(messageOf(notes)).toMatch(/USD invoices are not enabled for this company/);
    const back = await put(c, { id: inv.id, items, currencyCode: 'ZAR', exchangeRate: 1 });
    expect(back.state.statusCode, JSON.stringify(back.state.body)).toBe(200);
    expect(await row('customer_invoices', inv.id)).toMatchObject({ currency_code: 'ZAR', f: '2300.00' });
  });
});

describe('the draft edit and create guard the code and the rate', () => {
  it('a rate-only edit of a ZAR draft to 0.5 or to 2 is a 400', async () => {
    const c = await company();
    const inv = await plantInvoice(pool, c, owner);
    for (const exchangeRate of [0.5, 2]) {
      const res = await put(c, { id: inv.id, items, exchangeRate });
      expect(res.state.statusCode, String(exchangeRate)).toBe(400);
      expect(messageOf(res)).toMatch(/exchange rate must be 1/);
    }
    expect(await row('customer_invoices', inv.id)).toMatchObject({ rate: '1.000000' });
  });

  it('a non-string or malformed currency code is a 400, and writes nothing', async () => {
    const c = await company(true);
    const client = await customer(c);
    for (const currencyCode of [42, 'USDX', 'U$']) {
      const res = await create(c, { clientId: client, currencyCode, exchangeRate: 18.5 });
      expect(res.state.statusCode, JSON.stringify(currencyCode)).toBe(400);
      expect(messageOf(res)).toMatch(/three-letter ISO currency code/);
    }
    expect((await pool.query('SELECT count(*)::INT AS n FROM customer_invoices WHERE company_id = $1', [c])).rows[0].n).toBe(0);
  });

  it('a blank or padded code is the functional currency', async () => {
    const c = await company();
    const client = await customer(c);
    for (const currencyCode of [' ', ' ZAR ']) {
      const res = await create(c, { clientId: client, currencyCode });
      expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(201);
    }
    const { rows } = await pool.query('SELECT DISTINCT currency_code FROM customer_invoices WHERE company_id = $1', [c]);
    expect(rows).toEqual([{ currency_code: 'ZAR' }]);
  });
});

describe('a NULL or 0 stored rate converts at 1', () => {
  it('customer draft edit', async () => {
    const c = await company();
    for (const stored of [null, 0]) {
      const inv = await plantInvoice(pool, c, owner);
      await pool.query('UPDATE customer_invoices SET exchange_rate = $2 WHERE id = $1', [inv.id, stored]);
      expect((await put(c, { id: inv.id, items })).state.statusCode).toBe(200);
      expect((await row('customer_invoices', inv.id)).f, String(stored)).toBe('2300.00');
    }
  });

  it('supplier draft update', async () => {
    const c = await company();
    const bill = await plantBill(pool, c, owner);
    await pool.query('UPDATE supplier_invoices SET exchange_rate = 0 WHERE id = $1', [bill.id]);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await als.run({ client, userId: owner, companyId: c, claims: {} } as never, async () => {
        const plan = await lockAndPlanSupplierInvoiceDraftUpdate(c, bill.id, {
          items: [{ description: 'Fibre build', quantity: 1, unitPrice: 2000, taxRate: 15, glAccountId: bill.accountA }],
        });
        await applySupplierInvoiceDraftUpdate(c, plan, owner);
      });
      await client.query('COMMIT');
    } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
    expect(await row('supplier_invoices', bill.id)).toMatchObject({ total: '2300.00', f: '2300.00' });
  });
});

describe('a rate beyond six places is stored to six and converted at the stored rate', () => {
  it('customer and supplier create: 20 000 at 1.0000005 is 1.000001, functional 20 000.02', async () => {
    const c = await company(true);
    const client = await customer(c);
    const inv = await create(c, { clientId: client, currencyCode: 'USD', exchangeRate: 1.0000005, taxRate: 0,
      items: [{ description: 'Consulting', quantity: 1, unitPrice: 20000 }] });
    expect(inv.state.statusCode, JSON.stringify(inv.state.body)).toBe(201);
    const invId = (inv.state.body as { data: { id: string } }).data.id;
    expect(await row('customer_invoices', invId)).toMatchObject({ rate: '1.000001', f: '20000.02' });

    const bill = await plantBill(pool, c, owner);
    const res = await callRoute(supplierInvoices, tokens[owner]!, c, 'POST', {
      supplierId: bill.supplierId, invoiceDate: '2026-09-01', invoiceNumber: `FX-${crypto.randomUUID().slice(0, 8)}`,
      currencyCode: 'USD', exchangeRate: 1.0000005,
      items: [{ description: 'Fibre build', quantity: 1, unitPrice: 20000, taxRate: 0, glAccountId: bill.accountA }],
    }, '/api/accounting/supplier-invoices');
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(201);
    const { rows } = await pool.query(
      `SELECT exchange_rate::text AS rate, functional_total::text AS f FROM supplier_invoices WHERE company_id = $1 AND currency_code = 'USD'`, [c]);
    expect(rows).toEqual([{ rate: '1.000001', f: '20000.02' }]);
  });
});

describe('a credit note cannot be linked to a foreign invoice', () => {
  it('a 400 at create, before any write', async () => {
    const c = await company(true);
    const inv = await plantInvoice(pool, c, owner, { currencyCode: 'USD', exchangeRate: 18.5, status: 'sent' });
    await pool.query('UPDATE companies SET fx_documents_enabled = false WHERE id = $1', [c]);
    const res = await callRoute(creditNotes, tokens[owner]!, c, 'POST', {
      type: 'customer', clientId: inv.customerId, customerInvoiceId: inv.id, creditDate: '2026-09-15', subtotal: 100,
    }, '/api/accounting/credit-notes');
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
    expect(messageOf(res)).toMatch(/linked invoice cannot be credited: USD invoices are not enabled/);
    expect((await pool.query('SELECT count(*)::INT AS n FROM credit_notes WHERE company_id = $1', [c])).rows[0].n).toBe(0);
  });
});

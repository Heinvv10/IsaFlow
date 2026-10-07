/**
 * FX PR0 review round 2, through the real routes and services:
 *
 * - A draft document journal already linked to a legacy foreign document
 *   cannot be posted by hand (postJournalEntry: MCP post_journal, the journal
 *   screen) while the switch is off — "probe B".
 * - An AR receipt naming a foreign invoice is a 400 that says so, before any
 *   write; bank-match suggestions leave foreign documents out.
 * - The supplier legacy `currency` column alone makes a bill foreign: to pay
 *   it, approve it, credit it, or pick it automatically. A stored blank code
 *   is the functional currency.
 * - The draft edit's rate override is cast ::NUMERIC(18,6); an items-only edit
 *   of a ZAR draft whose stored rate is not 1 is a 400.
 * - The open-document readers exclude foreign rows on their unlocked read too.
 * - The exchange-rate routes answer a non-decimal amount with a 400.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import customerInvoicesDetail from '../../pages/api/accounting/customer-invoices-detail';
import customerPayments from '../../pages/api/accounting/customer-payments';
import supplierPayments from '../../pages/api/accounting/supplier-payments';
import supplierCreditNotes from '../../pages/api/accounting/supplier-credit-notes';
import exchangeRates from '../../pages/api/accounting/exchange-rates';
import exchangeRateConvert from '../../pages/api/accounting/exchange-rate-convert';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, enableFxDocuments, plantBill } from './r035-approval.helpers';
import { cleanupPr3, noteCompany } from './r035-pr3.helpers';
import { invoiceRoutes, invoiceState, plantInvoice } from './r035-pr4.helpers';
import { messageOf, routes } from './r035-pr2.helpers';
import { als } from '@/lib/als';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostService';
import { planAllocationLines } from '@/modules/accounting/services/ar/receiptAllocationLines';
import { fetchCustomerInvoiceCandidates, fetchSupplierInvoiceCandidates } from '@/modules/accounting/services/bank/bankMatchDbQueries';
import { getReceiptMatchCandidates } from '@/modules/accounting/services/ar/receiptMatchService';
import { fetchOpenCustomerInvoices } from '@/modules/accounting/services/ar/openCustomerInvoices';
import { fetchOpenSupplierBills } from '@/modules/accounting/services/ap/openSupplierBills';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let owner = '';
const inv = invoiceRoutes(tokens);
const ap = routes(tokens);
const DISABLED = /USD (invoice|bill)s are not enabled for this company/;

beforeAll(async () => { owner = await createUser(pool, tokens); });
afterAll(async () => {
  for (const q of [
    'DELETE FROM exchange_rates WHERE company_id = ANY($1)',
    'DELETE FROM bank_transactions WHERE company_id = ANY($1)',
    'DELETE FROM customer_payment_allocations WHERE payment_id IN (SELECT id FROM customer_payments WHERE company_id = ANY($1))',
    'DELETE FROM customer_payments WHERE company_id = ANY($1)',
    'DELETE FROM supplier_payments WHERE company_id = ANY($1)',
  ]) await pool.query(q, [companies]);
  await cleanupPr3(pool, companies, [owner]);
});

const company = async (fx = false) => {
  const c = await noteCompany(pool, [[owner, 'owner']], companies);
  if (fx) await enableFxDocuments(pool, c);
  return c;
};
const off = (c: string) => pool.query('UPDATE companies SET fx_documents_enabled = false WHERE id = $1', [c]);
async function inTx<T>(c: string, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run({ client, userId: owner, companyId: c, claims: {} } as never, fn);
    await client.query('COMMIT');
    return out;
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
}
/** A legacy ZAR-coded bill whose LEGACY `currency` column says USD, approved while the switch was on. */
async function legacyCurrencyBill(c: string, status = 'approved') {
  const bill = await plantBill(pool, c, owner);
  await pool.query("UPDATE supplier_invoices SET currency = 'USD', status = $2 WHERE id = $1", [bill.id, status]);
  return bill;
}

describe('probe B: a hand-posted document journal', () => {
  it('a draft auto_invoice journal linked to a USD invoice is refused by postJournalEntry once the switch is off', async () => {
    const c = await company(true);
    const invoice = await plantInvoice(pool, c, owner, { currencyCode: 'USD', exchangeRate: 18.5, status: 'approved' });
    const { rows: [je] } = await pool.query(
      `INSERT INTO gl_journal_entries(company_id, entry_date, description, source, status, created_by)
       VALUES($1, DATE '2026-09-01', 'probe B', 'auto_invoice', 'draft', $2) RETURNING id`, [c, owner]);
    await pool.query(
      `INSERT INTO gl_journal_lines(journal_entry_id, company_id, gl_account_id, debit, credit)
       SELECT $1, $2, id, CASE WHEN account_subtype = 'receivable' THEN 1150 ELSE 0 END,
              CASE WHEN account_subtype = 'receivable' THEN 0 ELSE 1150 END
       FROM gl_accounts WHERE company_id = $2 AND account_subtype IN ('receivable', 'default_revenue')`, [je.id, c]);
    await pool.query('UPDATE customer_invoices SET gl_journal_entry_id = $2 WHERE id = $1', [invoice.id, je.id]);
    await off(c);
    await expect(inTx(c, () => postJournalEntry(c, je.id, owner))).rejects.toThrow(DISABLED);
    expect((await pool.query('SELECT status FROM gl_journal_entries WHERE id = $1', [je.id])).rows[0].status).toBe('draft');
  });
});

describe('AR receipts against a foreign invoice', () => {
  it('createCustomerPayment and the receipt application refuse it with a 400 naming the currency, writing nothing', async () => {
    const c = await company(true);
    const invoice = await plantInvoice(pool, c, owner, { currencyCode: 'USD', exchangeRate: 18.5, status: 'sent' });
    await off(c);
    const res = await callRoute(customerPayments, tokens[owner]!, c, 'POST', {
      clientId: invoice.customerId, paymentDate: '2026-09-15', totalAmount: 100,
      allocations: [{ invoiceId: invoice.id, amount: 100 }] }, '/api/accounting/customer-payments');
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
    expect(messageOf(res)).toMatch(/cannot take this receipt: USD invoices are not enabled/);
    expect((await pool.query('SELECT count(*)::INT AS n FROM customer_payments WHERE company_id = $1', [c])).rows[0].n).toBe(0);
    await expect(inTx(c, () => planAllocationLines(c, [{ invoiceId: invoice.id, amount: 10 }], { paymentId: null, customerId: null })))
      .rejects.toThrow(/cannot take this receipt: USD invoices are not enabled/);
  });

  it('bank-match suggestions leave foreign invoices and bills out', async () => {
    const c = await company(true);
    const usd = await plantInvoice(pool, c, owner, { currencyCode: 'USD', exchangeRate: 18.5, status: 'sent' });
    const zar = await plantInvoice(pool, c, owner, { status: 'sent' });
    const usdBill = await legacyCurrencyBill(c);
    const zarBill = await plantBill(pool, c, owner);
    await pool.query("UPDATE supplier_invoices SET status = 'approved' WHERE id = $1", [zarBill.id]);
    const ar = await fetchCustomerInvoiceCandidates(c, 1150, 1150, '2026-09-15', 'receipt', '', []);
    expect(ar.map((m) => m.id)).toContain(zar.id);
    expect(ar.map((m) => m.id)).not.toContain(usd.id);
    const bills = await fetchSupplierInvoiceCandidates(c, 1150, -1150, '2026-09-15', 'payment', '', []);
    expect(bills.map((m) => m.id)).toContain(zarBill.id);
    expect(bills.map((m) => m.id)).not.toContain(usdBill.id);
    // The receipt-match pool (ar/receipt-match) is a reader of its own.
    const tx = crypto.randomUUID();
    await pool.query(
      `INSERT INTO bank_transactions(id, company_id, bank_account_id, transaction_date, amount, description)
       SELECT $1, $2, id, DATE '2026-09-15', 1150, 'receipt' FROM gl_accounts WHERE company_id = $2 AND account_subtype = 'receivable'`, [tx, c]);
    const pool2 = (await getReceiptMatchCandidates(tx, c)).candidates.map((m) => m.id);
    expect(pool2).toContain(zar.id);
    expect(pool2).not.toContain(usd.id);
  });
});

describe('the supplier legacy `currency` column alone makes a bill foreign', () => {
  it('paying it is a 400; approving a draft one is a 400; the open-bill readers leave it out, locked or not', async () => {
    const c = await company(true);
    const paid = await legacyCurrencyBill(c);
    const draft = await legacyCurrencyBill(c, 'draft');
    await off(c);
    const pay = await callRoute(supplierPayments, tokens[owner]!, c, 'POST', {
      supplierId: paid.supplierId, paymentDate: '2026-09-15', totalAmount: 100, reference: 'FX2',
      allocations: [{ invoiceId: paid.id, amount: 100 }] }, '/api/accounting/supplier-payments');
    expect(pay.state.statusCode).toBe(400);
    expect(messageOf(pay)).toMatch(/cannot be paid: USD bills are not enabled/);
    const approve = await ap.approveBill(owner, c, draft.id);
    expect(approve.state.statusCode).toBe(400);
    expect(messageOf(approve)).toMatch(DISABLED);
    for (const forUpdate of [false, true]) {
      const open = await inTx(c, () => fetchOpenSupplierBills(c, paid.supplierId, true, { forUpdate }));
      expect(open.map((d) => d.invoiceId), String(forUpdate)).not.toContain(paid.id);
    }
  });

  it('a supplier credit note may not be linked to it: a 400 on the supplier route', async () => {
    const c = await company(true);
    const bill = await legacyCurrencyBill(c);
    await off(c);
    const res = await callRoute(supplierCreditNotes, tokens[owner]!, c, 'POST', {
      supplierId: bill.supplierId, supplierInvoiceId: bill.id, creditDate: '2026-09-15', description: 'FX2',
      lineItems: [{ description: 'Returned', quantity: 1, unitPrice: 100, vatType: 'standard' }], submitAction: 'draft',
    }, '/api/accounting/supplier-credit-notes');
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
    expect(messageOf(res)).toMatch(/linked bill cannot be credited: USD bills are not enabled/);
  });

  it('a stored blank code is the functional currency: that invoice approves and posts', async () => {
    const c = await company();
    const invoice = await plantInvoice(pool, c, owner);
    await pool.query("UPDATE customer_invoices SET currency_code = ' ' WHERE id = $1", [invoice.id]);
    const res = await inv.approve(owner, c, invoice.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect((await invoiceState(pool, invoice.id)).journals).toBe(1);
  });
});

describe('the customer readers and the draft edit', () => {
  it('fetchOpenCustomerInvoices excludes a foreign invoice on its UNLOCKED read too', async () => {
    const c = await company(true);
    const usd = await plantInvoice(pool, c, owner, { currencyCode: 'USD', exchangeRate: 18.5, status: 'sent' });
    await off(c);
    const open = await inTx(c, () => fetchOpenCustomerInvoices(c, usd.customerId, true, { forUpdate: false }));
    expect(open.map((d) => d.invoiceId)).not.toContain(usd.id);
  });

  const put = (c: string, body: unknown) =>
    callRoute(customerInvoicesDetail, tokens[owner]!, c, 'PUT', body, '/api/accounting/customer-invoices-detail');

  it('the edit casts a rate override to six places: 20 000 at 1.0000005 stores 1.000001 and 20 000.02', async () => {
    const c = await company(true);
    const draft = await plantInvoice(pool, c, owner);
    const res = await put(c, { id: draft.id, taxRate: 0, currencyCode: 'USD', exchangeRate: 1.0000005,
      items: [{ description: 'Consulting', quantity: 1, unitPrice: 20000 }] });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const { rows } = await pool.query('SELECT exchange_rate::text AS r, functional_total::text AS f FROM customer_invoices WHERE id = $1', [draft.id]);
    expect(rows).toEqual([{ r: '1.000001', f: '20000.02' }]);
  });

  it('an items-only edit of a ZAR draft whose stored rate is 2 is a 400', async () => {
    const c = await company();
    const draft = await plantInvoice(pool, c, owner);
    await pool.query('UPDATE customer_invoices SET exchange_rate = 2 WHERE id = $1', [draft.id]);
    const res = await put(c, { id: draft.id, items: [{ description: 'Consulting', quantity: 1, unitPrice: 10 }] });
    expect(res.state.statusCode).toBe(400);
    expect(messageOf(res)).toMatch(/exchange rate must be 1/);
  });
});

describe('the exchange-rate routes answer a non-decimal amount with a 400', () => {
  it('Infinity and 1e21, on both conversion routes', async () => {
    const c = await company();
    await pool.query(
      `INSERT INTO exchange_rates(company_id, from_currency, to_currency, rate, effective_date) VALUES($1, 'USD', 'ZAR', 18.5, DATE '2026-01-01')`, [c]);
    for (const amount of ['Infinity', '1e21']) {
      const listed = await callRoute(exchangeRates, tokens[owner]!, c, 'GET', undefined, '/api/accounting/exchange-rates',
        { convert: 'true', from: 'USD', to: 'ZAR', amount });
      expect(listed.state.statusCode, `${amount}: ${JSON.stringify(listed.state.body)}`).toBe(400);
      const pure = await callRoute(exchangeRateConvert, tokens[owner]!, c, 'POST', { amount, fromCurrency: 'USD', toCurrency: 'ZAR' },
        '/api/accounting/exchange-rate-convert');
      expect(pure.state.statusCode, `${amount}: ${JSON.stringify(pure.state.body)}`).toBe(400);
    }
  });
});

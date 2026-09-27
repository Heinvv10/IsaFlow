/**
 * R-035 PR2 review HIGH-1: a rule is matched on the amount an approval must
 * cover, and that amount cannot be steered through the exchange rate.
 *
 * The attack: a R500 000 ZAR bill with exchangeRate 0.0001 carried a
 * functional_total of R50, matched no rule, and approve posted R500 000 —
 * approveSupplierInvoice books total_amount, not the functional figure. Fixed
 * by (a) matching on GREATEST(total_amount, functional_total) in the gate, the
 * backstop and the preview, and (b) refusing an exchange rate other than 1 on a
 * bill in the company's own currency.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import supplierInvoices from '../../pages/api/accounting/supplier-invoices';
import approvalEnforcement from '../../pages/api/accounting/approval-enforcement';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantBill, plantRule, reasonOf } from './r035-approval.helpers';
import { billState, cleanupPr2, dataOf, enforce, messageOf, postableCompany, routes } from './r035-pr2.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '' };
const r = routes(tokens);

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(async () => {
  await pool.query('DELETE FROM company_document_numbers WHERE company_id = ANY($1)', [companies]);
  await cleanupPr2(pool, companies, Object.values(u));
});

/** An owner rule over R100 000, enforced. A (admin) books; B is an owner. */
async function fixture() {
  const c = await postableCompany(pool, [[u.a, 'admin'], [u.b, 'owner']], companies);
  await plantRule(pool, c, 'owner', { operator: 'greater_than', value: 100000 });
  await enforce(pool, c, u.b);
  const bill = await plantBill(pool, c, u.a);
  return { c, supplierId: bill.supplierId, account: bill.accountA };
}

/** A planted draft rescaled to R500 000 gross, lines included, stored at ZAR 0.0001 → R50 functional. */
async function legacyBill(c: string) {
  const bill = await plantBill(pool, c, u.a, { total: 500000, functionalTotal: 50, exchangeRate: 0.0001 });
  await pool.query('UPDATE supplier_invoices SET subtotal = 434782.61, tax_amount = 65217.39 WHERE id = $1', [bill.id]);
  await pool.query(
    `UPDATE supplier_invoice_items SET unit_price = CASE description WHEN 'Line A' THEN 150000 ELSE 134782.61 END,
       line_total = CASE description WHEN 'Line A' THEN 300000 ELSE 134782.61 END,
       tax_amount = CASE description WHEN 'Line A' THEN 45000 ELSE 20217.39 END
     WHERE supplier_invoice_id = $1`, [bill.id]);
  return bill;
}

/** R500 000 gross: 434 782.61 net + 15% VAT, in `currencyCode` at `exchangeRate`. */
const create = (c: string, supplierId: string, account: string, currencyCode: string, exchangeRate: number) =>
  callRoute(supplierInvoices, tokens[u.a]!, c, 'POST', {
    supplierId, invoiceDate: '2026-09-01', invoiceNumber: `R035-FX-${crypto.randomUUID().slice(0, 8)}`,
    currencyCode, exchangeRate,
    items: [{ description: 'Fibre build', quantity: 1, unitPrice: 434782.61, taxRate: 15, glAccountId: account }],
  }, '/api/accounting/supplier-invoices');

describe('the exchange rate cannot shrink the amount a rule sees', () => {
  it('refuses a ZAR bill carrying an exchange rate other than 1, writing nothing', async () => {
    const { c, supplierId, account } = await fixture();
    const before = (await pool.query('SELECT count(*)::INT AS n FROM supplier_invoices WHERE company_id = $1', [c])).rows[0].n;
    const res = await create(c, supplierId, account, 'ZAR', 0.0001);
    expect(res.state.statusCode).toBe(400);
    expect(messageOf(res)).toMatch(/exchange rate/i);
    expect((await pool.query('SELECT count(*)::INT AS n FROM supplier_invoices WHERE company_id = $1', [c])).rows[0].n).toBe(before);
  });

  it('a legacy ZAR bill stored at 0.0001 (R50 functional) is still gated on its R500 000 at approve', async () => {
    const { c } = await fixture();
    const bill = await legacyBill(c);
    const res = await r.approveBill(u.a, c, bill.id);
    expect(res.state.statusCode).toBe(409);
    expect(reasonOf(res)).toBe('APPROVAL_REQUIRED');
    expect(await billState(pool, bill.id)).toEqual({ status: 'draft', gl_journal_entry_id: null, journals: 0 });
  });

  it('a USD bill created at 0.0001 through the real route is gated on the R500 000 it would post', async () => {
    const { c, supplierId, account } = await fixture();
    const created = await create(c, supplierId, account, 'USD', 0.0001);
    expect(created.state.statusCode, JSON.stringify(created.state.body)).toBe(201);
    const id = dataOf<{ id: string }>(created).id;
    const res = await r.approveBill(u.a, c, id);
    expect(res.state.statusCode).toBe(409);
    expect(reasonOf(res)).toBe('APPROVAL_REQUIRED');
    expect((await billState(pool, id)).journals).toBe(0);
  });

  it('the backstop and the preview see the same amount', async () => {
    const { c } = await fixture();
    const bill = await legacyBill(c);
    await expect(pool.query("UPDATE supplier_invoices SET status = 'approved' WHERE id = $1", [bill.id]))
      .rejects.toThrow(/R035_APPROVAL_REQUIRED/);
    const res = await callRoute(approvalEnforcement, tokens[u.b]!, c, 'GET', undefined,
      '/api/accounting/approval-enforcement', { preview: '1' });
    expect(dataOf<{ preview: Record<string, number> }>(res).preview).toEqual({ supplier_invoice: 1 });
  });
});

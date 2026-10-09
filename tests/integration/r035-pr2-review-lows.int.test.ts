/**
 * R-035 PR2 review LOW-2 and LOW-3.
 *
 *  - LOW-2: a payment allocated to a gated DRAFT bill would end as the
 *    backstop's 500 when processing moved the bill to 'paid'. The allocation
 *    paths already refuse a bill outside the payable statuses
 *    (billAllocatable), before any write: both creating such a payment and
 *    processing one planted against a draft answer a clean 4xx.
 *  - LOW-3: the enforcement preview hashes every unposted bill, so the plain
 *    GET no longer computes it — only `?preview=1`, which the Enforce switch asks for.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import supplierPayments from '../../pages/api/accounting/supplier-payments';
import supplierPaymentsAction from '../../pages/api/accounting/supplier-payments-action';
import approvalEnforcement from '../../pages/api/accounting/approval-enforcement';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantBill, plantRule } from './r035-approval.helpers';
import { billState, cleanupPr2, dataOf, enforce, postableCompany } from './r035-pr2.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { owner: '' };

beforeAll(async () => { u.owner = await createUser(pool, tokens); });
afterAll(async () => {
  await pool.query('DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM supplier_payments WHERE company_id = ANY($1))', [companies]);
  await pool.query('DELETE FROM supplier_payments WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM company_document_numbers WHERE company_id = ANY($1)', [companies]);
  await cleanupPr2(pool, companies, Object.values(u));
});

async function gatedDraft() {
  const c = await postableCompany(pool, [[u.owner, 'owner']], companies);
  await pool.query(
    `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_active,is_system_account,account_subtype)
     VALUES ($1,'BK${c.slice(0, 6)}','R035 Bank','asset','debit',true,true,'bank')`, [c]);
  await plantRule(pool, c, 'owner');
  await enforce(pool, c, u.owner);
  return { c, bill: await plantBill(pool, c, u.owner) };
}

const payments = async (c: string) => (await pool.query(
  'SELECT status FROM supplier_payments WHERE company_id = $1', [c])).rows.map((x) => x.status as string);

describe('paying a gated draft (LOW-2)', () => {
  it('creating a payment allocated to it is a 4xx and writes no payment', async () => {
    const { c, bill } = await gatedDraft();
    const res = await callRoute(supplierPayments, tokens[u.owner]!, c, 'POST', {
      supplierId: bill.supplierId, paymentDate: '2026-09-10', totalAmount: 1150,
      allocations: [{ invoiceId: bill.id, amount: 1150 }],
    }, '/api/accounting/supplier-payments');
    expect(res.state.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.state.statusCode).toBeLessThan(500);
    expect(await payments(c)).toEqual([]);
    expect((await billState(pool, bill.id)).status).toBe('draft');
  });

  it('processing a payment planted against it is a 4xx, before any journal', async () => {
    const { c, bill } = await gatedDraft();
    const { rows: [payment] } = await pool.query(
      `INSERT INTO supplier_payments(company_id, supplier_id, payment_date, total_amount, status, created_by, payment_number)
       VALUES($1,$2,DATE '2026-09-10',1150,'approved',$3,'R035-PAY-1') RETURNING id`, [c, bill.supplierId, u.owner]);
    await pool.query('INSERT INTO payment_allocations(payment_id, invoice_id, amount_allocated) VALUES($1,$2,1150)', [payment.id, bill.id]);
    const res = await callRoute(supplierPaymentsAction, tokens[u.owner]!, c, 'POST',
      { action: 'process', paymentId: payment.id }, '/api/accounting/supplier-payments-action');
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBeGreaterThanOrEqual(400);
    expect(res.state.statusCode).toBeLessThan(500);
    expect(await payments(c)).toEqual(['approved']);
    expect(await billState(pool, bill.id)).toMatchObject({ status: 'draft', journals: 0 });
    expect((await pool.query('SELECT count(*)::INT AS n FROM gl_journal_entries WHERE company_id = $1', [c])).rows[0].n).toBe(0);
  });
});

describe('the enforcement preview is computed on demand (LOW-3)', () => {
  const get = (c: string, query: Record<string, string> = {}) => callRoute(approvalEnforcement, tokens[u.owner]!, c, 'GET',
    undefined, '/api/accounting/approval-enforcement', query);

  it('the plain GET carries no preview', async () => {
    const { c } = await gatedDraft();
    const data = dataOf<Record<string, unknown>>(await get(c));
    expect(data).toMatchObject({ enforceable: ['supplier_invoice', 'customer_credit_note', 'supplier_credit_note', 'customer_invoice',
      'supplier_payment', 'payment_batch', 'manual_journal', 'supplier_bank_details', 'bank_rule'] });
    expect(data).not.toHaveProperty('preview');
  });

  it('?preview=1 computes it', async () => {
    const { c } = await gatedDraft();
    expect(dataOf<{ preview: Record<string, number> }>(await get(c, { preview: '1' })).preview)
      .toEqual({ supplier_invoice: 1, customer_credit_note: 0, supplier_credit_note: 0, customer_invoice: 0,
        supplier_payment: 0, payment_batch: 0, manual_journal: 0, supplier_bank_details: 0 });
  });
});

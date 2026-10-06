/**
 * R-035 PR4 review F3: confirming a receipt allocated to a DRAFT invoice that
 * an enforced rule governs moves the invoice into the AR population without
 * approving it, so the backstop (migration 865) refuses it. Through the real
 * route (customer-payments-action): confirmCustomerPayment's savepoint rolls
 * the whole confirm back and the route answers 409 with a plain message —
 * not 400 with the raw trigger text — and nothing is committed: the receipt
 * stays a draft, no journal, the invoice untouched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import customerPaymentsAction from '../../pages/api/accounting/customer-payments-action';
import { clearSystemAccountCache } from '../../src/modules/accounting/services/gl/systemAccountResolver';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantRule, reasonOf } from './r035-approval.helpers';
import { messageOf } from './r035-pr2.helpers';
import { cleanupPr4, enforceInvoices, invoiceCompany, invoiceState, plantInvoice } from './r035-pr4.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '' };

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(() => cleanupPr4(pool, companies, Object.values(u)));

async function fixture(enforced: boolean) {
  const c = await invoiceCompany(pool, [[u.a, 'admin'], [u.b, 'owner']], companies);
  await pool.query(
    `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_active,is_system_account,account_subtype)
     VALUES ($1,$2,'R035 bank','asset','debit',true,true,'bank')`, [c, `BK${c.slice(0, 6)}`]);
  clearSystemAccountCache(c);
  await plantRule(pool, c, 'owner', { documentType: 'customer_invoice' });
  if (enforced) await enforceInvoices(pool, c, u.b);
  const inv = await plantInvoice(pool, c, u.a);
  const { rows: [p] } = await pool.query(
    `INSERT INTO customer_payments(company_id,client_id,payment_date,total_amount,status,created_by,payment_number)
     VALUES($1,$2,DATE '2026-09-02',1150,'draft',$3,$4) RETURNING id`, [c, inv.customerId, u.a, `PAY-${inv.id.slice(0, 8)}`]);
  await pool.query('INSERT INTO customer_payment_allocations(payment_id,invoice_id,amount_allocated) VALUES($1,$2,1150)', [p.id, inv.id]);
  return { c, inv, paymentId: String(p.id) };
}

const confirm = (c: string, paymentId: string) => callRoute(customerPaymentsAction, tokens[u.a]!, c, 'POST',
  { action: 'confirm', paymentId }, '/api/accounting/customer-payments-action');

describe('customer-payments-action confirm on a gated draft invoice', () => {
  it('answers 409 with a plain message and commits nothing', async () => {
    const { c, inv, paymentId } = await fixture(true);
    const res = await confirm(c, paymentId);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
    expect(reasonOf(res)).toBe('APPROVAL_REQUIRED');
    expect(messageOf(res)).not.toMatch(/R035_|customer_invoice_approval_gate|AR population/);
    expect(messageOf(res)).toMatch(/approv/i);
    const { rows: [p] } = await pool.query('SELECT status, gl_journal_entry_id FROM customer_payments WHERE id = $1', [paymentId]);
    expect(p).toEqual({ status: 'draft', gl_journal_entry_id: null });
    expect(await invoiceState(pool, inv.id)).toMatchObject({ status: 'draft', gl_journal_entry_id: null });
    const { rows: [n] } = await pool.query(
      `SELECT (SELECT count(*)::INT FROM gl_journal_entries WHERE company_id = $1) AS journals,
              (SELECT amount_paid::FLOAT8 FROM customer_invoices WHERE id = $2) AS paid`, [c, inv.id]);
    expect(n).toEqual({ journals: 0, paid: 0 });
  });

  it('enforcement off: confirms as before', async () => {
    const { c, inv, paymentId } = await fixture(false);
    expect((await confirm(c, paymentId)).state.statusCode).toBe(200);
    expect((await invoiceState(pool, inv.id)).status).toBe('paid');
  });
});

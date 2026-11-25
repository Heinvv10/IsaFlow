/**
 * R-035 PR4 review F3: confirming a receipt allocated to a DRAFT invoice that
 * an enforced rule governs moves the invoice into the AR population without
 * approving it, so the backstop (migration 865) refuses it. Through the real
 * route (customer-payments-action): confirmCustomerPayment's savepoint rolls
 * the whole confirm back and the route answers 409 with a plain message —
 * not 400 with the raw trigger text — and nothing is committed: the receipt
 * stays a draft, no journal, the invoice untouched.
 *
 * #1728 review M1: confirm now refuses ANY draft invoice under its lock, before the journal (assertInvoiceTakesReceipts,
 * the create path's rule), so the route answers that 400 first, rule or no rule, and the backstop is a line behind it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
/**
 * #1728 follow-up L1: confirm can no longer reach the backstop — its under-lock refusal answers a draft invoice first
 * and its apply CASE keeps a non-derived status — so the route's `respondIfBackstopRefused` is a line behind both.
 * `backstop.invoice` swaps confirm for the write the backstop exists to refuse (the draft invoice to 'paid', in confirm's
 * own savepoint), so the REAL trigger error reaches the route's catch.
 */
const backstop = vi.hoisted(() => ({ invoice: null as string | null }));
vi.mock('@/modules/accounting/services/ar/customerPaymentAllocationService', async (orig) => {
  const real = await orig<typeof import('@/modules/accounting/services/ar/customerPaymentAllocationService')>();
  const { sql, withSavepoint } = await import('@/lib/neon');
  return {
    ...real,
    confirmCustomerPayment: (...a: Parameters<typeof real.confirmCustomerPayment>) => (backstop.invoice
      ? withSavepoint('confirm_customer_payment', async () => {
        await sql`UPDATE customer_invoices SET status = 'paid' WHERE id = ${backstop.invoice}::UUID AND company_id = ${a[0]}::UUID`;
        throw new Error('unreachable: the backstop let a draft invoice become paid');
      })
      : real.confirmCustomerPayment(...a)),
  };
});
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
  it('answers 400 with a plain message and commits nothing', async () => {
    const { c, inv, paymentId } = await fixture(true);
    const res = await confirm(c, paymentId);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
    expect(messageOf(res)).not.toMatch(/R035_|customer_invoice_approval_gate|AR population/);
    expect(messageOf(res)).toMatch(/is draft and cannot take this receipt/);
    const { rows: [p] } = await pool.query('SELECT status, gl_journal_entry_id FROM customer_payments WHERE id = $1', [paymentId]);
    expect(p).toEqual({ status: 'draft', gl_journal_entry_id: null });
    expect(await invoiceState(pool, inv.id)).toMatchObject({ status: 'draft', gl_journal_entry_id: null });
    const { rows: [n] } = await pool.query(
      `SELECT (SELECT count(*)::INT FROM gl_journal_entries WHERE company_id = $1) AS journals,
              (SELECT amount_paid::FLOAT8 FROM customer_invoices WHERE id = $2) AS paid`, [c, inv.id]);
    expect(n).toEqual({ journals: 0, paid: 0 });
  });

  // The backstop (migration 865) behind both: the route answers its refusal 409 APPROVAL_REQUIRED in plain words
  // (respondIfBackstopRefused), and the savepoint has rolled the write back.
  it('behind the refusal: the backstop answers 409 APPROVAL_REQUIRED and commits nothing', async () => {
    const { c, inv, paymentId } = await fixture(true);
    backstop.invoice = inv.id;
    try {
      const res = await confirm(c, paymentId);
      expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
      expect(reasonOf(res)).toBe('APPROVAL_REQUIRED');
      expect(messageOf(res)).not.toMatch(/R035_|customer_invoice_approval_gate|AR population/);
      expect(messageOf(res)).toMatch(/needs approval before it can enter accounts receivable/);
    } finally {
      backstop.invoice = null;
    }
    const { rows: [p] } = await pool.query('SELECT status, gl_journal_entry_id FROM customer_payments WHERE id = $1', [paymentId]);
    expect(p).toEqual({ status: 'draft', gl_journal_entry_id: null });
    expect(await invoiceState(pool, inv.id)).toMatchObject({ status: 'draft', gl_journal_entry_id: null });
    const { rows: [n] } = await pool.query(
      `SELECT (SELECT count(*)::INT FROM gl_journal_entries WHERE company_id = $1) AS journals,
              (SELECT amount_paid::FLOAT8 FROM customer_invoices WHERE id = $2) AS paid`, [c, inv.id]);
    expect(n).toEqual({ journals: 0, paid: 0 });
  });

  it('enforcement off: refused the same (a draft invoice has no receivable to settle)', async () => {
    const { c, inv, paymentId } = await fixture(false);
    expect((await confirm(c, paymentId)).state.statusCode).toBe(400);
    expect(await invoiceState(pool, inv.id)).toMatchObject({ status: 'draft' });
    expect((await pool.query('SELECT amount_paid::FLOAT8 AS paid FROM customer_invoices WHERE id = $1', [inv.id])).rows[0].paid).toBe(0);
  });
});

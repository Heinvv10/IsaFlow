/**
 * A payment taken off an invoice moves its status only within the balance-derived states (#1720 review, reachability): the
 * cancel of a customer receipt and the void of a supplier payment set the document back to 'approved' whatever its status,
 * so cash applied to a PENDING-APPROVAL invoice and then cancelled approved it without its approval decision, and a 'sent' /
 * 'overdue' invoice lost that state (the guarded recompute keeps both).
 *  - a pending_approval invoice takes no receipt on the application path either (the create path's population rule);
 *  - cancelCustomerPayment's reversal leaves a status outside BALANCE_DERIVED alone and keeps 'sent' / 'overdue';
 *  - voidSupplierPayment's reversal (the AP mirror) leaves a bill outside BALANCE_DERIVED ('disputed', 'pending_approval') alone.
 * Real routes and services against the disposable fixture.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import type { NextApiRequest } from 'next';
import { assertDisposable, response } from './mfa-impersonation-postgres.helpers';
import { cleanupK074, seedBill, seedInvoice, seedK074, DAY, type K074Fixture } from './helpers/k074Fixture';

vi.mock('@/lib/auth', () => ({ withAuth: (fn: unknown) => fn, withWriteAccess: (fn: unknown) => fn }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));

import { als } from '@/lib/als';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { cancelCustomerPayment } from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import { applyReceiptPlan, planReceiptApplication } from '@/modules/accounting/services/ar/receiptApplicationService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let fx: K074Fixture;
beforeEach(async () => { fx = await seedK074(pool); clearSystemAccountCache(fx.company); });
afterEach(async () => { await cleanupK074(pool, fx); });

/** One request transaction: committed unless the callback throws. */
async function inTx<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: Error }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run({ client, userId: fx.user, companyId: fx.company, claims: {} }, async () => {
      try { return { value: await fn() }; } catch (error) { return { error: error as Error }; }
    });
    await client.query(out.error ? 'ROLLBACK' : 'COMMIT');
    return out;
  } finally { client.release(); }
}
const invoice = async (id: string) => (await pool.query(
  'SELECT status, amount_paid::float8 AS paid FROM customer_invoices WHERE id = $1', [id])).rows[0] as { status: string; paid: number };
const bill = async (id: string) => (await pool.query(
  'SELECT status, amount_paid::float8 AS paid FROM supplier_invoices WHERE id = $1', [id])).rows[0] as { status: string; paid: number };

/** A confirmed receipt with its whole amount unapplied (what a bank-line receipt or an unapplied refund leaves). */
const unappliedReceipt = async (amount: number) => (await pool.query(
  `INSERT INTO customer_payments(company_id, client_id, payment_date, total_amount, payment_method, status, created_by, bank_account_id)
   VALUES ($1, $2, $3, $4, 'eft', 'confirmed', $5, $6) RETURNING id`,
  [fx.company, fx.customer, DAY, amount, fx.user, fx.bankAccount])).rows[0].id as string;
const apply = (payment: string, invoiceId: string, amount: number) => inTx(async () =>
  applyReceiptPlan(fx.company, await planReceiptApplication(fx.company, payment, [{ invoiceId, amount }]), fx.user));

describe('customer receipts', () => {
  it('a pending_approval invoice takes no receipt on the application path (refused, nothing written)', async () => {
    const inv = await seedInvoice(pool, fx, 1000, { status: 'pending_approval' });
    const pay = await unappliedReceipt(1500);
    const out = await apply(pay, inv, 1000);
    expect(out.error?.name).toBe('ReceiptRefusal');
    expect(out.error?.message).toMatch(/pending_approval and cannot receive a receipt/);
    expect(await invoice(inv)).toEqual({ status: 'pending_approval', paid: 0 });
  }, 60_000);

  it('the callers answer it as a refusal, not a fault: customer-allocations 400, MCP apply_receipt_to_invoice a tool error', async () => {
    const inv = await seedInvoice(pool, fx, 1000, { status: 'pending_approval' });
    const pay = await unappliedReceipt(1500);
    const route = (await import('../../pages/api/accounting/customer-allocations')).default as (req: NextApiRequest, res: unknown) => Promise<unknown>;
    const result = response();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await als.run({ client, userId: fx.user, companyId: fx.company, claims: {} }, async () => {
        await route({ method: 'POST', body: { paymentId: pay, allocations: [{ invoiceId: inv, amount: 1000 }] }, companyId: fx.company,
          companyRole: 'owner', user: { id: fx.user } } as unknown as NextApiRequest, result.res);
      });
      await client.query('ROLLBACK');
    } finally { client.release(); }
    expect(result.state.statusCode, JSON.stringify(result.state.body)).toBe(400);
    expect(JSON.stringify(result.state.body)).toMatch(/pending_approval and cannot receive a receipt/);

    const { applyReceiptToInvoiceTool } = await import('@/lib/mcp/tools/writeApplyReceipt');
    const tool = await inTx(() => applyReceiptToInvoiceTool.handler({ payment_id: pay, allocations: [{ invoice_id: inv, amount: 1000 }],
      idempotency_key: crypto.randomUUID() }, { companyId: fx.company, userId: fx.user, tokenJti: 'jti', scopes: ['write:invoices', 'write:post'] } as never));
    const answer = tool.value as { isError?: boolean; content: { text: string }[] };
    expect(answer.isError, JSON.stringify(answer)).toBe(true);
    expect(answer.content[0]!.text).toMatch(/pending_approval and cannot receive a receipt/);
    expect(await invoice(inv)).toEqual({ status: 'pending_approval', paid: 0 });
  }, 60_000);

  it('a cancel never approves an invoice outside the balance-derived states (cash on it from before the guard)', async () => {
    const inv = await seedInvoice(pool, fx, 1000);
    const [first, second] = [await unappliedReceipt(1500), await unappliedReceipt(1500)]; // partly applied: both stay 'confirmed'
    expect((await apply(first, inv, 600)).error).toBeUndefined();
    expect((await apply(second, inv, 300)).error).toBeUndefined();
    await pool.query("UPDATE customer_invoices SET status = 'pending_approval' WHERE id = $1", [inv]); // legacy cash on a pending invoice
    // Cash still on it after the cancel: not 'partially_paid' either; the status is not the payment's to move.
    expect((await inTx(() => cancelCustomerPayment(fx.company, second, fx.user, 'test'))).error).toBeUndefined();
    expect(await invoice(inv)).toEqual({ status: 'pending_approval', paid: 600 });
    expect((await inTx(() => cancelCustomerPayment(fx.company, first, fx.user, 'test'))).error).toBeUndefined();
    expect(await invoice(inv)).toEqual({ status: 'pending_approval', paid: 0 }); // the money comes off; the status is not approved
  }, 60_000);

  it.each(['sent', 'overdue'])('a cancel keeps a %s invoice in that state when its last receipt comes off (the recompute rule)', async (state) => {
    const inv = await seedInvoice(pool, fx, 1000);
    const pay = await unappliedReceipt(1500);
    expect((await apply(pay, inv, 400)).error).toBeUndefined();
    await pool.query('UPDATE customer_invoices SET status = $2 WHERE id = $1', [inv, state]); // the sweep / the send moved it
    expect((await inTx(() => cancelCustomerPayment(fx.company, pay, fx.user, 'test'))).error).toBeUndefined();
    expect(await invoice(inv)).toEqual({ status: state, paid: 0 });
  }, 60_000);

  it('a cancel still reopens a paid / partly paid invoice as before', async () => {
    const [whole, part] = [await seedInvoice(pool, fx, 400), await seedInvoice(pool, fx, 1000)];
    const pay = await unappliedReceipt(1500);
    expect((await apply(pay, whole, 400)).error).toBeUndefined();
    expect((await apply(pay, part, 300)).error).toBeUndefined();
    expect((await invoice(whole)).status).toBe('paid');
    expect((await inTx(() => cancelCustomerPayment(fx.company, pay, fx.user, 'test'))).error).toBeUndefined();
    expect(await invoice(whole)).toEqual({ status: 'approved', paid: 0 });
    expect(await invoice(part)).toEqual({ status: 'approved', paid: 0 });
  }, 60_000);
});

/** Drive supplier-payments-action in a request transaction (committed below 500). */
async function paymentAction(action: 'process' | 'void', paymentId: string): Promise<{ status: number; body: unknown }> {
  const handler = (await import('../../pages/api/accounting/supplier-payments-action')).default as
    (req: NextApiRequest, res: unknown) => Promise<unknown>;
  const result = response();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await als.run({ client, userId: fx.user, companyId: fx.company, claims: {} }, async () => {
      await handler({ method: 'POST', body: { action, paymentId }, companyId: fx.company, user: { id: fx.user } } as unknown as NextApiRequest, result.res);
    });
    await client.query(result.state.statusCode < 500 ? 'COMMIT' : 'ROLLBACK');
  } finally { client.release(); }
  return { status: result.state.statusCode, body: result.state.body };
}
async function processedPayment(billId: string, amount: number): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(`INSERT INTO supplier_payments(id, company_id, supplier_id, payment_date, total_amount, payment_method, status, created_by, bank_account_id)
    VALUES ($1, $2, $3, $4, $5, 'eft', 'approved', $6, $7)`, [id, fx.company, fx.supplier, DAY, amount, fx.user, fx.bankAccount]);
  await pool.query('INSERT INTO payment_allocations(id, payment_id, invoice_id, amount_allocated) VALUES ($1, $2, $3, $4)',
    [crypto.randomUUID(), id, billId, amount]);
  const processed = await paymentAction('process', id);
  expect(processed.status, JSON.stringify(processed.body)).toBe(200);
  return id;
}

describe('supplier payments (the AP mirror)', () => {
  it.each(['disputed', 'pending_approval'])('a void leaves a %s bill in that state (the money comes off, the status is not approved)', async (state) => {
    const b = await seedBill(pool, fx, 1000);
    const [first, second] = [await processedPayment(b, 400), await processedPayment(b, 300)];
    await pool.query('UPDATE supplier_invoices SET status = $2 WHERE id = $1', [b, state]);
    const voided = await paymentAction('void', second);
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(await bill(b)).toEqual({ status: state, paid: 400 }); // not 'partially_paid'
    expect((await paymentAction('void', first)).status).toBe(200);
    expect(await bill(b)).toEqual({ status: state, paid: 0 });
  }, 60_000);

  it('a void still reopens a partly paid bill as before', async () => {
    const b = await seedBill(pool, fx, 1000);
    const pay = await processedPayment(b, 400);
    expect((await bill(b)).status).toBe('partially_paid');
    expect((await paymentAction('void', pay)).status).toBe(200);
    expect(await bill(b)).toEqual({ status: 'approved', paid: 0 });
  }, 60_000);
});

/**
 * A payment taken off an invoice moves its status only within the balance-derived states (#1720 review, reachability): the
 * cancel of a customer receipt and the void of a supplier payment set the document back to 'approved' whatever its status,
 * so cash applied to a PENDING-APPROVAL invoice and then cancelled approved it without its approval decision, and a 'sent' /
 * 'overdue' invoice lost that state (the guarded recompute keeps both).
 *  - a pending_approval invoice takes no receipt on the application path either (the create path's population rule);
 *  - cancelCustomerPayment's reversal leaves a status outside BALANCE_DERIVED alone and keeps 'sent' / 'overdue';
 *  - voidSupplierPayment's reversal (the AP mirror) leaves a bill outside BALANCE_DERIVED ('disputed', 'pending_approval') alone,
 *    and moves paid_at / payment_matched(_at) with the money (#1728 review L1);
 *  - confirming a legacy DRAFT receipt on a draft / pending invoice is refused (#1728 review M1);
 *  - the apply writes (receipt confirm, supplier payment process, batch process) keep a status outside BALANCE_DERIVED
 *    behind their under-lock refusals: proven with the refusal switched off for that test (`bypass`) (#1728 review L3).
 * Real routes and services against the disposable fixture, every request as app_user (no superuser, RLS on).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import type { NextApiRequest } from 'next';
import { assertDisposable, response } from './mfa-impersonation-postgres.helpers';
import { cleanupK074, seedBill, seedInvoice, seedK074, DAY, type K074Fixture } from './helpers/k074Fixture';

vi.mock('@/lib/auth', () => ({ withAuth: (fn: unknown) => fn, withWriteAccess: (fn: unknown) => fn }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
/** The under-lock refusals, switched off only where a test proves the write's own guard behind them. */
const bypass = vi.hoisted(() => ({ on: false }));
vi.mock('@/modules/accounting/services/ap/billAllocatable', async (orig) => {
  const real = await orig<typeof import('@/modules/accounting/services/ap/billAllocatable')>();
  return { ...real, assertBillAllocatable: (...a: Parameters<typeof real.assertBillAllocatable>) => (bypass.on ? undefined : real.assertBillAllocatable(...a)) };
});
vi.mock('@/modules/accounting/services/ar/receiptInvoiceLock', async (orig) => {
  const real = await orig<typeof import('@/modules/accounting/services/ar/receiptInvoiceLock')>();
  return { ...real, assertInvoiceTakesReceipts: (...a: Parameters<typeof real.assertInvoiceTakesReceipts>) => (bypass.on ? undefined : real.assertInvoiceTakesReceipts(...a)) };
});

import { als } from '@/lib/als';
import { sql } from '@/lib/neon';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { cancelCustomerPayment } from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import { applyReceiptPlan, planReceiptApplication } from '@/modules/accounting/services/ar/receiptApplicationService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let fx: K074Fixture;
beforeEach(async () => { bypass.on = false; fx = await seedK074(pool); clearSystemAccountCache(fx.company); });
afterEach(async () => { await cleanupK074(pool, fx); });

/** As withAuth opens a request: app_user (no superuser, RLS on), the member's claims and the active company. */
async function asAppUser(client: PoolClient): Promise<void> {
  await client.query('SET LOCAL ROLE app_user');
  await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: fx.user })]);
  await client.query("SELECT set_config('app.current_company_id', $1, true)", [fx.company]);
  const { rows: [who] } = await client.query('SELECT current_user AS role, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su');
  if (who.role !== 'app_user' || who.su !== false) throw new Error(`expected app_user without superuser, got ${JSON.stringify(who)}`);
}
const bind = <T>(client: PoolClient, fn: () => Promise<T>) => als.run({ client, userId: fx.user, companyId: fx.company, claims: { sub: fx.user } } as never, fn);

/** One request transaction as app_user: committed unless the callback throws. `before` runs first, as the fixture's superuser. */
async function inTx<T>(fn: () => Promise<T>, before?: (c: PoolClient) => Promise<void>, keep = true): Promise<{ value?: T; error?: Error; read?: unknown }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (before) await before(client);
    await asAppUser(client);
    const out = await bind(client, async () => {
      try { return { value: await fn() }; } catch (error) { return { error: error as Error }; }
    });
    await client.query(out.error || !keep ? 'ROLLBACK' : 'COMMIT');
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
      await asAppUser(client);
      await bind(client, async () => {
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

  // #1728 review M1: a DRAFT receipt stored before the guard, allocated to a draft / pending invoice, is refused at confirm
  it.each(['pending_approval', 'draft'])('confirming a legacy draft receipt on a %s invoice is refused 400 (no journal, nothing paid)', async (state) => {
    const inv = await seedInvoice(pool, fx, 1000, { status: state });
    const pay = (await pool.query(`INSERT INTO customer_payments(company_id, client_id, payment_date, total_amount, payment_method, status, created_by, bank_account_id)
      VALUES ($1, $2, $3, 1000, 'eft', 'draft', $4, $5) RETURNING id`, [fx.company, fx.customer, DAY, fx.user, fx.bankAccount])).rows[0].id as string;
    await pool.query('INSERT INTO customer_payment_allocations(payment_id, invoice_id, amount_allocated) VALUES ($1, $2, 1000)', [pay, inv]);
    const out = await routeCall('../../pages/api/accounting/customer-payments-action', { action: 'confirm', paymentId: pay });
    expect(out.status, JSON.stringify(out.body)).toBe(400);
    expect(JSON.stringify(out.body)).toMatch(new RegExp(`is ${state} and cannot take this receipt`));
    expect(await invoice(inv)).toEqual({ status: state, paid: 0 });
    const { rows } = await pool.query('SELECT status, gl_journal_entry_id FROM customer_payments WHERE id = $1', [pay]);
    expect(rows[0]).toEqual({ status: 'draft', gl_journal_entry_id: null });
  }, 60_000);

  it('the confirm write keeps a pending_approval status behind the refusal (refusal off, rolled back)', async () => {
    const { confirmCustomerPayment } = await import('@/modules/accounting/services/ar/customerPaymentAllocationService');
    const inv = await seedInvoice(pool, fx, 1000, { status: 'pending_approval' });
    const pay = (await pool.query(`INSERT INTO customer_payments(company_id, client_id, payment_date, total_amount, payment_method, status, created_by, bank_account_id)
      VALUES ($1, $2, $3, 1000, 'eft', 'draft', $4, $5) RETURNING id`, [fx.company, fx.customer, DAY, fx.user, fx.bankAccount])).rows[0].id as string;
    await pool.query('INSERT INTO customer_payment_allocations(payment_id, invoice_id, amount_allocated) VALUES ($1, $2, 1000)', [pay, inv]);
    bypass.on = true;
    const out = await inTx(async () => {
      await confirmCustomerPayment(fx.company, pay, fx.user);
      return (await sql`SELECT status, amount_paid::float8 AS paid FROM customer_invoices WHERE id = ${inv}::UUID`)[0];
    }, undefined, false);
    expect(out.error).toBeUndefined();
    expect(out.value).toEqual({ status: 'pending_approval', paid: 1000 }); // not 'paid'
  }, 60_000);

  // #1728 review L2: the 'paid' arm. With amount_paid <= total (migration 899's CHECK) a positive allocation never leaves it
  // covered, so the arm is the recompute's rule kept for a row the CHECK did not see: driven with the CHECK lifted, rolled back.
  it('a cancel leaves an invoice still fully covered by other money paid (the CHECK lifted in a rolled-back transaction)', async () => {
    const inv = await seedInvoice(pool, fx, 1000);
    const pay = await unappliedReceipt(1500);
    expect((await apply(pay, inv, 400)).error).toBeUndefined();
    const out = await inTx(async () => {
      await cancelCustomerPayment(fx.company, pay, fx.user, 'test');
      // read in the same (rolled-back) transaction
      return (await sql`SELECT status, amount_paid::float8 AS paid FROM customer_invoices WHERE id = ${inv}::UUID`)[0];
    }, async (c) => {
      await c.query('ALTER TABLE customer_invoices DROP CONSTRAINT IF EXISTS customer_invoices_amount_paid_within_total');
      await c.query("UPDATE customer_invoices SET amount_paid = 1500, status = 'paid' WHERE id = $1", [inv]); // 1100 left after 400 off
    }, false);
    expect(out.error).toBeUndefined();
    expect(out.value).toEqual({ status: 'paid', paid: 1100 });
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
async function routeCall(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const handler = (await import(/* @vite-ignore */ path)).default as (req: NextApiRequest, res: unknown) => Promise<unknown>;
  const result = response();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await asAppUser(client);
    await bind(client, async () => {
      await handler({ method: 'POST', body, companyId: fx.company, companyRole: 'owner', user: { id: fx.user } } as unknown as NextApiRequest, result.res);
    });
    await client.query(result.state.statusCode < 500 ? 'COMMIT' : 'ROLLBACK');
  } finally { client.release(); }
  return { status: result.state.statusCode, body: result.state.body };
}
const paymentAction = (action: 'process' | 'void', paymentId: string) =>
  routeCall('../../pages/api/accounting/supplier-payments-action', { action, paymentId });
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

  // #1728 review L1: a void through moveSupplierBillPaid moves the bill's four derived columns together
  it('a void of the payment that settled a bill reopens it: status, paid_at, payment_matched and payment_matched_at', async () => {
    const b = await seedBill(pool, fx, 1000);
    const pay = await processedPayment(b, 1000);
    // process writes the status only; the apply-unapplied path (moveSupplierBillPaid) and the bank match stamp the rest
    await pool.query('UPDATE supplier_invoices SET paid_at = NOW(), payment_matched = true, payment_matched_at = NOW() WHERE id = $1', [b]);
    const cols = async () => (await pool.query(`SELECT status, amount_paid::float8 AS paid, paid_at IS NOT NULL AS paid_at,
      payment_matched, payment_matched_at IS NOT NULL AS matched_at FROM supplier_invoices WHERE id = $1`, [b])).rows[0];
    expect(await cols()).toEqual({ status: 'paid', paid: 1000, paid_at: true, payment_matched: true, matched_at: true });
    expect((await paymentAction('void', pay)).status).toBe(200);
    expect(await cols()).toEqual({ status: 'approved', paid: 0, paid_at: false, payment_matched: false, matched_at: false });
  }, 60_000);

  // #1728 review L3: the apply side too, defence in depth: a payment processed onto a bill that is no longer balance-derived
  it('processing a payment onto a disputed bill moves the money, not the status', async () => {
    const b = await seedBill(pool, fx, 1000);
    const id = crypto.randomUUID();
    await pool.query(`INSERT INTO supplier_payments(id, company_id, supplier_id, payment_date, total_amount, payment_method, status, created_by, bank_account_id)
      VALUES ($1, $2, $3, $4, 400, 'eft', 'approved', $5, $6)`, [id, fx.company, fx.supplier, DAY, fx.user, fx.bankAccount]);
    await pool.query('INSERT INTO payment_allocations(id, payment_id, invoice_id, amount_allocated) VALUES ($1, $2, $3, 400)', [crypto.randomUUID(), id, b]);
    await pool.query("UPDATE supplier_invoices SET status = 'disputed' WHERE id = $1", [b]);
    expect((await paymentAction('process', id)).status).toBe(400); // the under-lock refusal answers first
    bypass.on = true;
    const processed = await paymentAction('process', id);
    expect(processed.status, JSON.stringify(processed.body)).toBe(200);
    expect(await bill(b)).toEqual({ status: 'disputed', paid: 400 });
  }, 60_000);

  it('a void still reopens a partly paid bill as before', async () => {
    const b = await seedBill(pool, fx, 1000);
    const pay = await processedPayment(b, 400);
    expect((await bill(b)).status).toBe('partially_paid');
    expect((await paymentAction('void', pay)).status).toBe(200);
    expect(await bill(b)).toEqual({ status: 'approved', paid: 0 });
  }, 60_000);
});

describe('payment batches (the AP batch apply)', () => {
  it('processing a batch onto a bill that went disputed moves the money, not the status', async () => {
    const { createUser } = await import('./r035-approval.helpers');
    const { cleanupPr5, payCompany, plantBill, plantSupplier } = await import('./r035-pr5.helpers');
    const { approveBatch, createBatch, processBatch } = await import('@/modules/accounting/services/ap/batchPaymentService');
    const companies: string[] = [];
    const own = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 }); // cleanupPr5 ends the pool it is given
    const user = await createUser(own, {});
    try {
      const { company, bank } = await payCompany(own, [[user, 'admin']], companies);
      const supplierId = await plantSupplier(own, company);
      const billId = await plantBill(own, company, supplierId, user, 5000);
      /** A request transaction as app_user for this company. */
      const asUser = async <T>(fn: () => Promise<T>): Promise<T> => {
        const client = await own.connect();
        try {
          await client.query('BEGIN');
          await client.query('SET LOCAL ROLE app_user');
          await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user })]);
          await client.query("SELECT set_config('app.current_company_id', $1, true)", [company]);
          const out = await als.run({ client, userId: user, companyId: company, claims: { sub: user } } as never, fn);
          await client.query('COMMIT');
          return out;
        } catch (err) { await client.query('ROLLBACK').catch(() => undefined); throw err; } finally { client.release(); }
      };
      const batch = await asUser(() => createBatch(company, { batchDate: '2026-09-01', bankAccountId: bank,
        payments: [{ supplierId, invoiceAllocations: [{ invoiceId: billId, amount: 1000 }] }] }, user));
      await asUser(() => approveBatch(company, batch.id, user));
      await own.query("UPDATE supplier_invoices SET status = 'disputed' WHERE id = $1", [billId]); // disputed after approval
      await expect(asUser(() => processBatch(company, batch.id, user))).rejects.toThrow(/is disputed and cannot receive a payment/);
      bypass.on = true;
      await asUser(() => processBatch(company, batch.id, user));
      const { rows } = await own.query('SELECT status, amount_paid::float8 AS paid FROM supplier_invoices WHERE id = $1', [billId]);
      expect(rows[0]).toEqual({ status: 'disputed', paid: 1000 });
    } finally {
      await cleanupPr5(own, companies, [user]);
    }
  }, 90_000);
});

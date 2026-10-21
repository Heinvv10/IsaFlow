/**
 * Customer receipt confirm/cancel derive the invoice status in whole cents.
 *
 * Both used a one-cent tolerance: confirming total - 0.01 flipped an invoice to 'paid' (paid_at set) with a cent
 * still owing, and cancelling a receipt that left 0.01 paid reset it to 'approved'. Asserted by OUTCOME: the
 * invoice row's status / paid_at / amount_paid after the service call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupK074, seedInvoice, seedK074, type K074Fixture } from './helpers/k074Fixture';

vi.mock('@/lib/auth', () => ({ withAuth: (fn: unknown) => fn, withWriteAccess: (fn: unknown) => fn }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));

import { als } from '@/lib/als';
import { createCustomerPayment } from '@/modules/accounting/services/ar/customerPaymentService';
import { cancelCustomerPayment, confirmCustomerPayment } from '@/modules/accounting/services/ar/customerPaymentAllocationService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let fx: K074Fixture;

beforeEach(async () => { fx = await seedK074(pool); });
afterEach(async () => { await cleanupK074(pool, fx); });

/** One request transaction, committed unless the callback throws (what withAuth does for a 4xx). */
async function inTx<T>(fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run({ client, userId: fx.user, companyId: fx.company, claims: {} }, fn);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Create and confirm a receipt of `amount` against `invoiceId`; returns the payment id. */
async function receive(invoiceId: string, amount: number): Promise<string> {
  const draft = await inTx(() => createCustomerPayment(fx.company, {
    clientId: fx.customer, paymentDate: '2026-05-15', totalAmount: amount, paymentMethod: 'eft',
    bankAccountId: fx.bankAccount, allocations: [{ invoiceId, amount }],
  }, fx.user));
  await inTx(() => confirmCustomerPayment(fx.company, draft.id, fx.user));
  return draft.id;
}

const cancel = (paymentId: string) => inTx(() => cancelCustomerPayment(fx.company, paymentId, fx.user, 'cents'));

async function invoice(id: string): Promise<{ status: string; paidAt: Date | null; paid: number }> {
  const { rows } = await pool.query(
    'SELECT status, paid_at, amount_paid::float8 AS paid FROM customer_invoices WHERE id=$1', [id]);
  return { status: rows[0].status, paidAt: rows[0].paid_at, paid: rows[0].paid };
}

describe('confirm, whole cents', () => {
  it('a receipt a cent short of the total leaves the invoice partially_paid with no paid_at', async () => {
    const id = await seedInvoice(pool, fx, 115);
    await receive(id, 114.99);
    expect(await invoice(id)).toEqual({ status: 'partially_paid', paidAt: null, paid: 114.99 });
  });

  it('a receipt of exactly the total marks the invoice paid and dates it', async () => {
    const id = await seedInvoice(pool, fx, 115);
    await receive(id, 115);
    const row = await invoice(id);
    expect(row.status).toBe('paid');
    expect(row.paidAt).toBeInstanceOf(Date);
    expect(row.paid).toBe(115);
  });
});

describe('cancel, whole cents', () => {
  it('cancelling a receipt that leaves a cent paid keeps the invoice partially_paid', async () => {
    const id = await seedInvoice(pool, fx, 115);
    await receive(id, 0.01);
    const big = await receive(id, 114.99);
    expect((await invoice(id)).status).toBe('paid');

    await cancel(big);

    expect(await invoice(id)).toEqual({ status: 'partially_paid', paidAt: null, paid: 0.01 });
  });

  it('cancelling one of two receipts on a paid invoice drops the paid date with the paid status', async () => {
    const id = await seedInvoice(pool, fx, 115);
    await receive(id, 100);
    const last = await receive(id, 15);
    expect((await invoice(id)).paidAt).toBeInstanceOf(Date);

    await cancel(last);

    expect(await invoice(id)).toEqual({ status: 'partially_paid', paidAt: null, paid: 100 });
  });

  it('cancelling the only receipt returns the invoice to approved', async () => {
    const id = await seedInvoice(pool, fx, 115);
    const only = await receive(id, 115);

    await cancel(only);

    expect(await invoice(id)).toEqual({ status: 'approved', paidAt: null, paid: 0 });
  });
});

/**
 * 899 — createCustomerPayment judges a draft receipt in whole cents, like confirm.
 *
 * The balance check was already exact (assertWithinOutstanding), but the allocations-vs-payment-total check beside it
 * was `Math.abs(sum - total) > 0.01` on floats: a draft whose allocations ran a cent over (or under) its own total was
 * accepted or refused by float luck, and refused as a plain Error (a 500, not a typed 4xx). Asserted by OUTCOME: the
 * refusal type, and that no payment or allocation row was written.
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
import { isReceiptRefusal } from '@/modules/accounting/services/ar/receiptRefusal';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let fx: K074Fixture;

beforeEach(async () => { fx = await seedK074(pool); });
afterEach(async () => { await cleanupK074(pool, fx); });

/** One request transaction, committed unless the callback throws (what withAuth does for a 4xx). */
async function inTx<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: unknown }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run({ client, userId: fx.user, companyId: fx.company, claims: {} }, async () => {
      try { return { value: await fn() }; } catch (error) { return { error }; }
    });
    await client.query('COMMIT');
    return out;
  } finally {
    client.release();
  }
}

const create = (totalAmount: number, allocations: { invoiceId: string; amount: number }[]) =>
  inTx(() => createCustomerPayment(fx.company, {
    clientId: fx.customer, paymentDate: '2026-05-15', totalAmount, paymentMethod: 'eft', bankAccountId: fx.bankAccount,
    allocations,
  }, fx.user));

const rows = async () => ({
  payments: (await pool.query('SELECT count(*)::int AS n FROM customer_payments WHERE company_id=$1', [fx.company])).rows[0].n as number,
  allocations: (await pool.query(
    `SELECT count(*)::int AS n FROM customer_payment_allocations a JOIN customer_payments p ON p.id = a.payment_id
      WHERE p.company_id=$1`, [fx.company])).rows[0].n as number,
});

describe('draft receipt create, whole cents', () => {
  it.each([
    ['allocations a cent over the payment total', 100, 100.01],
    ['allocations a cent under the payment total', 100.01, 100],
    ['allocations two cents over', 100, 100.02],
  ])('%s is a typed refusal and nothing is written', async (_n, total, allocated) => {
    const invoice = await seedInvoice(pool, fx, 500);
    const res = await create(total, [{ invoiceId: invoice, amount: allocated }]);
    expect(isReceiptRefusal(res.error), String((res.error as Error | undefined)?.message)).toBe(true);
    expect((res.error as Error).message).toMatch(/does not match payment/);
    expect(await rows()).toEqual({ payments: 0, allocations: 0 });
  });

  it('a cent over the invoice balance is a typed refusal and nothing is written', async () => {
    const invoice = await seedInvoice(pool, fx, 115);
    const res = await create(115.01, [{ invoiceId: invoice, amount: 115.01 }]);
    expect(isReceiptRefusal(res.error)).toBe(true);
    expect((res.error as Error).message).toMatch(/exceeds invoice balance R115\.00/);
    expect(await rows()).toEqual({ payments: 0, allocations: 0 });
  });

  it('the exact balance, and allocations that sum to the total only up to float noise, are accepted', async () => {
    const exact = await seedInvoice(pool, fx, 115);
    expect((await create(115, [{ invoiceId: exact, amount: 115 }])).error).toBeUndefined();
    const a = await seedInvoice(pool, fx, 100);
    const b = await seedInvoice(pool, fx, 100);
    // 0.1 + 0.2 = 0.30000000000000004: a float artefact, not a cent.
    const noisy = await create(0.3, [{ invoiceId: a, amount: 0.1 }, { invoiceId: b, amount: 0.2 }]);
    expect(noisy.error).toBeUndefined();
    expect(await rows()).toEqual({ payments: 2, allocations: 3 });
  });
});

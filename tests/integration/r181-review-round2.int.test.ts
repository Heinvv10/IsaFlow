/**
 * R-181 review round 2 (adversarial): when `requested_amount` may be trusted, the fee leg's clamp,
 * a non-ZAR receipt left unapplied, and the customer re-read under the invoice lock.
 *
 * - `requested_amount` is the receipt only when the excess `amount - requested_amount` is a fee the
 *   customer paid: 0 <= excess <= fees. Otherwise `amount` is banked and the request flagged, and
 *   the fee leg makes Bank net to `amount - fees`, what Paystack settles.
 * - The fee leg is `fees - (amount - banked)` clamped to [0, fees]; a clamp that bites is flagged.
 * - A customer merge that commits between the unlocked invoice read and the invoice lock must not
 *   leave the receipt on the merged-away customer.
 *
 * Real Postgres, real routes; only the Paystack client is stubbed, and the locked invoice read can
 * run a callback first (the merge) to place it inside the race window.
 */
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { A, SECRET, checkout, cleanup, deliver, invoice, ledger, pool, seed, settlement, verify } from './r181-settlement.helpers';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';

assertDisposable();

const h = vi.hoisted(() => ({
  verifyTransaction: vi.fn(),
  beforeLockedRead: null as null | (() => Promise<void>),
  fired: 0,
}));
vi.mock('@/modules/billing/services/paystackClient', () => ({
  verifyTransaction: (...a: unknown[]) => h.verifyTransaction(...a),
  chargeAuthorization: vi.fn(async () => { throw new Error('Paystack must not be charged in this test'); }),
}));
vi.mock('@/lib/neon', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/neon')>();
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const before = h.beforeLockedRead;
    if (before && strings.join(' ').includes('locked_total')) {
      h.beforeLockedRead = null;
      h.fired += 1;
      return before().then(() => original.sql(strings, ...values));
    }
    return original.sql(strings, ...values);
  };
  Object.assign(sql, { transaction: original.sql.transaction, unsafe: original.sql.unsafe, query: original.sql.query });
  return { ...original, sql };
});

const paystackSays = (amountCents: number, extra: Record<string, unknown> = {}) => h.verifyTransaction.mockResolvedValue(
  { status: 'success', id: 1813, amountCents, currency: 'ZAR', paidAt: new Date().toISOString(), channel: 'card', ...extra });

beforeAll(async () => {
  vi.stubEnv('PAYSTACK_SECRET_KEY', SECRET);
  await seed(A);
  clearSystemAccountCache();
});
beforeEach(() => { h.verifyTransaction.mockReset(); h.beforeLockedRead = null; h.fired = 0; });
afterAll(async () => { vi.unstubAllEnvs(); await cleanup([A]); });

describe('MEDIUM: requested_amount is trusted only when the excess is a fee the customer paid', () => {
  it('requested_amount R50 on a R103 charge with R3 fees: R103 banked, R3 fee, Bank nets R100, flagged', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id, 10000);
    expect((await deliver(ref, 10300, 'ZAR', { requested_amount: 5000, fees: 300 })).statusCode).toBe(200);
    expect(await settlement(A, ref, id)).toMatchObject({
      payments: [{ total: '103.00' }], review: 'review:amount_mismatch,requested_amount_exceeds_fee' });
    expect(await ledger(A, ref)).toMatchObject({ bankNet: '100.00', feeExpense: '3.00', balanced: true });
  });

  it('excess R3 above R2 fees: R103 banked, R2 fee, Bank nets R101, flagged', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id, 10000);
    expect((await deliver(ref, 10300, 'ZAR', { requested_amount: 10000, fees: 200 })).statusCode).toBe(200);
    expect(await settlement(A, ref, id)).toMatchObject({
      payments: [{ total: '103.00' }], review: 'review:amount_mismatch,requested_amount_exceeds_fee' });
    expect(await ledger(A, ref)).toMatchObject({ bankNet: '101.00', feeExpense: '2.00', balanced: true });
  });

  it('verify with no fee figure banks amount (flagged unverified); the webhook fee then nets Bank to the settlement', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id);
    paystackSays(11850, { requestedAmountCents: 11500, feesCents: null });
    expect((await verify(ref)).body.data?.status).toBe('completed');
    expect((await settlement(A, ref, id)).payments).toMatchObject([{ total: '118.50' }]);
    expect((await settlement(A, ref, id)).review).toContain('requested_amount_unverified');
    expect((await deliver(ref, 11850, 'ZAR', { requested_amount: 11500, fees: 350 })).statusCode).toBe(200);
    expect(await ledger(A, ref)).toMatchObject({ bankNet: '115.00', feeExpense: '3.50', balanced: true });
  });

  it('verify with requested_amount equal to amount needs no fee figure: R115 banked, no review', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id);
    paystackSays(11500, { requestedAmountCents: 11500, feesCents: null });
    expect((await verify(ref)).body.data?.status).toBe('completed');
    expect(await settlement(A, ref, id)).toMatchObject({ payments: [{ total: '115.00', allocated: '115.00' }], review: null });
  });

  it('verify with the fee figure trusts requested_amount: R115 banked, no review', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id);
    paystackSays(11850, { requestedAmountCents: 11500, feesCents: 350 });
    expect((await verify(ref)).body.data?.status).toBe('completed');
    expect(await settlement(A, ref, id)).toMatchObject({ payments: [{ total: '115.00', allocated: '115.00' }], review: null });
  });
});

describe('LOW: the fee leg is fees - (amount - banked), clamped to [0, fees]', () => {
  it('verify banks R103, then the webhook (requested_amount R100, fees R3): the full R3 fee, Bank nets R100', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id, 10000);
    paystackSays(10300);
    expect((await verify(ref)).body.data?.status).toBe('completed');
    expect((await deliver(ref, 10300, 'ZAR', { requested_amount: 10000, fees: 300 })).statusCode).toBe(200);
    expect(await ledger(A, ref)).toMatchObject({ bankNet: '100.00', feeExpense: '3.00', balanced: true });
  });

  it('verify banks R100, then the webhook reports R103 with R3 fees: no fee expense, Bank nets R100', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id, 10000);
    paystackSays(10000);
    expect((await verify(ref)).body.data?.status).toBe('completed');
    expect((await deliver(ref, 10300, 'ZAR', { requested_amount: 10000, fees: 300 })).statusCode).toBe(200);
    expect(await ledger(A, ref)).toMatchObject({ bankNet: '100.00', feeExpense: '0.00', balanced: true });
    expect((await settlement(A, ref, id)).review).toBeNull();
  });

  it('verify banks R100, then the webhook reports R103 with R3 fees and no requested_amount: no fee, Bank nets R100, flagged', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id, 10000);
    paystackSays(10000);
    expect((await verify(ref)).body.data?.status).toBe('completed');
    expect((await deliver(ref, 10300, 'ZAR', { fees: 300 })).statusCode).toBe(200);
    expect(await ledger(A, ref)).toMatchObject({ bankNet: '100.00', feeExpense: '0.00', balanced: true });
    expect((await settlement(A, ref, id)).review).toBe('review:amount_mismatch,amount_disagrees_with_first_report');
  });

  it('a clamp that bites is flagged: R100 banked, then R105 with R3 fees (Bank cannot reach R102)', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id, 10000);
    paystackSays(10000);
    expect((await verify(ref)).body.data?.status).toBe('completed');
    expect((await deliver(ref, 10500, 'ZAR', { requested_amount: 10000, fees: 300 })).statusCode).toBe(200);
    expect(await ledger(A, ref)).toMatchObject({ bankNet: '100.00', feeExpense: '0.00' });
    expect((await settlement(A, ref, id)).review).toContain('fee_clamped');
  });
});

describe('LOW: a non-ZAR receipt is banked but never allocated to the ZAR invoice', () => {
  it('USD R115: banked unapplied, the invoice untouched, flagged', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id);
    expect((await deliver(ref, 11500, 'USD')).statusCode).toBe(200);
    expect(await settlement(A, ref, id)).toEqual({
      payments: [{ total: '115.00', allocated: '0.00', status: 'confirmed' }],
      bankDebit: '115.00', invoicePaid: '0.00', review: 'review:currency_mismatch,unapplied_currency' });
  });
});

describe('LOW: the customer is re-read under the invoice lock', () => {
  it('a merge committed between the unlocked read and the lock: the receipt lands on the surviving customer', async () => {
    const survivor = randomUUID();
    await pool.query('INSERT INTO customers (id, company_id, name) VALUES ($1, $2, $3)', [survivor, A.id, 'R181 survivor']);
    const merged = randomUUID();
    await pool.query('INSERT INTO customers (id, company_id, name) VALUES ($1, $2, $3)', [merged, A.id, 'R181 merged away']);
    const id = await invoice(A);
    await pool.query('UPDATE customer_invoices SET customer_id = $2, client_id = $2 WHERE id = $1', [id, merged]);
    const ref = await checkout(A, id);
    // What customerMergeService commits for the invoice: moved to the target, the source soft-deleted.
    h.beforeLockedRead = async () => {
      await pool.query('UPDATE customer_invoices SET customer_id = $2, client_id = $2 WHERE id = $1', [id, survivor]);
      await pool.query("UPDATE customers SET deleted_at = NOW(), name = name || ' [MERGED]' WHERE id = $1", [merged]);
    };
    expect((await deliver(ref, 11500)).statusCode).toBe(200);
    expect(h.fired).toBe(1);
    const { rows } = await pool.query<{ client_id: string }>(
      'SELECT client_id::text FROM customer_payments WHERE company_id = $1 AND bank_reference = $2', [A.id, ref]);
    expect(rows).toEqual([{ client_id: survivor }]);
    expect((await settlement(A, ref, id)).invoicePaid).toBe('115.00');
  });
});

describe('round 3: the fee leg never exceeds the receipt; verify trusting requested_amount', () => {
  it('a fee larger than the receipt is capped at the receipt and flagged', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id, 10000);
    expect((await deliver(ref, 10000, 'ZAR', { fees: 20000 })).statusCode).toBe(200);
    expect(await ledger(A, ref)).toMatchObject({ feeExpense: '100.00', bankNet: '0.00', balanced: true });
    expect((await settlement(A, ref, id)).review).toBe('review:fee_exceeds_receipt');
  });

  it('verify trusts requested_amount within its fee (R103, R100, R3): R100 banked; the webhook with the same figures posts no fee', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id, 10000);
    paystackSays(10300, { requestedAmountCents: 10000, feesCents: 300 });
    expect((await verify(ref)).body.data?.status).toBe('completed');
    expect(await settlement(A, ref, id)).toMatchObject({ payments: [{ total: '100.00', allocated: '100.00' }], review: null });
    expect((await deliver(ref, 10300, 'ZAR', { requested_amount: 10000, fees: 300 })).statusCode).toBe(200);
    expect(await ledger(A, ref)).toMatchObject({ bankNet: '100.00', receivableCredit: '100.00', feeExpense: '0.00', balanced: true });
    expect(await settlement(A, ref, id)).toMatchObject({ payments: [{ total: '100.00', allocated: '100.00' }], review: null });
  });
});

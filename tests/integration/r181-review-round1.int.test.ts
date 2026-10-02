/**
 * R-181 review round 1: what a settlement banks when the customer paid the gateway's fee, a
 * non-ZAR fee, a second report that disagrees with the first, an overpayment, and two settlements
 * racing for one invoice.
 *
 * - Paystack's charge carries `requested_amount`, the amount before a customer-paid fee
 *   (Paystack OpenAPI `VerifyResponse.requested_amount`). When the account passes charges to the
 *   customer, `amount` = requested_amount + fee. The receipt is `requested_amount`, and the fee
 *   leg posts only what the MERCHANT bore, so Bank nets to `amount - fees`, which is what
 *   Paystack settles. Without `requested_amount`, today's rule (bank `amount`) stands.
 * - A non-ZAR charge is still banked (Hein), its receipt says so, and its fee is not posted as rand.
 * - The second of webhook and verify compares its amount with what the first banked.
 * - The invoice row is locked before the allocation is decided.
 *
 * Real Postgres, real routes; only the Paystack client is stubbed, and one SQL read can be held
 * open to widen the race window.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { A, SECRET, checkout, cleanup, deliver, invoice, ledger, pool, seed, settlement, verify } from './r181-settlement.helpers';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { log } from '@/lib/logger';

assertDisposable();

const h = vi.hoisted(() => ({ verifyTransaction: vi.fn(), holdLockedRead: 0, heldReads: 0 }));
vi.mock('@/modules/billing/services/paystackClient', () => ({
  verifyTransaction: (...a: unknown[]) => h.verifyTransaction(...a),
  chargeAuthorization: vi.fn(async () => { throw new Error('Paystack must not be charged in this test'); }),
}));
// Holds the FIRST locked invoice read open for `holdLockedRead` ms after it returns, so a rival
// settlement reaches its own read inside that window (and blocks there, if the row is locked).
vi.mock('@/lib/neon', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/neon')>();
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (h.holdLockedRead > 0 && strings.join(' ').includes('locked_total')) {
      const wait = h.holdLockedRead;
      h.holdLockedRead = 0;
      h.heldReads += 1;
      return original.sql(strings, ...values).then(async (rows: unknown) => {
        await new Promise((r) => setTimeout(r, wait));
        return rows;
      });
    }
    return original.sql(strings, ...values);
  };
  Object.assign(sql, { transaction: original.sql.transaction, unsafe: original.sql.unsafe, query: original.sql.query });
  return { ...original, sql };
});

const paystackSays = (amountCents: number, extra: Record<string, unknown> = {}) => h.verifyTransaction.mockResolvedValue(
  { status: 'success', id: 1811, amountCents, currency: 'ZAR', paidAt: new Date().toISOString(), channel: 'card', ...extra });
const errorLog = vi.spyOn(log, 'error');

beforeAll(async () => {
  vi.stubEnv('PAYSTACK_SECRET_KEY', SECRET);
  await seed(A);
  clearSystemAccountCache();
});
beforeEach(() => { h.verifyTransaction.mockReset(); h.holdLockedRead = 0; h.heldReads = 0; errorLog.mockClear(); });
afterAll(async () => { vi.unstubAllEnvs(); await cleanup([A]); });

describe('1. a fee the customer paid is the gateway\'s, not customer credit', () => {
  it('charges passed to the customer (R118.50 = R115 + R3.50): R115 receipt, no fee expense, Bank nets R115', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id);
    expect((await deliver(ref, 11850, 'ZAR', { requested_amount: 11500, fees: 350 })).statusCode).toBe(200);
    expect(await settlement(A, ref, id)).toEqual({
      payments: [{ total: '115.00', allocated: '115.00', status: 'confirmed' }],
      bankDebit: '115.00', invoicePaid: '115.00', review: null });
    expect(await ledger(A, ref)).toMatchObject({ bankNet: '115.00', receivableCredit: '115.00', feeExpense: '0.00', balanced: true });
  });

  it('the merchant bears the fee: R115 receipt, R3.50 fee expense, Bank nets R111.50', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id);
    expect((await deliver(ref, 11500, 'ZAR', { requested_amount: 11500, fees: 350 })).statusCode).toBe(200);
    expect((await settlement(A, ref, id)).review).toBeNull();
    expect(await ledger(A, ref)).toMatchObject({ bankNet: '111.50', receivableCredit: '115.00', feeExpense: '3.50', balanced: true });
  });

  it('no requested_amount: today\'s rule, amount banked and the whole fee expensed', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id);
    expect((await deliver(ref, 11500, 'ZAR', { fees: 350 })).statusCode).toBe(200);
    expect(await ledger(A, ref)).toMatchObject({ bankNet: '111.50', receivableCredit: '115.00', feeExpense: '3.50', balanced: true });
  });

  it('verify first with charges passed on, then the webhook with the fee: one R115 receipt, no disagreement', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id);
    paystackSays(11850, { requestedAmountCents: 11500 });
    expect((await verify(ref)).body.data?.status).toBe('completed');
    expect((await deliver(ref, 11850, 'ZAR', { requested_amount: 11500, fees: 350 })).statusCode).toBe(200);
    expect(await settlement(A, ref, id)).toMatchObject({ payments: [{ total: '115.00', allocated: '115.00' }], review: null });
    expect(await ledger(A, ref)).toMatchObject({ bankNet: '115.00', feeExpense: '0.00', balanced: true });
  });

  it('requested_amount differs from the request: requested_amount banked, flagged', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id);
    expect((await deliver(ref, 5150, 'ZAR', { requested_amount: 5000, fees: 150 })).statusCode).toBe(200);
    expect(await settlement(A, ref, id)).toMatchObject({ payments: [{ total: '50.00' }], review: 'review:amount_mismatch' });
    expect(await ledger(A, ref)).toMatchObject({ bankNet: '50.00', feeExpense: '0.00' });
  });

  it('amount below requested_amount: the amount is banked (requested_amount is not trusted), flagged', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id);
    expect((await deliver(ref, 11000, 'ZAR', { requested_amount: 11500, fees: 150 })).statusCode).toBe(200);
    expect(await settlement(A, ref, id)).toMatchObject({
      payments: [{ total: '110.00' }], review: 'review:amount_mismatch,amount_below_requested_amount' });
    expect(await ledger(A, ref)).toMatchObject({ bankNet: '108.50', feeExpense: '1.50', balanced: true });
  });
});

describe('2. a non-ZAR charge', () => {
  it('is banked with its currency on the receipt, and its fee is not posted as rand but flagged', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id);
    expect((await deliver(ref, 11500, 'USD', { fees: 350 })).statusCode).toBe(200);
    expect((await settlement(A, ref, id)).review).toBe('review:currency_mismatch,fee_not_posted_currency');
    const l = await ledger(A, ref);
    expect(l).toMatchObject({ bankNet: '115.00', feeExpense: '0.00', balanced: true });
    expect(l.description).toContain('USD 115.00');
  });
});

describe('3. the second report is compared with what the first banked', () => {
  it('webhook R50 while verify is asking Paystack, which says R60: banked once at R50, flagged with both figures', async () => {
    // verify only asks Paystack about a request that is not completed, so the webhook can be first
    // only by landing while verify's gateway call is out (it runs outside any transaction).
    const id = await invoice(A);
    const ref = await checkout(A, id);
    h.verifyTransaction.mockImplementation(async () => {
      expect((await deliver(ref, 5000)).statusCode).toBe(200);
      return { status: 'success', id: 1812, amountCents: 6000, currency: 'ZAR', paidAt: new Date().toISOString(), channel: 'card' };
    });
    expect((await verify(ref)).body.data?.status).toBe('completed');
    const s = await settlement(A, ref, id);
    expect(s.payments).toEqual([{ total: '50.00', allocated: '50.00', status: 'confirmed' }]);
    expect(s.review).toBe('review:amount_mismatch,amount_disagrees_with_first_report');
    expect(errorLog).toHaveBeenCalledWith(expect.any(String),
      expect.objectContaining({ reference: ref, bankedRand: 50, reportedRand: 60 }), expect.any(String));
  });

  it('verify R50, then webhook R60: banked once at R50, flagged', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id);
    paystackSays(5000);
    expect((await verify(ref)).body.data?.status).toBe('completed');
    expect((await deliver(ref, 6000)).statusCode).toBe(200);
    const s = await settlement(A, ref, id);
    expect(s.payments).toEqual([{ total: '50.00', allocated: '50.00', status: 'confirmed' }]);
    expect(s.review).toBe('review:amount_mismatch,amount_disagrees_with_first_report');
  });
});

describe('4. an overpayment that matches the request', () => {
  it('an invoice already paid by EFT: banked unapplied, flagged overpaid_unapplied', async () => {
    const id = await invoice(A);
    await pool.query("UPDATE customer_invoices SET amount_paid = 115, status = 'paid' WHERE id = $1", [id]);
    const ref = await checkout(A, id);
    expect((await deliver(ref, 11500)).statusCode).toBe(200);
    expect(await settlement(A, ref, id)).toEqual({
      payments: [{ total: '115.00', allocated: '0.00', status: 'confirmed' }],
      bankDebit: '115.00', invoicePaid: '115.00', review: 'review:overpaid_unapplied' });
  });
});

describe('5. two settlements racing for one invoice', () => {
  it('the second allocates only what is left', async () => {
    const id = await invoice(A);
    const [r1, r2] = [await checkout(A, id), await checkout(A, id)];
    h.holdLockedRead = 1500;
    const results = await Promise.all([deliver(r1, 11500), (async () => {
      await new Promise((r) => setTimeout(r, 300));
      return deliver(r2, 11500);
    })()]);
    expect(h.heldReads).toBe(1);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    const allocated = [...(await settlement(A, r1, id)).payments, ...(await settlement(A, r2, id)).payments]
      .map((p) => p.allocated).sort();
    expect(allocated).toEqual(['0.00', '115.00']);
    expect((await settlement(A, r1, id)).invoicePaid).toBe('115.00');
  });

  it('a lock timeout loses nothing: the webhook fails for redelivery, verify leaves it pending', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id);
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM customer_invoices WHERE id = $1 FOR UPDATE', [id]);
      expect((await deliver(ref, 11500)).statusCode).toBe(500);
      paystackSays(11500);
      expect((await verify(ref)).body.data?.status).toBe('pending');
      expect((await settlement(A, ref, id)).payments).toEqual([]);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect((await deliver(ref, 11500)).statusCode).toBe(200);
    expect(await settlement(A, ref, id)).toMatchObject({ payments: [{ total: '115.00', allocated: '115.00' }], invoicePaid: '115.00' });
  }, 30_000);
});

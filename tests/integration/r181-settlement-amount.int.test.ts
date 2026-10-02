/**
 * R-181: a Paystack settlement banks what Paystack reports it received, and never settles an
 * invoice that is not in the ledger.
 *
 * - The webhook and the return page's verify route banked the request's stored `amount_cents`
 *   and ignored the amount Paystack reported. Now the reported amount is banked; a difference
 *   from the request, or a currency other than ZAR, is logged at error level and the request is
 *   flagged for review (`failure_reason = 'review:…'`) (Hein, 2026-10-02).
 * - A checkout already open on a draft, pending-approval, cancelled or soft-deleted invoice could
 *   still be paid, and the receipt was allocated to an invoice outside the ledger. The money is
 *   still banked (it was received), but as an unapplied receipt on the customer, flagged.
 * - Idempotent on the reference: webhook and verify bank once, the same amount in either order.
 *
 * Real Postgres, real routes; only the Paystack client is stubbed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { A, B, SECRET, checkout, cleanup, deliver, invoice, pool, seed, settlement, verify } from './r181-settlement.helpers';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { log } from '@/lib/logger';

assertDisposable();

const h = vi.hoisted(() => ({ verifyTransaction: vi.fn() }));
vi.mock('@/modules/billing/services/paystackClient', () => ({
  verifyTransaction: (...a: unknown[]) => h.verifyTransaction(...a),
  chargeAuthorization: vi.fn(async () => { throw new Error('Paystack must not be charged in this test'); }),
}));

const paystackSays = (amountCents: number, currency = 'ZAR') => h.verifyTransaction.mockResolvedValue(
  { status: 'success', id: 1810, amountCents, currency, paidAt: new Date().toISOString(), channel: 'card' });
const errorLog = vi.spyOn(log, 'error');

beforeAll(async () => {
  vi.stubEnv('PAYSTACK_SECRET_KEY', SECRET);
  await seed(A);
  await seed(B);
  clearSystemAccountCache();
});
beforeEach(() => { h.verifyTransaction.mockReset(); errorLog.mockClear(); });
afterAll(async () => { vi.unstubAllEnvs(); await cleanup([A, B]); });

describe('R-181: the reported amount is what is banked', () => {
  it('reported = requested: settles the invoice as before, no flag, no error', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id);
    expect((await deliver(ref, 11500)).statusCode).toBe(200);
    expect(await settlement(A, ref, id)).toEqual({
      payments: [{ total: '115.00', allocated: '115.00', status: 'confirmed' }],
      bankDebit: '115.00', invoicePaid: '115.00', review: null });
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('reported < requested: banks the reported R50, allocates it, flags and logs', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id);
    expect((await deliver(ref, 5000)).statusCode).toBe(200);
    expect(await settlement(A, ref, id)).toEqual({
      payments: [{ total: '50.00', allocated: '50.00', status: 'confirmed' }],
      bankDebit: '50.00', invoicePaid: '50.00', review: 'review:amount_mismatch' });
    expect(errorLog).toHaveBeenCalledWith(expect.any(String),
      expect.objectContaining({ companyId: A.id, reference: ref, expectedCents: 11500, reportedCents: 5000 }), expect.any(String));
  });

  it('reported > requested: banks the reported R200, allocates the R115 owed, the rest unapplied, flagged', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id);
    expect((await deliver(ref, 20000)).statusCode).toBe(200);
    expect(await settlement(A, ref, id)).toEqual({
      payments: [{ total: '200.00', allocated: '115.00', status: 'confirmed' }],
      bankDebit: '200.00', invoicePaid: '115.00', review: 'review:amount_mismatch' });
  });

  it('a currency other than ZAR banks the reported amount, flagged and logged', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id);
    expect((await deliver(ref, 11500, 'USD')).statusCode).toBe(200);
    expect(await settlement(A, ref, id)).toMatchObject({
      payments: [{ total: '115.00' }], bankDebit: '115.00', review: 'review:currency_mismatch' });
    expect(errorLog).toHaveBeenCalledWith(expect.any(String),
      expect.objectContaining({ companyId: A.id, reference: ref, reportedCurrency: 'USD' }), expect.any(String));
  });

  it('verify banks the amount Paystack verified, not the request amount', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id);
    paystackSays(5000);
    expect((await verify(ref)).body.data?.status).toBe('completed');
    expect(await settlement(A, ref, id)).toEqual({
      payments: [{ total: '50.00', allocated: '50.00', status: 'confirmed' }],
      bankDebit: '50.00', invoicePaid: '50.00', review: 'review:amount_mismatch' });
  });
});

describe('R-181: an invoice outside the ledger is never settled', () => {
  for (const [status, deleted, reason] of [
    ['draft', false, 'invoice_draft'], ['pending_approval', false, 'invoice_pending_approval'],
    ['cancelled', false, 'invoice_cancelled'], ['sent', true, 'invoice_deleted'],
  ] as const) {
    it(`${deleted ? 'a soft-deleted' : `a ${status}`} invoice: the money is banked unapplied, the invoice untouched, flagged`, async () => {
      const id = await invoice(A, status, deleted);
      const ref = await checkout(A, id);
      expect((await deliver(ref, 11500)).statusCode).toBe(200);
      expect(await settlement(A, ref, id)).toEqual({
        payments: [{ total: '115.00', allocated: '0.00', status: 'confirmed' }],
        bankDebit: '115.00', invoicePaid: '0.00', review: `review:${reason}` });
      expect(errorLog).toHaveBeenCalledWith(expect.any(String),
        expect.objectContaining({ companyId: A.id, reference: ref }), expect.any(String));
    });
  }

  it('verify on a draft invoice also banks unapplied and flags', async () => {
    const id = await invoice(A, 'draft');
    const ref = await checkout(A, id);
    paystackSays(11500);
    expect((await verify(ref)).body.data?.status).toBe('completed');
    expect(await settlement(A, ref, id)).toEqual({
      payments: [{ total: '115.00', allocated: '0.00', status: 'confirmed' }],
      bankDebit: '115.00', invoicePaid: '0.00', review: 'review:invoice_draft' });
  });
});

describe('R-181: webhook and verify bank once, the same amount in either order', () => {
  it('webhook first, then verify', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id);
    expect((await deliver(ref, 5000)).statusCode).toBe(200);
    paystackSays(5000);
    await verify(ref);
    expect((await settlement(A, ref, id)).payments).toEqual([{ total: '50.00', allocated: '50.00', status: 'confirmed' }]);
  });

  it('verify first, then webhook', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id);
    paystackSays(5000);
    expect((await verify(ref)).body.data?.status).toBe('completed');
    expect((await deliver(ref, 5000)).statusCode).toBe(200);
    expect(await settlement(A, ref, id)).toEqual({
      payments: [{ total: '50.00', allocated: '50.00', status: 'confirmed' }],
      bankDebit: '50.00', invoicePaid: '50.00', review: 'review:amount_mismatch' });
  });
});

describe('R-181: tenant isolation', () => {
  it('a flagged settlement in one company writes nothing in another', async () => {
    const mine = await invoice(A, 'draft');
    const theirs = await invoice(B);
    const theirRef = await checkout(B, theirs);
    const ref = await checkout(A, mine);
    expect((await deliver(ref, 5000)).statusCode).toBe(200);
    expect((await settlement(A, ref, mine)).review).toBe('review:amount_mismatch,invoice_draft');
    expect(await settlement(B, theirRef, theirs)).toEqual({ payments: [], bankDebit: '0.00', invoicePaid: '0.00', review: null });
    expect((await pool.query('SELECT count(*)::int AS n FROM customer_payments WHERE company_id = $1', [B.id])).rows[0].n).toBe(0);
  });

  it("a request naming another company's invoice settles nothing", async () => {
    const theirs = await invoice(B);
    const ref = await checkout(A, theirs);
    expect((await deliver(ref, 11500)).statusCode).toBe(500);
    expect(await settlement(B, ref, theirs)).toEqual({ payments: [], bankDebit: '0.00', invoicePaid: '0.00', review: null });
    expect((await settlement(A, ref, theirs)).payments).toEqual([]);
  });
});

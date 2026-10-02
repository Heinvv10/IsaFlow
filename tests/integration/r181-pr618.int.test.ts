/**
 * R-181, PR #618 blind review: the fee verify already knows, a NaN invoice balance, a charged payer
 * told "failed", and two Paystack `amount`s for one transaction.
 *
 * - LOW-1: verify posts the fee leg from its own `fees`; the webhook does not post it again.
 * - LOW-2: an invoice whose balance is NaN takes nothing and is flagged `invoice_balance_invalid`.
 * - LOW-4: a request stored `failed` that Paystack says succeeded, whose settlement then throws,
 *   answers `pending`, never `failed`.
 * - LOW-5: a second report whose `amount` differs from the first report's is flagged even when the
 *   figure each would bank is the same.
 *
 * Real Postgres (isaflow-fixture-r181), real routes; only the Paystack client is stubbed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { A, SECRET, checkout, cleanup, deliver, invoice, ledger, pool, seed, settlement, verify } from './r181-settlement.helpers';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';

assertDisposable();

const h = vi.hoisted(() => ({ verifyTransaction: vi.fn() }));
vi.mock('@/modules/billing/services/paystackClient', () => ({
  verifyTransaction: (...a: unknown[]) => h.verifyTransaction(...a),
  chargeAuthorization: vi.fn(async () => { throw new Error('Paystack must not be charged in this test'); }),
}));

const live = (amountCents: number, extra: Record<string, unknown> = {}) =>
  ({ status: 'success', id: 1814, amountCents, currency: 'ZAR', paidAt: new Date().toISOString(), channel: 'card', ...extra });
const paystackSays = (amountCents: number, extra: Record<string, unknown> = {}) =>
  h.verifyTransaction.mockResolvedValue(live(amountCents, extra));

beforeAll(async () => {
  vi.stubEnv('PAYSTACK_SECRET_KEY', SECRET);
  await seed(A);
  clearSystemAccountCache();
});
beforeEach(() => { h.verifyTransaction.mockReset(); });
afterAll(async () => { vi.unstubAllEnvs(); await cleanup([A]); });

describe('LOW-1: verify posts the fee it knows, once', () => {
  it('verify alone (the webhook never lands) books the R3.50 fee: Bank nets R111.50', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id);
    paystackSays(11500, { feesCents: 350 });
    expect((await verify(ref)).body.data?.status).toBe('completed');
    expect(await ledger(A, ref)).toMatchObject({ bankNet: '111.50', feeExpense: '3.50', balanced: true });
  });

  it('verify then the webhook with the same fee: the fee is posted once', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id);
    paystackSays(11500, { feesCents: 350 });
    expect((await verify(ref)).body.data?.status).toBe('completed');
    expect((await deliver(ref, 11500, 'ZAR', { fees: 350 })).statusCode).toBe(200);
    expect(await ledger(A, ref)).toMatchObject({ bankNet: '111.50', feeExpense: '3.50', balanced: true });
    const { rows } = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id = $1 AND reference = $2", [A.id, ref]);
    expect(rows[0]!.n).toBe(1);
  });
});

describe('LOW-2: a NaN invoice balance', () => {
  it('takes nothing, is flagged invoice_balance_invalid, and the receipt is banked unapplied', async () => {
    const id = await invoice(A);
    // A NaN written before the NaN-refusing trigger existed: simulate that legacy row with
    // triggers off for this one statement (the fixture's superuser; no DDL).
    const legacy = await pool.connect();
    try {
      await legacy.query('BEGIN');
      await legacy.query("SET LOCAL session_replication_role = 'replica'");
      await legacy.query("UPDATE customer_invoices SET total_amount = 'NaN' WHERE id = $1", [id]);
      await legacy.query('COMMIT');
    } finally {
      legacy.release();
    }
    const ref = await checkout(A, id);
    expect((await deliver(ref, 11500)).statusCode).toBe(200);
    expect(await settlement(A, ref, id)).toMatchObject({
      payments: [{ total: '115.00', allocated: '0.00', status: 'confirmed' }], review: 'review:invoice_balance_invalid' });
    expect(await ledger(A, ref)).toMatchObject({ bankNet: '115.00', receivableCredit: '115.00', balanced: true });
  });
});

describe('LOW-4: a charged payer is never told "failed"', () => {
  it('a failed request Paystack says succeeded, whose settlement times out on the invoice lock, answers pending', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id);
    await pool.query("UPDATE paystack_payment_requests SET status = 'failed', failure_reason = 'abandoned while starting' WHERE paystack_reference = $1", [ref]);
    paystackSays(11500);
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM customer_invoices WHERE id = $1 FOR UPDATE', [id]);
      expect((await verify(ref)).body.data?.status).toBe('pending');
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect((await settlement(A, ref, id)).payments).toEqual([]);
  }, 30_000);
});

describe('LOW-5: two different Paystack amounts for one transaction are flagged', () => {
  it('webhook R103 (requested_amount R100, fees R3) while verify is asking, which then reports amount R100', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id, 10000);
    h.verifyTransaction.mockImplementation(async () => {
      expect((await deliver(ref, 10300, 'ZAR', { requested_amount: 10000, fees: 300 })).statusCode).toBe(200);
      return live(10000);
    });
    expect((await verify(ref)).body.data?.status).toBe('completed');
    expect(await settlement(A, ref, id)).toMatchObject({
      payments: [{ total: '100.00' }], review: 'review:amount_disagrees_with_first_report' });
    expect(await ledger(A, ref)).toMatchObject({ bankNet: '100.00', feeExpense: '0.00', balanced: true });
  });
});

/**
 * R-187: a cancelled gateway receipt is never re-banked by a later charge.success.
 *
 * A person cancels a Paystack receipt; a charge.success for that reference then arrives in a
 * different body (a byte-identical redelivery is acked as a duplicate), through the webhook's
 * already-completed branch or the verify route. Before the fix the dedupe ignored cancelled
 * receipts and banked a second one: AR credited and Bank debited twice. Now any receipt for the
 * reference dedupes; a cancelled-only match banks nothing, posts no fee and flags the request
 * `already_settled_cancelled_receipt` (Hein, 2026-10-03). A live match behaves as before.
 *
 * Real Postgres (isaflow-fixture-r187), real routes and the real cancel service; only the Paystack
 * client is stubbed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { A, SECRET, checkout, cleanup, deliver, invoice, ledger, pool, seed, settlement, verify } from './r181-settlement.helpers';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { cancelCustomerPayment } from '@/modules/accounting/services/ar/customerPaymentAllocationService';

assertDisposable();

const h = vi.hoisted(() => ({ verifyTransaction: vi.fn() }));
vi.mock('@/modules/billing/services/paystackClient', () => ({
  verifyTransaction: (...a: unknown[]) => h.verifyTransaction(...a),
  chargeAuthorization: vi.fn(async () => { throw new Error('Paystack must not be charged in this test'); }),
}));

const FLAG = 'review:already_settled_cancelled_receipt';
const live = (amountCents: number, extra: Record<string, unknown> = {}) =>
  ({ status: 'success', id: 1870, amountCents, currency: 'ZAR', paidAt: new Date().toISOString(), channel: 'card', ...extra });
/** A body that differs from the first delivery's, so the webhook does not ack it as a duplicate. */
const replayBody = () => ({ id: Math.floor(Math.random() * 1e9), fees: 350, paid_at: new Date().toISOString() });

/** Cancel the reference's confirmed receipt through the service the receipts page uses, in one transaction. */
async function cancelReceipt(ref: string): Promise<void> {
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM customer_payments WHERE company_id = $1 AND bank_reference = $2 AND status = 'confirmed'", [A.id, ref]);
  expect(rows).toHaveLength(1);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await als.run({ client: c, userId: A.user, companyId: A.id, claims: {} } as never,
      () => cancelCustomerPayment(A.id, rows[0]!.id, A.user, 'r187 test'));
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

/** Company A's books as a whole: net Bank, net AR, the expense, and how many receipts and journals exist. */
async function books(): Promise<Record<string, string | number>> {
  const { rows } = await pool.query<{ bank: string; ar: string; expense: string; journals: number; receipts: number }>(
    `SELECT COALESCE(SUM(l.debit - l.credit) FILTER (WHERE g.account_subtype = 'bank'), 0)::text AS bank,
            COALESCE(SUM(l.debit - l.credit) FILTER (WHERE g.account_subtype = 'receivable'), 0)::text AS ar,
            COALESCE(SUM(l.debit - l.credit) FILTER (WHERE g.account_subtype = 'admin_expense'), 0)::text AS expense,
            (SELECT count(*)::int FROM gl_journal_entries WHERE company_id = $1) AS journals,
            (SELECT count(*)::int FROM customer_payments WHERE company_id = $1) AS receipts
     FROM gl_journal_lines l JOIN gl_accounts g ON g.id = l.gl_account_id WHERE g.company_id = $1`, [A.id]);
  return rows[0]!;
}

const feeJournals = async (ref: string): Promise<number> => (await pool.query<{ n: number }>(
  'SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id = $1 AND reference = $2', [A.id, ref])).rows[0]!.n;

beforeAll(async () => {
  vi.stubEnv('PAYSTACK_SECRET_KEY', SECRET);
  await seed(A);
  clearSystemAccountCache();
});
beforeEach(() => { h.verifyTransaction.mockReset(); });
afterAll(async () => { vi.unstubAllEnvs(); await cleanup([A]); });

describe('R-187: a cancelled receipt blocks re-banking', () => {
  it('webhook replay in a different body after the receipt was cancelled: nothing banked, no fee, flagged', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id);
    expect((await deliver(ref, 11500)).statusCode).toBe(200);
    await cancelReceipt(ref);
    const before = await books();

    expect((await deliver(ref, 11500, 'ZAR', replayBody())).statusCode).toBe(200);

    expect(await books()).toEqual(before);
    expect(await settlement(A, ref, id)).toMatchObject({
      payments: [{ total: '115.00', status: 'cancelled' }], invoicePaid: '0.00', review: FLAG });
    expect(await feeJournals(ref)).toBe(0);
  });

  it('verify, while the webhook settles and a person cancels: nothing banked, no fee, flagged, payer told completed', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id);
    let before: Record<string, string | number> | null = null;
    h.verifyTransaction.mockImplementation(async () => {
      if ((await deliver(ref, 11500)).statusCode !== 200) throw new Error('first settlement failed');
      await cancelReceipt(ref);
      before = await books();
      return live(11500, { feesCents: 350 });
    });

    expect((await verify(ref)).body.data).toMatchObject({ status: 'completed', amountCents: 11500, appliedToInvoice: false });

    expect(before).not.toBeNull();
    expect(await books()).toEqual(before);
    expect(await settlement(A, ref, id)).toMatchObject({
      payments: [{ total: '115.00', status: 'cancelled' }], invoicePaid: '0.00', review: FLAG });
    expect(await feeJournals(ref)).toBe(0);
  });

  it('a live receipt: a replay in a different body dedupes as before (no new receipt, the missing fee posted, no flag)', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id);
    expect((await deliver(ref, 11500)).statusCode).toBe(200);

    expect((await deliver(ref, 11500, 'ZAR', replayBody())).statusCode).toBe(200);

    expect(await settlement(A, ref, id)).toMatchObject({
      payments: [{ total: '115.00', status: 'confirmed' }], invoicePaid: '115.00', review: null });
    expect(await ledger(A, ref)).toMatchObject({ bankNet: '111.50', receivableCredit: '115.00', feeExpense: '3.50', balanced: true });
    expect(await feeJournals(ref)).toBe(1);
  });

  it('a cancelled AND a live receipt (re-banked before R-187): the live one is the match, not the cancelled', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id);
    expect((await deliver(ref, 11500)).statusCode).toBe(200);
    await cancelReceipt(ref);
    // What the pre-R-187 dedupe left behind: a second, live receipt for the same reference.
    await pool.query(
      `INSERT INTO customer_payments (id, company_id, client_id, payment_date, total_amount, payment_method,
         bank_reference, bank_account_id, description, created_by, status)
       SELECT $3, company_id, client_id, payment_date, total_amount, payment_method, bank_reference, bank_account_id,
              'Paystack card payment ' || bank_reference, created_by, 'confirmed'
       FROM customer_payments WHERE company_id = $1 AND bank_reference = $2`, [A.id, ref, randomUUID()]);

    expect((await deliver(ref, 11500, 'ZAR', replayBody())).statusCode).toBe(200);

    const after = await settlement(A, ref, id);
    expect(after.payments.map((p) => p.status).sort()).toEqual(['cancelled', 'confirmed']);
    expect(after.review).toBeNull();
    expect(await feeJournals(ref)).toBe(1);
  });
});

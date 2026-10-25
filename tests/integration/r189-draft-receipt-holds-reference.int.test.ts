/**
 * R-189: a LIVE DRAFT receipt carrying the Paystack reference is not the settlement.
 *
 * A person can record a receipt by hand with the Paystack reference as its `bank_reference` and
 * leave it in draft. The gateway's dedupe used to take any live receipt for the reference as the
 * settlement, a draft included: the charge.success banked nothing, posted the fee leg against the
 * draft's bank account (Bank credited before any receipt debited it) and flagged nothing. Hein,
 * 2026-10-05: on a report that finds only a draft, bank nothing, post NO fee, flag the request
 * `draft_receipt_holds_reference` for a person, and leave the draft as it is.
 *
 * Real Postgres (isaflow-fixture-r19x), the real webhook and verify routes, the real manual-receipt
 * service; only the Paystack client is stubbed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { A, SECRET, checkout, cleanup, deliver, invoice, pool, seed, settlement, verify, verifyAs } from './r181-settlement.helpers';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { createCustomerPayment } from '@/modules/accounting/services/ar/customerPaymentService';
import { cancelCustomerPayment, confirmCustomerPayment } from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import { books, feeJournals } from './r187-books.helpers';

assertDisposable();

const h = vi.hoisted(() => ({ verifyTransaction: vi.fn() }));
vi.mock('@/modules/billing/services/paystackClient', () => ({
  verifyTransaction: (...a: unknown[]) => h.verifyTransaction(...a),
  chargeAuthorization: vi.fn(async () => { throw new Error('Paystack must not be charged in this test'); }),
}));

const FLAG = 'review:draft_receipt_holds_reference';
let bankId = '';
const today = () => new Date().toISOString().slice(0, 10);

/** One committed transaction with the request context every service expects. */
async function inTx<T>(fn: () => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await als.run({ client: c, userId: A.user, companyId: A.id, claims: {} } as never, fn);
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

/** A receipt a person recorded by hand with the Paystack reference, left in draft. */
async function draftReceipt(ref: string, invoiceId: string, method: 'card' | 'eft'): Promise<string> {
  const p = await inTx(() => createCustomerPayment(A.id, {
    clientId: A.customer, paymentDate: today(), totalAmount: 115, paymentMethod: method, bankReference: ref,
    bankAccountId: bankId, allocations: [{ invoiceId, amount: 115 }],
  }, A.user));
  return p.id;
}

/** The draft as it was written: still a draft, still allocated, still without a journal. */
async function draftState(id: string) {
  const { rows } = await pool.query<{ status: string; journal: string | null; allocated: string }>(
    `SELECT cp.status, cp.gl_journal_entry_id::text AS journal,
            COALESCE(SUM(a.amount_allocated), 0)::numeric(15,2)::text AS allocated
     FROM customer_payments cp LEFT JOIN customer_payment_allocations a ON a.payment_id = cp.id
     WHERE cp.id = $1 GROUP BY cp.id`, [id]);
  return rows[0];
}

const success = (amountCents: number) =>
  ({ status: 'success', id: 1891, amountCents, currency: 'ZAR', paidAt: new Date().toISOString(), channel: 'card', feesCents: 350 });

beforeAll(async () => {
  vi.stubEnv('PAYSTACK_SECRET_KEY', SECRET);
  await seed(A);
  bankId = (await pool.query<{ id: string }>(
    "SELECT id FROM gl_accounts WHERE company_id = $1 AND account_subtype = 'bank'", [A.id])).rows[0]!.id;
  clearSystemAccountCache();
});
beforeEach(() => { h.verifyTransaction.mockReset(); });
afterAll(async () => {
  vi.unstubAllEnvs();
  await cleanup([A]);
});

describe('R-189: a draft receipt holding the reference is flagged, never taken as the settlement', () => {
  it('webhook (guarded UPDATE matched) with fees, behind a draft EFT receipt: no receipt, no fee, Bank unchanged, flagged', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id);
    const draft = await draftReceipt(ref, id, 'eft');
    const before = await books();

    expect((await deliver(ref, 11500, 'ZAR', { fees: 350 })).statusCode).toBe(200);

    expect(await books()).toEqual(before);
    expect(await feeJournals(ref)).toBe(0);
    expect(await settlement(A, ref, id)).toMatchObject({
      payments: [{ status: 'draft' }], invoicePaid: '0.00', review: FLAG });
    expect(await draftState(draft)).toEqual({ status: 'draft', journal: null, allocated: '115.00' });
  });

  it('a draft CARD receipt (the card-reference index admits one live row) is flagged the same way', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id);
    const draft = await draftReceipt(ref, id, 'card');
    const before = await books();

    expect((await deliver(ref, 11500, 'ZAR', { fees: 350 })).statusCode).toBe(200);

    expect(await books()).toEqual(before);
    expect(await feeJournals(ref)).toBe(0);
    expect((await settlement(A, ref, id)).review).toBe(FLAG);
    expect(await draftState(draft)).toEqual({ status: 'draft', journal: null, allocated: '115.00' });
  });

  it('verify (moves the request) with fees, behind a draft: completed, NOT applied, the request amount; no fee; flagged', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id);
    await draftReceipt(ref, id, 'eft');
    h.verifyTransaction.mockImplementation(verifyAs(success(11500)));
    const before = await books();

    expect((await verify(ref)).body.data).toMatchObject({ status: 'completed', amountCents: 11500, appliedToInvoice: false });

    expect(await books()).toEqual(before);
    expect(await feeJournals(ref)).toBe(0);
    expect(await settlement(A, ref, id)).toMatchObject({ payments: [{ status: 'draft' }], invoicePaid: '0.00', review: FLAG });
  });

  it('a later charge.success in another body (already-completed branch) still banks nothing and posts no fee', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id);
    await draftReceipt(ref, id, 'eft');
    expect((await deliver(ref, 11500)).statusCode).toBe(200);
    const before = await books();

    expect((await deliver(ref, 11500, 'ZAR', { id: Math.floor(Math.random() * 1e9), fees: 350 })).statusCode).toBe(200);

    expect(await books()).toEqual(before);
    expect(await feeJournals(ref)).toBe(0);
    expect(await settlement(A, ref, id)).toMatchObject({ payments: [{ status: 'draft' }], invoicePaid: '0.00', review: FLAG });
  });

  it('a draft AND a confirmed receipt for the reference: the confirmed one is the settlement, whatever the id order', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id);
    // The draft sorts first by id, so an id-only order would pick it.
    await pool.query(
      `INSERT INTO customer_payments (id, company_id, client_id, payment_date, total_amount, payment_method,
         bank_reference, bank_account_id, created_by, status)
       VALUES ($1, $2, $3, CURRENT_DATE, 115, 'eft', $4, $5, $6, 'draft')`,
      [`00000000-0000-4000-8000-${randomUUID().slice(-12)}`, A.id, A.customer, ref, bankId, A.user]);
    const manual = await inTx(() => createCustomerPayment(A.id, {
      clientId: A.customer, paymentDate: today(), totalAmount: 115, paymentMethod: 'eft', bankReference: ref,
      bankAccountId: bankId, allocations: [{ invoiceId: id, amount: 115 }],
    }, A.user));
    await inTx(() => confirmCustomerPayment(A.id, manual.id, A.user));

    expect((await deliver(ref, 11500, 'ZAR', { fees: 350 })).statusCode).toBe(200);

    // The second-report path, as before R-189: no new receipt, the missing fee posts, nothing flagged.
    expect(await feeJournals(ref)).toBe(1);
    const s = await settlement(A, ref, id);
    expect(s.payments.map((p) => p.status).sort()).toEqual(['confirmed', 'draft']);
    expect(s.review).toBeNull();
  });

  it('a draft beside a CANCELLED gateway receipt: both reasons, the cancelled receipt named, no fee (review L1)', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id);
    expect((await deliver(ref, 11500)).statusCode).toBe(200);
    const gateway = (await pool.query<{ id: string }>(
      "SELECT id FROM customer_payments WHERE company_id = $1 AND bank_reference = $2 AND status = 'confirmed'", [A.id, ref])).rows[0]!.id;
    await inTx(() => cancelCustomerPayment(A.id, gateway, A.user, 'r189 side effect'));
    const draft = await draftReceipt(ref, id, 'eft');
    const before = await books();

    expect((await deliver(ref, 11500, 'ZAR', { id: Math.floor(Math.random() * 1e9), fees: 350 })).statusCode).toBe(200);

    expect(await books()).toEqual(before);
    expect(await feeJournals(ref)).toBe(0);
    expect((await settlement(A, ref, id)).review)
      .toBe('review:draft_receipt_holds_reference,already_settled_cancelled_receipt');
    expect(await draftState(draft)).toEqual({ status: 'draft', journal: null, allocated: '115.00' });
  });
});

describe('R-189 review M1: a RECONCILED receipt is a settlement (a person applied an unapplied gateway receipt)', () => {
  /** A gateway receipt banked with no fee, then marked reconciled as receiptApplicationService leaves it. */
  async function reconciledReceipt(): Promise<{ id: string; ref: string }> {
    const id = await invoice(A);
    const ref = await checkout(A, id);
    expect((await deliver(ref, 11500)).statusCode).toBe(200);
    await pool.query(
      "UPDATE customer_payments SET status = 'reconciled' WHERE company_id = $1 AND bank_reference = $2", [A.id, ref]);
    return { id, ref };
  }

  it('a later charge.success with fees takes the second-report path: the fee posts, nothing flagged', async () => {
    const { id, ref } = await reconciledReceipt();

    expect((await deliver(ref, 11500, 'ZAR', { id: Math.floor(Math.random() * 1e9), fees: 350 })).statusCode).toBe(200);

    expect(await feeJournals(ref)).toBe(1);
    expect(await settlement(A, ref, id)).toMatchObject({ payments: [{ status: 'reconciled' }], review: null });
  });

  it('verify reports the reconciled receipt as banked and applied', async () => {
    const { ref } = await reconciledReceipt();

    expect((await verify(ref)).body.data).toMatchObject({ status: 'completed', amountCents: 11500, appliedToInvoice: true });
  });
});

describe('R-189: control', () => {
  it('control: with no draft the same delivery banks the receipt and posts the fee, unflagged', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id);

    expect((await deliver(ref, 11500, 'ZAR', { fees: 350 })).statusCode).toBe(200);

    expect(await feeJournals(ref)).toBe(1);
    expect(await settlement(A, ref, id)).toMatchObject({
      payments: [{ status: 'confirmed', total: '115.00', allocated: '115.00' }], invoicePaid: '115.00', review: null });
  });
});

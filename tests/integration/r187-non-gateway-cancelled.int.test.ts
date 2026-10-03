/**
 * R-187 review round 1 (M1/M2): only a cancelled receipt the GATEWAY wrote blocks a settlement.
 *
 * A receipt a person recorded by hand (card or EFT) or a bank-feed allocation can carry the Paystack
 * reference as its `bank_reference`. Cancelled, it says nothing about the gateway's settlement: the
 * FIRST charge.success (the webhook's guarded UPDATE, or verify moving the request) must bank the
 * receipt as usual. Round 0 let any cancelled row block it, and the request stayed completed with no
 * receipt for ever (verify skips completed requests).
 *
 * Real Postgres (isaflow-fixture-r187), real routes, the real manual-receipt, bank-allocation and
 * cancel services; only the Paystack client is stubbed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { A, SECRET, checkout, cleanup, deliver, invoice, pool, seed, settlement, verify } from './r181-settlement.helpers';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { createCustomerPayment } from '@/modules/accounting/services/ar/customerPaymentService';
import { cancelCustomerPayment, confirmCustomerPayment } from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';

assertDisposable();

const h = vi.hoisted(() => ({ verifyTransaction: vi.fn() }));
vi.mock('@/modules/billing/services/paystackClient', () => ({
  verifyTransaction: (...a: unknown[]) => h.verifyTransaction(...a),
  chargeAuthorization: vi.fn(async () => { throw new Error('Paystack must not be charged in this test'); }),
}));

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

/** A receipt a person recorded by hand for the Paystack payment, confirmed, then cancelled. */
async function cancelledManualReceipt(ref: string, invoiceId: string, method: 'card' | 'eft'): Promise<void> {
  const p = await inTx(() => createCustomerPayment(A.id, {
    clientId: A.customer, paymentDate: today(), totalAmount: 115, paymentMethod: method, bankReference: ref,
    bankAccountId: bankId, allocations: [{ invoiceId, amount: 115 }],
  }, A.user));
  await inTx(() => confirmCustomerPayment(A.id, p.id, A.user));
  await inTx(() => cancelCustomerPayment(A.id, p.id, A.user, 'r187 manual'));
}

/** A statement line carrying the Paystack reference, allocated to the customer's invoice, then cancelled. */
async function cancelledBankFeedReceipt(ref: string, invoiceId: string): Promise<void> {
  const bt = (await pool.query<{ id: string }>(
    `INSERT INTO bank_transactions (id, company_id, bank_account_id, transaction_date, amount, description, reference, status)
     VALUES ($1, $2, $3, CURRENT_DATE, 115, $4, $5, 'imported') RETURNING id`,
    [randomUUID(), A.id, bankId, `PAYSTACK ${ref}`, ref])).rows[0]!.id;
  const a = await inTx(() => allocateTransaction(A.id, bt, null, A.user, undefined, 'customer', A.customer,
    undefined, undefined, undefined, undefined, invoiceId));
  const { rows } = await pool.query<{ id: string; bank_reference: string }>(
    'SELECT id, bank_reference FROM customer_payments WHERE company_id = $1 AND gl_journal_entry_id = $2', [A.id, a.journalEntryId]);
  expect(rows[0]!.bank_reference).toBe(ref);
  await inTx(() => cancelCustomerPayment(A.id, rows[0]!.id, A.user, 'r187 bank feed'));
}

/** The receipts for the reference, by status, and what the invoice was paid. */
async function outcome(ref: string, invoiceId: string) {
  const s = await settlement(A, ref, invoiceId);
  return { statuses: s.payments.map((p) => p.status).sort(), live: s.payments.filter((p) => p.status === 'confirmed'),
    invoicePaid: s.invoicePaid, review: s.review };
}

beforeAll(async () => {
  vi.stubEnv('PAYSTACK_SECRET_KEY', SECRET);
  await seed(A);
  bankId = (await pool.query<{ id: string }>(
    "SELECT id FROM gl_accounts WHERE company_id = $1 AND account_subtype = 'bank'", [A.id])).rows[0]!.id;
  // A bank allocation posts into an open period; the gateway's own journals do not need one.
  await pool.query(
    `INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
     VALUES ($1, $2, 1, 2026, '2026-01-01', '2026-12-31', 'open')`, [A.id, `FY26 r187 ${A.id.slice(0, 8)}`]);
  clearSystemAccountCache();
});
beforeEach(() => { h.verifyTransaction.mockReset(); });
afterAll(async () => {
  vi.unstubAllEnvs();
  await pool.query('DELETE FROM bank_transactions WHERE company_id = $1', [A.id]);
  await cleanup([A]);
});

describe('R-187 round 1: a cancelled receipt the gateway did not write never blocks the first settlement', () => {
  it('webhook (guarded UPDATE matched) after a cancelled MANUAL card receipt with the reference: banks as usual', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id);
    await cancelledManualReceipt(ref, id, 'card');

    expect((await deliver(ref, 11500)).statusCode).toBe(200);

    expect(await outcome(ref, id)).toMatchObject({
      statuses: ['cancelled', 'confirmed'], live: [{ total: '115.00', allocated: '115.00' }], invoicePaid: '115.00', review: null });
  });

  it('verify (moves the request) after a cancelled MANUAL EFT receipt with the reference: banks as usual', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id);
    await cancelledManualReceipt(ref, id, 'eft');
    h.verifyTransaction.mockResolvedValue(
      { status: 'success', id: 1871, amountCents: 11500, currency: 'ZAR', paidAt: new Date().toISOString(), channel: 'card' });

    expect((await verify(ref)).body.data).toMatchObject({ status: 'completed', amountCents: 11500, appliedToInvoice: true });

    expect(await outcome(ref, id)).toMatchObject({
      statuses: ['cancelled', 'confirmed'], live: [{ total: '115.00', allocated: '115.00' }], invoicePaid: '115.00', review: null });
  });

  it('a LIVE receipt with no journal (a draft manual receipt with the reference) still dedupes, as before R-187', async () => {
    // Pre-existing behaviour kept exactly (the brief: a live match is unchanged); it pins the LEFT JOIN.
    const id = await invoice(A);
    const ref = await checkout(A, id);
    await inTx(() => createCustomerPayment(A.id, {
      clientId: A.customer, paymentDate: today(), totalAmount: 115, paymentMethod: 'eft', bankReference: ref,
      bankAccountId: bankId, allocations: [{ invoiceId: id, amount: 115 }],
    }, A.user));

    expect((await deliver(ref, 11500)).statusCode).toBe(200);

    expect(await outcome(ref, id)).toMatchObject({ statuses: ['draft'], invoicePaid: '0.00', review: null });
  });

  it('webhook after a cancelled BANK-FEED allocation whose line carried the reference: banks as usual', async () => {
    const id = await invoice(A);
    const ref = await checkout(A, id);
    await cancelledBankFeedReceipt(ref, id);

    expect((await deliver(ref, 11500)).statusCode).toBe(200);

    expect(await outcome(ref, id)).toMatchObject({
      statuses: ['cancelled', 'confirmed'], live: [{ total: '115.00', allocated: '115.00' }], invoicePaid: '115.00', review: null });
  });
});

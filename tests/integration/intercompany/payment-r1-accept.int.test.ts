/**
 * Intercompany F, review round 1: the receiver's accept and its refusals.
 *   B1     a receipt that does not exist, is another customer's or a contra answers receipt_not_candidate; only a real candidate that other
 *          payment messages already consumed answers receipt_short.
 *   B2     a held receipt row (existing) or a held invoice row (draft) is a retryable 409 busy, never a 500; nothing written.
 *   B3     the draft refusal and the linked invoice are judged over the FULL set, not the first 100 receipts / 200 invoices.
 *   LOW-2  a confirmed receipt of the customer, dated on or after the payment, whose unconsumed cash still covers the amount may already hold
 *          this payment though it is not a candidate: the draft needs an explicit confirmation naming how many there are.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { count } from './intercompany.helpers';
import { mirrorCleanup, plantArInvoice, wipeConnections } from './mirror.helpers';
import { setLoanClearing } from './loan-clearing.helpers';
import { clearPayments } from './allocation.helpers';
import {
  cashConnect, clearReceipts, co, dataOf, draftBody, errorText, existingBody, offeredOf, openSession, payApi, paymentSetup, plantReceipt, rows, sentPayment, U,
} from './payment.helpers';
import type { PaymentDetail } from '../../../src/modules/accounting/services/intercompany/paymentInboxTypes';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let conn = '';

beforeAll(() => paymentSetup(pool), 60000);
afterAll(async () => { await clearReceipts(pool); await clearPayments(pool); await mirrorCleanup(pool); }, 60000);
beforeEach(async () => {
  await clearReceipts(pool);
  await clearPayments(pool);
  await wipeConnections(pool);
  await setLoanClearing(pool, [co.A, co.B, co.C], true);
  conn = await cashConnect(pool);
});

const snapshot = async (message: string) => ({
  aj: await rows.journals(pool, co.A), receipts: await rows.receipts(pool), msg: await rows.message(pool, message),
  allocs: await count(pool, 'SELECT count(*) AS n FROM customer_payment_allocations a JOIN customer_payments p ON p.id = a.payment_id WHERE p.company_id = $1', [co.A]),
});
async function refused(message: string, call: () => Promise<{ state: { statusCode: number; body: unknown } }>, status: number, text: RegExp) {
  const before = await snapshot(message);
  const res = await call();
  expect(res.state.statusCode, errorText(res)).toBe(status);
  expect(errorText(res)).toMatch(text);
  expect(await snapshot(message)).toEqual(before);
}
const NOT_CANDIDATE = /is not one this payment can be matched to/;
const detailOf = async (message: string) => dataOf<PaymentDetail>(await payApi.get(U.a, co.A, message));

describe('B1: receipt_not_candidate vs receipt_short', () => {
  it('a receipt id that does not exist, another customer\'s receipt and a contra: not a candidate (never "too little left")', async () => {
    const s = await sentPayment(pool, conn);
    const stranger = crypto.randomUUID();
    await pool.query('INSERT INTO customers(id, company_id, name) VALUES ($1, $2, $3)', [stranger, co.A, 'IC r1 stranger']);
    for (const receipt of [crypto.randomUUID(), await plantReceipt(pool, { client: stranger }), await plantReceipt(pool, { method: 'contra' })]) {
      await refused(s.message, () => payApi.accept(U.a, co.A, s.message, existingBody(s, receipt)), 422, NOT_CANDIDATE);
    }
  });

  it('a real candidate another payment message already consumed: receipt_short', async () => {
    const one = await sentPayment(pool, conn, { amount: 600 });
    const two = await sentPayment(pool, conn);
    const receipt = await plantReceipt(pool, { amount: 1150 });
    expect((await payApi.accept(U.a, co.A, one.message, existingBody(one, receipt))).state.statusCode).toBe(200);
    await refused(two.message, () => payApi.accept(U.a, co.A, two.message, existingBody(two, receipt)), 422, /Too little of that receipt is left/);
  });
});

describe('B2: lock contention is a retryable 409', () => {
  it('existing: the receipt row held by another session', async () => {
    const s = await sentPayment(pool, conn);
    const receipt = await plantReceipt(pool);
    const holder = await openSession(pool, U.a, co.A, null);
    try {
      await holder.query('SELECT id FROM customer_payments WHERE id = $1 FOR UPDATE', [receipt]);
      await refused(s.message, () => payApi.accept(U.a, co.A, s.message, existingBody(s, receipt)), 409, /being handled right now/);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  }, 30000);

  it('draft: the invoice row held by another session', async () => {
    const s = await sentPayment(pool, conn);
    const offered = await offeredOf(s.message);
    const holder = await openSession(pool, U.a, co.A, null);
    try {
      await holder.query('SELECT id FROM customer_invoices WHERE id = $1 FOR UPDATE', [s.invoice]);
      await refused(s.message, () => payApi.accept(U.a, co.A, s.message, draftBody(s, {}, offered)), 409, /being handled right now/);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  }, 30000);
});

describe('B3: no truncation before the draft refusal', () => {
  it('101 earlier larger receipts do not push the exact one past the cut: the draft stays refused, the exact receipt listed first', async () => {
    const s = await sentPayment(pool, conn);
    for (let i = 0; i < 101; i += 1) await plantReceipt(pool, { amount: 5000, date: '2026-09-02' });
    const exact = await plantReceipt(pool, { amount: 1150, date: '2026-09-03' });
    const d = await detailOf(s.message);
    expect(d.suggestions!.draftAllowed).toBe(false);
    expect(d.suggestions!.draftRefusal).toBe('exact_receipt');
    expect(d.suggestions!.receipts[0]!.id).toBe(exact);
    const body = { ...draftBody(s, {}, await offeredOf(s.message)), confirmNoHolder: true };
    body.expected = { ...body.expected, holderCount: d.suggestions!.holderCount } as typeof body.expected;
    await refused(s.message, () => payApi.accept(U.a, co.A, s.message, body), 422, /A receipt you already have matches this payment/);
  }, 60000);

  it('200 older open invoices of the customer do not push the linked invoice out of the offer', async () => {
    const s = await sentPayment(pool, conn);
    const older: string[] = [];
    try {
      for (let i = 0; i < 200; i += 1) older.push((await plantArInvoice(pool, { status: 'approved', date: '2026-02-01' })).id);
      const d = await detailOf(s.message);
      expect(d.suggestions!.invoices[0]).toMatchObject({ id: s.invoice, linked: true });
    } finally {
      await pool.query("UPDATE customer_invoices SET status = 'cancelled' WHERE id = ANY($1::uuid[])", [older]);
    }
  }, 120000);
});

describe('LOW-2: a receipt that may already hold the payment', () => {
  it('a fully allocated R2 300 receipt that took m1 still has R1 150 unconsumed: m2\'s draft needs the confirmation, with the count the person saw', async () => {
    const m1 = await sentPayment(pool, conn);
    const m2 = await sentPayment(pool, conn);
    const third = (await plantArInvoice(pool, { status: 'approved' })).id;
    const receipt = await plantReceipt(pool, { amount: 2300, alloc: [{ invoice: m1.invoice, amount: 1150 }, { invoice: third, amount: 1150 }] });
    expect((await payApi.accept(U.a, co.A, m1.message, existingBody(m1, receipt))).state.statusCode).toBe(200);
    const d = await detailOf(m2.message);
    expect(d.suggestions!.receipts.map((r) => r.id)).not.toContain(receipt);   // not a candidate (allocated elsewhere, not on m2's invoice)
    expect(d.suggestions!.draftAllowed).toBe(true);
    expect(d.suggestions!).toMatchObject({ holderCount: 1, holders: [{ id: receipt, unconsumed: 1150 }] });
    const offered = await offeredOf(m2.message);
    await refused(m2.message, () => payApi.accept(U.a, co.A, m2.message, draftBody(m2, {}, offered)), 422, /check that none of them holds this payment/);
    const stale = { ...draftBody(m2, {}, offered), confirmNoHolder: true };
    stale.expected = { ...stale.expected, holderCount: 0 } as typeof stale.expected;
    await refused(m2.message, () => payApi.accept(U.a, co.A, m2.message, stale), 409, /changed since you opened it/);
    const ok = { ...draftBody(m2, {}, offered), confirmNoHolder: true };
    ok.expected = { ...ok.expected, holderCount: 1 } as typeof ok.expected;
    const res = await payApi.accept(U.a, co.A, m2.message, ok);
    expect(res.state.statusCode, errorText(res)).toBe(200);
  });

  it('control: with no such receipt the draft needs no confirmation', async () => {
    const s = await sentPayment(pool, conn);
    expect((await detailOf(s.message)).suggestions).toMatchObject({ holderCount: 0, holders: [] });
    const res = await payApi.accept(U.a, co.A, s.message, draftBody(s, {}, await offeredOf(s.message)));
    expect(res.state.statusCode, errorText(res)).toBe(200);
  });
});

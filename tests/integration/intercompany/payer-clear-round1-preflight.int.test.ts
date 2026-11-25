/**
 * Intercompany P4-E, fix round 1 (C): the receiver-readiness preflight is CUMULATIVE. Besides the partner's draft receipts it subtracts what this
 * payer's own allocation messages to the invoice already claim and the partner has not cleared yet: a pending (or failed / dismissed) message
 * whose payer side still stands, and an accepted one whose clearing receipt the partner voided. An accepted message whose receipt stands is
 * already in the invoice's amount_paid and is not subtracted twice; a message the payer voided claims nothing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { cancelCustomerPayment } from '../../../src/modules/accounting/services/ar/customerPaymentService';
import actionRoute from '../../../pages/api/accounting/supplier-payments-action';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { callRoute } from '../r035-approval.helpers';
import { co, tokens, U, wipeConnections } from './intercompany.helpers';
import { asService, mirrorCleanup } from './mirror.helpers';
import { clearPayments } from './allocation.helpers';
import { outcomeOf } from './allocation-clear.helpers';
import { allocationsApi } from './allocation-live.helpers';
import { clearBill, clearBody, clearConnect, clearedOf, errorText, payerSetup, plantBill, receiverAccepts, refusedUntouched } from './payer-clear.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let conn = '';
const PARTNER = /partner company cannot clear this/;

beforeAll(() => payerSetup(pool), 60000);
afterAll(async () => { await clearPayments(pool); await mirrorCleanup(pool); }, 60000);
beforeEach(async () => {
  await clearPayments(pool);
  await wipeConnections(pool);
  conn = await clearConnect(pool);
});

/** The partner's invoice (R1 150) part-paid by `paid`, so `1150 - paid` is open on it. */
const invoicePaid = (invoice: string, paid: number) => pool.query('UPDATE customer_invoices SET amount_paid = $2 WHERE id = $1', [invoice, paid]);
const clear = async (b: { bill: string; link: string | null }, amount: number, open: number) => {
  const res = await clearBill(clearBody(b, { amount, open }));
  expect(res.state.statusCode, errorText(res)).toBe(200);
  return clearedOf(res);
};

describe('the preflight counts what this payer already sent to the invoice', () => {
  it('invoice open 600: clear 600, then 400 more is refused (the partner cannot clear it)', async () => {
    const b = await plantBill(pool, conn);
    await invoicePaid(b.invoice, 550);
    await clear(b, 600, 1150);
    await refusedUntouched(pool, b.bill, () => clearBill(clearBody(b, { amount: 400, open: 550 })), 409, PARTNER);
  });

  it('two partials that sum to what is open are allowed; a cent more is not', async () => {
    const b = await plantBill(pool, conn);
    await invoicePaid(b.invoice, 550);
    await clear(b, 300, 1150);
    await clear(b, 300, 850);
    await refusedUntouched(pool, b.bill, () => clearBill(clearBody(b, { amount: 0.01, open: 550 })), 409, PARTNER);
  });

  it('a dismissed message still standing counts; a message the payer voided does not', async () => {
    const b = await plantBill(pool, conn);
    await invoicePaid(b.invoice, 550);
    const first = await clear(b, 600, 1150);
    expect((await allocationsApi.dismiss(U.a, co.A, first.messageId)).state.statusCode).toBe(200);
    await refusedUntouched(pool, b.bill, () => clearBill(clearBody(b, { amount: 1, open: 550 })), 409, PARTNER);
    const voided = await callRoute(actionRoute, tokens[U.b]!, co.B, 'POST', { action: 'void', paymentId: first.paymentId }, '/api/accounting/supplier-payments-action');
    expect(voided.state.statusCode, errorText(voided)).toBe(200);
    await clear(b, 600, 1150);
  });

  it('an accepted message whose receipt stands is in amount_paid already: not subtracted twice', async () => {
    const b = await plantBill(pool, conn);
    const first = await clear(b, 600, 1150);
    expect(outcomeOf(await receiverAccepts(first.messageId, b.invoice, 600))).toMatchObject({ accepted: true });
    await clear(b, 550, 550);
  });

  it('an accepted message whose receipt the partner voided still claims its amount', async () => {
    const b = await plantBill(pool, conn, { total: 2000 });
    const first = await clear(b, 600, 2000);
    const acc = outcomeOf(await receiverAccepts(first.messageId, b.invoice, 600));
    expect(acc).toMatchObject({ accepted: true });
    await asService(pool, U.a, co.A, () => cancelCustomerPayment(co.A, acc.paymentId!, U.a, 'undo'));
    expect(Number((await pool.query('SELECT COALESCE(amount_paid, 0)::float8 AS p FROM customer_invoices WHERE id = $1', [b.invoice])).rows[0].p)).toBeCloseTo(0, 2);
    await refusedUntouched(pool, b.bill, () => clearBill(clearBody(b, { amount: 600, open: 1400 })), 409, PARTNER);
    await clear(b, 550, 1400);
  });
});

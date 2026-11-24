/**
 * Intercompany P4-E, fix round 1 (A, N, B). A: once a clearing's allocation message was sent, the payer may not UNAPPLY the clearing payment,
 * whatever the message's status (pending too): an unapply would leave the clearing journal standing (AP debited, the loan credited), the message
 * dead (allocation_gone) and the bill open, so the bill could be cleared a second time and the loan credited twice; and the processed loan-credit
 * payment cannot be applied to another bill (an unlinked one of the same supplier included). Void stays the only undo of a pending clearing.
 * N: the unapply refusal takes no advisory key (it is refused whatever a receiver does), so it cannot meet a void in the opposite lock order.
 * B: the connection holds count only a message that can still be accepted: a void of the clearing (or the receiver dismissing a dead one)
 * releases unlink, the settlement mode and the loan accounts; an accepted one, and a dismissed one still standing, keep holding.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import actionRoute from '../../../pages/api/accounting/supplier-payments-action';
import allocationsRoute from '../../../pages/api/accounting/supplier-allocations';
import { planSupplierPaymentUnapply } from '../../../src/modules/accounting/services/ap/supplierPaymentUnapply';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { callRoute } from '../r035-approval.helpers';
import { api, co, tokens, U, wipeConnections } from './intercompany.helpers';
import { asService, mirrorCleanup } from './mirror.helpers';
import { clearPayments } from './allocation.helpers';
import { loan, outcomeOf } from './allocation-clear.helpers';
import { pairingApi } from './pairing.helpers';
import { holdCapLock } from './allocation-clear-round1.helpers';
import { allocationsApi } from './allocation-live.helpers';
import { clearBill, clearBody, clearConnect, clearedOf, errorText, payer, payerSetup, plantBill, receiverAccepts } from './payer-clear.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let conn = '';
const NO_UNAPPLY = /cannot be unapplied[^"]*Void/i;
const NO_REAPPLY = /cleared a bill against the intercompany loan[^"]*cannot be applied/i;

beforeAll(() => payerSetup(pool), 60000);
afterAll(async () => { await clearPayments(pool); await mirrorCleanup(pool); }, 60000);
beforeEach(async () => {
  await clearPayments(pool);
  await wipeConnections(pool);
  conn = await clearConnect(pool);
});

const action = (body: Record<string, unknown>) => callRoute(actionRoute, tokens[U.b]!, co.B, 'POST', body, '/api/accounting/supplier-payments-action');
const reversals = async (je: string) => Number((await pool.query('SELECT count(*)::int AS n FROM gl_journal_entries WHERE reversal_of_id = $1', [je])).rows[0].n);
const allocations = async (payment: string) => Number((await pool.query('SELECT count(*)::int AS n FROM payment_allocations WHERE payment_id = $1', [payment])).rows[0].n);

async function cleared(amount = 1150) {
  const b = await plantBill(pool, conn);
  const res = await clearBill(clearBody(b, { amount }));
  expect(res.state.statusCode, errorText(res)).toBe(200);
  return { b, out: clearedOf(res) };
}

describe('A: a sent clearing is never unapplied', () => {
  it('a PENDING clearing: unapply is refused (the route and the dry run), pointing to Void; nothing moved; a second clearing is impossible', async () => {
    const { b, out } = await cleared();
    const res = await action({ action: 'unapply', paymentId: out.paymentId });
    expect(res.state.statusCode).toBe(400);
    expect(errorText(res)).toMatch(NO_UNAPPLY);
    const dry = await asService(pool, U.b, co.B, () => planSupplierPaymentUnapply(co.B, { paymentId: out.paymentId })).then(() => 'planned', (e: unknown) => String(e));
    expect(dry).toMatch(NO_UNAPPLY);
    expect(await allocations(out.paymentId)).toBe(1);
    expect(await payer.open(pool, b.bill)).toBeCloseTo(0, 2);
    expect(await reversals(out.journalEntryId)).toBe(0);
    expect((await payer.messageFor(pool, out.paymentId))?.status).toBe('pending');
    const again = await clearBill(clearBody(b, { open: 0 }));
    expect(again.state.statusCode).toBe(409);
    expect(await payer.payments(pool)).toBe(1);
  });

  it('a REJECTED clearing: unapply is still refused (the journal stands either way)', async () => {
    const { out } = await cleared();
    const rej = await allocationsApi.reject(U.a, co.A, out.messageId, { reason: 'not ours' });
    expect(rej.state.statusCode, errorText(rej)).toBe(200);
    const res = await action({ action: 'unapply', paymentId: out.paymentId });
    expect(res.state.statusCode).toBe(400);
    expect(errorText(res)).toMatch(NO_UNAPPLY);
  });

  it('the void still undoes a pending clearing: reversed once, the bill reopened, and it can then be cleared again (once)', async () => {
    const { b, out } = await cleared();
    expect((await action({ action: 'void', paymentId: out.paymentId })).state.statusCode).toBe(200);
    expect(await reversals(out.journalEntryId)).toBe(1);
    expect(await payer.open(pool, b.bill)).toBeCloseTo(1150, 2);
    expect((await clearBill(clearBody(b))).state.statusCode).toBe(200);
    expect((await clearBill(clearBody(b, { open: 0 }))).state.statusCode).toBe(409);
  });

  it('the loan-credit payment, its allocation gone by any other route, is not applied to an UNLINKED bill of the same supplier', async () => {
    const { b, out } = await cleared();
    // what an unapply before this fix left: the allocation row gone, the bill open again, the clearing journal standing
    await pool.query('DELETE FROM payment_allocations WHERE payment_id = $1', [out.paymentId]);
    await pool.query("UPDATE supplier_invoices SET amount_paid = 0, status = 'approved', payment_matched = false WHERE id = $1", [b.bill]);
    const lone = await plantBill(pool, conn, { link: false });
    for (const bill of [lone.bill, b.bill]) {
      const res = await callRoute(allocationsRoute, tokens[U.b]!, co.B, 'POST', { paymentId: out.paymentId, allocations: [{ invoiceId: bill, amount: 1150 }] },
        '/api/accounting/supplier-allocations');
      expect(res.state.statusCode).toBe(400);
      expect(errorText(res)).toMatch(NO_REAPPLY);
    }
    expect(await allocations(out.paymentId)).toBe(0);
    expect(await payer.open(pool, lone.bill)).toBeCloseTo(1150, 2);
  });

  it('N: the unapply refusal waits for no advisory key (a receiver holding the cap lock does not delay it)', async () => {
    const { out } = await cleared();
    const held = await holdCapLock(pool, out.messageId);
    try {
      const answer = await Promise.race([
        action({ action: 'unapply', paymentId: out.paymentId }).then((r) => r.state.statusCode),
        new Promise<string>((resolve) => { setTimeout(() => resolve('waited'), 3000); }),
      ]);
      expect(answer).toBe(400);
    } finally {
      await held.release();
    }
  }, 20000);
});

describe('B: the connection holds count only a message that can still be accepted', () => {
  const edits = async (link: string) => [
    (await api.edit(U.a, co.A, conn, { loanAccountId: loan.a2 })).state.statusCode,
    (await pairingApi.unlink(U.b, co.B, conn, link)).state.statusCode,
    (await api.settings(U.ab, co.A, conn, { settlementMode: 'cash' })).state.statusCode,
  ];

  it('cleared then voided (the message still pending but dead): unlink, the mode and the loan accounts change again', async () => {
    const { b, out } = await cleared();
    expect((await action({ action: 'void', paymentId: out.paymentId })).state.statusCode).toBe(200);
    expect((await payer.messageFor(pool, out.paymentId))?.status).toBe('pending');
    expect(await edits(b.link!)).toEqual([200, 200, 200]);
  });

  it('dismissed by the receiver and then voided: nothing held; dismissed while it still stands: held', async () => {
    const { b, out } = await cleared();
    expect((await allocationsApi.dismiss(U.a, co.A, out.messageId)).state.statusCode).toBe(200);
    expect((await pairingApi.unlink(U.b, co.B, conn, b.link!)).state.statusCode).toBe(409);
    expect((await api.edit(U.a, co.A, conn, { loanAccountId: loan.a2 })).state.statusCode).toBe(409);
    expect((await action({ action: 'void', paymentId: out.paymentId })).state.statusCode).toBe(200);
    expect(await edits(b.link!)).toEqual([200, 200, 200]);
  });

  it('accepted, then the payer cannot void it: still held from either side', async () => {
    const { b, out } = await cleared();
    expect(outcomeOf(await receiverAccepts(out.messageId, b.invoice, 1150))).toMatchObject({ accepted: true });
    expect((await pairingApi.unlink(U.b, co.B, conn, b.link!)).state.statusCode).toBe(409);
    expect((await api.edit(U.a, co.A, conn, { loanAccountId: loan.a2 })).state.statusCode).toBe(409);
  });
});

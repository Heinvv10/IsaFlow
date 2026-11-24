/**
 * Intercompany P4-E, fix round 2, through the real routes. MED-1: a BANK-paid allocation message (cashLegIsLoanAccount false) is not claimed
 * by the receiver-readiness preflight and does not hold the connection: P4-D can never accept it (cash_not_through_loan). MED-3: the preview
 * asks the partner's readiness for the smallest amount, so a partner invoice with LESS open than the bill does not disable the dialog; the POST
 * judges the amount chosen. MED-5: the undo refusal after the partner cleared says honestly that the app cannot undo it yet.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import actionRoute from '../../../pages/api/accounting/supplier-payments-action';
import { log } from '../../../src/lib/logger';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { callRoute } from '../r035-approval.helpers';
import { api, co, tokens, U, wipeConnections } from './intercompany.helpers';
import { dataOf, mirrorCleanup } from './mirror.helpers';
import { clearPayments, plantPaid, sendFor } from './allocation.helpers';
import { loan, outcomeOf } from './allocation-clear.helpers';
import { pairingApi } from './pairing.helpers';
import {
  clearBill, clearBody, clearConnect, clearedOf, errorText, payerSetup, plantBill, previewAs, receiverAccepts, refusedUntouched,
} from './payer-clear.helpers';
import type { LoanClearingPreview } from '../../../src/modules/accounting/services/intercompany/payerLoanClearTypes';

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

const invoicePaid = (invoice: string, paid: number) => pool.query('UPDATE customer_invoices SET amount_paid = $2 WHERE id = $1', [invoice, paid]);
const action = (body: Record<string, unknown>) => callRoute(actionRoute, tokens[U.b]!, co.B, 'POST', body, '/api/accounting/supplier-payments-action');

/** B's bill R1 150 part-paid from B's BANK (600): the allocation message is sent (pending, cashLegIsLoanAccount false); A received 600 in its bank. */
async function bankPaidHalf() {
  const b = await plantBill(pool, conn);
  const p = await plantPaid(pool, b.bill, { amount: 600 });
  await pool.query('UPDATE supplier_invoices SET amount_paid = 600 WHERE id = $1', [b.bill]);
  const sent = await sendFor(pool, p.allocation);
  expect(sent.message_id, String(sent.reason)).toBeTruthy();
  expect((await pool.query("SELECT status, payload #>> '{payment,cashLegIsLoanAccount}' AS c FROM intercompany_messages WHERE id = $1", [sent.message_id]))
    .rows[0]).toEqual({ status: 'pending', c: 'false' });
  await invoicePaid(b.invoice, 600);
  return b;
}

describe('MED-1: a bank-paid message is neither claimed nor a hold', () => {
  it('bill 1150 paid 600 from the bank, the partner received 600 in its bank: clearing the 550 left posts (not 1150 - 600 - 600)', async () => {
    const b = await bankPaidHalf();
    const res = await clearBill(clearBody(b, { amount: 550, open: 550 }));
    expect(res.state.statusCode, errorText(res)).toBe(200);
    expect(clearedOf(res).cleared).toBe(true);
  });

  it('the cent past what the partner has open is still refused', async () => {
    const b = await bankPaidHalf();
    await invoicePaid(b.invoice, 600.01);
    await refusedUntouched(pool, b.bill, () => clearBill(clearBody(b, { amount: 550, open: 550 })), 409, PARTNER);
  });

  it('a bank-paid linked bill does not hold the connection: unlink, settlement mode and the loan account change', async () => {
    const b = await bankPaidHalf();
    expect((await api.edit(U.a, co.A, conn, { loanAccountId: loan.a2 })).state.statusCode).toBe(200);
    const unlink = await pairingApi.unlink(U.b, co.B, conn, b.link!);
    expect(unlink.state.statusCode, errorText(unlink)).toBe(200);
    expect((await api.settings(U.ab, co.A, conn, { settlementMode: 'cash' })).state.statusCode).toBe(200);
  });

  it('a loan clearing still pending keeps holding them', async () => {
    const b = await plantBill(pool, conn);
    expect((await clearBill(clearBody(b, { amount: 100 }))).state.statusCode).toBe(200);
    expect((await api.edit(U.a, co.A, conn, { loanAccountId: loan.a2 })).state.statusCode).toBe(409);
    expect((await pairingApi.unlink(U.b, co.B, conn, b.link!)).state.statusCode).toBe(409);
    expect((await api.settings(U.ab, co.A, conn, { settlementMode: 'cash' })).state.statusCode).toBe(409);
  });
});

describe('MED-3: a partner invoice with less open than the bill', () => {
  it('the preview is not blocked and the partner reads ready; the smaller amount posts, the bill open amount is refused', async () => {
    const b = await plantBill(pool, conn);
    await invoicePaid(b.invoice, 750);
    const res = await previewAs(U.b, co.B, b.bill);
    expect(res.state.statusCode, errorText(res)).toBe(200);
    const p = dataOf<LoanClearingPreview>(res);
    expect(p).toMatchObject({ blocked: null, receiverReady: true, maxAmount: 1150 });
    await refusedUntouched(pool, b.bill, () => clearBill(clearBody(b)), 409, PARTNER);
    const ok = await clearBill(clearBody(b, { amount: 400 }));
    expect(ok.state.statusCode, errorText(ok)).toBe(200);
  });

  it('nothing open on the partner invoice: the preview says the partner is not ready', async () => {
    const b = await plantBill(pool, conn);
    await invoicePaid(b.invoice, 1150);
    const p = dataOf<LoanClearingPreview>(await previewAs(U.b, co.B, b.bill));
    expect(p.receiverReady).toBe(false);
    expect(p.blocked).toMatch(PARTNER);
  });
});

describe('8f: the preview is a page view', () => {
  it('a not-ready preview logs the word at debug, not info; the refused POST logs it at info', async () => {
    const b = await plantBill(pool, conn);
    await invoicePaid(b.invoice, 1150);
    const info = vi.spyOn(log, 'info');
    const debug = vi.spyOn(log, 'debug');
    const said = (spy: typeof info) => spy.mock.calls.filter((c) => String(c[0]).includes('the partner is not ready')).length;
    try {
      expect((await previewAs(U.b, co.B, b.bill)).state.statusCode).toBe(200);
      expect([said(info), said(debug)]).toEqual([0, 1]);
      expect((await clearBill(clearBody(b))).state.statusCode).toBe(409);
      expect([said(info), said(debug)]).toEqual([1, 1]);
    } finally {
      info.mockRestore();
      debug.mockRestore();
    }
  });
});

describe('MED-5: after the partner cleared, the refusal is honest', () => {
  it('void and unapply say it cannot be undone in the app yet and to contact support; no promise of a cancel-then-reverse path', async () => {
    const b = await plantBill(pool, conn);
    const out = clearedOf(await clearBill(clearBody(b)));
    expect(outcomeOf(await receiverAccepts(out.messageId, b.invoice, 1150))).toMatchObject({ accepted: true });
    for (const name of ['void', 'unapply']) {
      const res = await action({ action: name, paymentId: out.paymentId });
      expect(res.state.statusCode, name).toBe(400);
      const text = errorText(res);
      expect(text).toMatch(/partner already cleared this/i);
      expect(text).toMatch(/cannot be undone in the app yet/);
      expect(text).toMatch(/contact support/i);
      expect(text).not.toMatch(/cancel their clearing receipt|reverse it with your accountant/);
    }
  });
});

/**
 * Intercompany F, review round 1: CASH ONLY on the payer's side and the receiver's state word.
 *   MED-1  D1 refuses `not_cash` for a contra set-off (payment_method 'contra', whatever account rides in the bank column) and for a journal
 *          that credits no money account (bank / cash subtype, or an account holding statement lines); the unsent read lists neither.
 *   B5     the unsent read lists only what D1 could still send: no contra, no non-money leg, no loan leg, no reversed journal, no superseded.
 *   LOW-1  D2 answers `not_cash` once the connection is off cash (between connection_gone and not_enabled).
 *   B6     D2 answers `closed` for a rejected / dismissed / failed message, `open` again after a restore.
 *   auto   the auto-accept worker never takes a payment message, even with auto_accept on for the receiver's side.
 * Review round 2 (plan (n)):
 *   MED-R1 a bank-first (R-127) payment is cash: its own journal is the RECLASS (DR AP / CR the provisional's expense lines), the provisional
 *          it settles credited the bank. D1 sends it and the unsent read lists it (settlementKind's rule 2, intercompany_payment_cash_word).
 *   LOW-R2 a journal crediting no money account is `no_money_account` (not `not_cash`, which is the connection's mode and a contra set-off),
 *          and the unsent read LISTS it, marked, so the payer sees it; still nothing is sent.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { runAutoAccept } from '../../../src/modules/accounting/services/intercompany/autoAcceptWorker';
import { asAppUser, count, withoutTrigger } from './intercompany.helpers';
import { mirrorCleanup, wipeConnections } from './mirror.helpers';
import { setLoanClearing } from './loan-clearing.helpers';
import { clearPayments, plantBill, plantPaid, plantPaymentJournal } from './allocation.helpers';
import {
  acct, cashConnect, clearReceipts, co, dataOf, errorText, payApi, paymentMessages, paymentSetup, plantReceipt, sendAlloc, sendPay, sentPayment, stateOf, U,
} from './payment.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let conn = '';
const acc = { clearing: '', paycard: '', bareNoLines: '', expense: '' };

beforeAll(async () => {
  await paymentSetup(pool);
  for (const k of Object.keys(acc) as (keyof typeof acc)[]) acc[k] = crypto.randomUUID();
  const tag = co.B.slice(0, 5);
  // a balance-sheet clearing account (not money), a paycard whose subtype was never set but holds a statement line (money), and a bare one
  for (const [id, code, subtype, type] of [[acc.clearing, `CL1${tag}`, 'other_current_asset', 'asset'], [acc.paycard, `PC1${tag}`, null, 'asset'],
    [acc.bareNoLines, `NS1${tag}`, null, 'asset'], [acc.expense, `EX1${tag}`, 'operating_expense', 'expense']] as const) {
    await pool.query(
      `INSERT INTO gl_accounts(id, company_id, account_code, account_name, account_type, normal_balance, is_active, account_subtype)
       VALUES ($1, $2, $3, $3, $5, 'debit', true, $4)`, [id, co.B, code, subtype, type]);
  }
  await pool.query("INSERT INTO bank_transactions(company_id, bank_account_id, transaction_date, amount, description) VALUES ($1, $2, DATE '2026-09-01', -5, 'IC r1 paycard line')", [co.B, acc.paycard]);
}, 60000);
afterAll(async () => {
  await pool.query('DELETE FROM bank_transactions WHERE bank_account_id = $1', [acc.paycard]);
  await clearReceipts(pool); await clearPayments(pool); await mirrorCleanup(pool);
}, 60000);
beforeEach(async () => {
  await clearReceipts(pool);
  await clearPayments(pool);
  await wipeConnections(pool);
  await setLoanClearing(pool, [co.A, co.B, co.C], true);
  conn = await cashConnect(pool);
});

const setConn = (set: string) => asAppUser(pool, U.ab, co.A, (q) => q.query(`UPDATE intercompany_connections SET ${set} WHERE id = $1`, [conn]), true);
const paid = async (over: Parameters<typeof plantPaid>[2] = {}) => plantPaid(pool, (await plantBill(pool, conn)).bill, over);

describe('MED-1: D1 sends for cash only', () => {
  it('a contra set-off on a linked bill (settle_by_contra: method contra, a non-loan balance-sheet account in the bank column) is not_cash; D3 answers not_loan first', async () => {
    const p = await paid({ method: 'contra', leg: acc.clearing });
    expect((await sendAlloc(pool, p.allocation)).reason).toBe('not_loan');
    expect(await sendPay(pool, p.allocation)).toEqual({ message_id: null, reason: 'not_cash', detail: null });
    expect(await paymentMessages(pool)).toHaveLength(0);
  });

  it.each([
    ['a contra whose contra account IS a bank account', { method: 'contra' }, 'not_cash'],
    ['(round 2 LOW-R2) an eft payment whose journal credits a clearing account', { leg: 'clearing' }, 'no_money_account'],
    ['(round 2 LOW-R2) an eft payment whose journal credits an account with no subtype and no statement line', { leg: 'bareNoLines' }, 'no_money_account'],
  ] as const)('%s, nothing written', async (_name, over, reason) => {
    const leg = 'leg' in over ? acc[over.leg] : undefined;
    const p = await paid({ ...('method' in over ? { method: over.method } : {}), ...(leg ? { leg } : {}) });
    expect((await sendPay(pool, p.allocation)).reason).toBe(reason);
    expect(await paymentMessages(pool)).toHaveLength(0);
  });

  it('(round 2 MED-R1) a bank-first payment (its reclass journal credits expense; the provisional it settles credited the bank) is sent', async () => {
    const prov = await plantPaymentJournal(pool, 1150);                                // the provisional: credits B's bank
    const p = await paid({ leg: acc.expense, provisional: prov });                    // the reclass: DR AP / CR the provisional's expense line
    expect(await sendPay(pool, p.allocation)).toMatchObject({ reason: null, detail: null });
    expect(await paymentMessages(pool, p.allocation)).toHaveLength(1);
  });

  it('(round 2 MED-R1) control: the same reclass with NO provisional, or a provisional that credited a clearing account, is no_money_account', async () => {
    const bare = await paid({ leg: acc.expense });
    const viaClearing = await paid({ leg: acc.expense, provisional: await plantPaymentJournal(pool, 1150, { leg: acc.clearing }) });
    for (const p of [bare, viaClearing]) expect((await sendPay(pool, p.allocation)).reason, p.allocation).toBe('no_money_account');
    expect(await paymentMessages(pool)).toHaveLength(0);
  });

  it('control: an eft from a bank, and from a paycard holding statement lines (no subtype), are sent', async () => {
    for (const leg of [undefined, acc.paycard]) {
      const p = await paid(leg ? { leg } : {});
      expect((await sendPay(pool, p.allocation)).reason, String(leg)).toBeNull();
    }
    expect(await paymentMessages(pool)).toHaveLength(2);
  });
});

describe('B5: the unsent read lists only what D1 could still send', () => {
  it('lists the lost eft and a bank-first one, marks a non-money leg, never a contra, a loan leg, a reversed journal or a superseded payment', async () => {
    const lost = await paid();                                                          // control: flag off at send, nothing written
    const bankFirst = await paid({ leg: acc.expense, provisional: await plantPaymentJournal(pool, 1150) });   // round 2 MED-R1
    const noMoney = [await paid({ leg: acc.clearing }), await paid({ leg: acc.bareNoLines })];             // round 2 LOW-R2: listed, marked
    const shown = [lost.allocation, bankFirst.allocation, ...noMoney.map((p) => p.allocation)].sort();
    const hidden = [
      await paid({ method: 'contra', leg: acc.clearing }), await paid({ method: 'contra' }),
      await paid({ leg: acct.bLoan }), await paid({ reversed: true }),
    ].map((p) => p.allocation);
    // superseded: an accepted message of a payment whose allocation row is gone; the payment re-applied to another bill sends nothing
    const first = await sentPayment(pool, conn);
    await withoutTrigger(pool, 'intercompany_messages', 'trg_intercompany_messages_guard', (q) => q.query("UPDATE intercompany_messages SET status = 'accepted' WHERE id = $1", [first.message]));
    await pool.query('DELETE FROM payment_allocations WHERE id = $1', [first.allocation]);
    const other = await plantBill(pool, conn);
    const re = (await pool.query('INSERT INTO payment_allocations(payment_id, invoice_id, amount_allocated) VALUES ($1, $2, 1150) RETURNING id', [first.payment, other.bill])).rows[0].id as string;
    expect((await sendPay(pool, re)).reason).toBe('superseded');
    hidden.push(re);
    const res = await payApi.unsent(U.b, co.B);
    expect(res.state.statusCode, errorText(res)).toBe(200);
    const items = dataOf<{ items: { allocationId: string; refusal: string | null }[] }>(res).items;
    const ids = items.map((i) => i.allocationId);
    expect([...ids].sort()).toEqual(shown);
    for (const h of hidden) expect(ids, h).not.toContain(h);
    const marked = Object.fromEntries(items.map((i) => [i.allocationId, i.refusal]));
    expect(marked).toEqual(Object.fromEntries([[lost.allocation, null], [bankFirst.allocation, null], ...noMoney.map((p) => [p.allocation, 'no_money_account'])]));
    // the marked ones are what D1 refuses (fail closed), the rest D1 sends
    for (const p of noMoney) expect((await sendPay(pool, p.allocation)).reason).toBe('no_money_account');
    expect((await sendPay(pool, bankFirst.allocation)).reason).toBeNull();
  });
});

describe('D2: not_cash and closed', () => {
  it('LOW-1: once the connection is off cash the word is not_cash (before not_enabled: first wins)', async () => {
    const s = await sentPayment(pool, conn);
    await setConn("settlement_mode = 'loan'");
    expect(await stateOf(pool, s.message)).toEqual([{ live: false, state: 'not_cash' }]);
    await setLoanClearing(pool, [co.A], false);
    expect(await stateOf(pool, s.message)).toEqual([{ live: false, state: 'not_cash' }]);
    await setConn("status = 'revoked'");
    expect(await stateOf(pool, s.message)).toEqual([{ live: false, state: 'connection_gone' }]);
  });

  it('B6: rejected, dismissed and failed messages are closed (not live); a restore makes it open again', async () => {
    const r = await sentPayment(pool, conn);
    expect((await payApi.reject(U.a, co.A, r.message, { reason: 'not ours' })).state.statusCode).toBe(200);
    expect(await stateOf(pool, r.message)).toEqual([{ live: false, state: 'closed' }]);
    const d = await sentPayment(pool, conn);
    expect((await payApi.dismiss(U.a, co.A, d.message)).state.statusCode).toBe(200);
    expect(await stateOf(pool, d.message)).toEqual([{ live: false, state: 'closed' }]);
    expect((await payApi.restore(U.a, co.A, d.message)).state.statusCode).toBe(200);
    expect(await stateOf(pool, d.message)).toEqual([{ live: true, state: 'open' }]);
    const f = await sentPayment(pool, conn);
    await withoutTrigger(pool, 'intercompany_messages', 'trg_intercompany_messages_guard', (q) => q.query("UPDATE intercompany_messages SET status = 'failed' WHERE id = $1", [f.message]));
    expect(await stateOf(pool, f.message)).toEqual([{ live: false, state: 'closed' }]);
  });
});

describe('the auto-accept worker never accepts a payment message', () => {
  it("with auto_accept on for the receiver's side: not queued, the worker considers nothing, the message stays pending, no receipt", async () => {
    await asAppUser(pool, U.ab, co.A, (q) => q.query('UPDATE intercompany_connection_sides SET auto_accept = true WHERE connection_id = $1 AND company_id = $2', [conn, co.A]), true);
    const side = (await pool.query('SELECT auto_accept, auto_accept_since FROM intercompany_connection_sides WHERE connection_id = $1 AND company_id = $2', [conn, co.A])).rows[0];
    expect(side.auto_accept).toBe(true);
    const s = await sentPayment(pool, conn);
    await plantReceipt(pool);                                                           // an exact candidate is there to take
    const queue = async (q: Pool | import('pg').PoolClient) => (await q.query('SELECT message_id FROM public.intercompany_auto_accept_queue(50, false)')).rows.map((r) => String(r.message_id));
    expect(await queue(pool)).not.toContain(s.message);
    // the control: the queue's kind filter is the ONE thing that keeps it out (widened in a rolled-back copy, the message is queued)
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const def = String((await c.query("SELECT pg_get_functiondef('public.intercompany_auto_accept_queue(integer, boolean)'::regprocedure) AS d")).rows[0].d);
      const widened = def.replace("m.kind IN ('invoice', 'credit_note')", "m.kind IN ('invoice', 'credit_note', 'payment')");
      expect(widened).not.toBe(def);
      await c.query(widened);
      expect(await queue(c)).toContain(s.message);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
    const receipts = await count(pool, 'SELECT count(*) AS n FROM customer_payments WHERE company_id = $1', [co.A]);
    const run = await runAutoAccept();
    expect(run.accepted).toBe(0);
    expect((await pool.query('SELECT status, target_doc_id FROM intercompany_messages WHERE id = $1', [s.message])).rows[0]).toEqual({ status: 'pending', target_doc_id: null });
    expect(await count(pool, 'SELECT count(*) AS n FROM customer_payments WHERE company_id = $1', [co.A])).toBe(receipts);
  });
});

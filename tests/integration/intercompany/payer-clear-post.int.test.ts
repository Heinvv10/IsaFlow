/**
 * Intercompany P4-E: the PAYER (B) clears its linked bill against its loan account through the real route. Exactly ONE balanced journal
 * (DR B's Accounts Payable control / CR B's loan account = amount) and no other journal in either company; the bill and the loan account move
 * by exactly the amount; the supplier payment is a processed `contra` payment created AND approved by the person, the journal's author label
 * system:ic_loan_clear. The P4-B hook sent ONE allocation message with cashLegIsLoanAccount true, and the receiver (A) clears it (P4-D): both
 * loan balances are equal and opposite, AP and AR each cleared once (the zero-double-count test). A second click clears only what is open; two
 * clicks at the same moment post once; a partial clearing leaves the rest open. The preview names both legs, the amount and the partner.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { acct, co, U, wipeConnections } from './intercompany.helpers';
import { dataOf, mirrorCleanup } from './mirror.helpers';
import { clearPayments } from './allocation.helpers';
import { ledger, outcomeOf } from './allocation-clear.helpers';
import {
  clearBill, clearBody, clearConnect, clearedOf, errorText, payer, payerSetup, plantBill, previewAs, receiverAccepts,
} from './payer-clear.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let conn = '';

beforeAll(() => payerSetup(pool), 60000);
afterAll(async () => { await clearPayments(pool); await mirrorCleanup(pool); }, 60000);
beforeEach(async () => {
  await clearPayments(pool);
  await wipeConnections(pool);
  conn = await clearConnect(pool);
});

describe('clearing a linked bill against the intercompany loan', () => {
  it('posts ONE journal DR AP / CR the loan account, a processed contra payment by the person, and nothing else', async () => {
    const b = await plantBill(pool, conn);
    const [bJournals, aJournals, loanBefore] = [await payer.journals(pool), await payer.journals(pool, co.A), await ledger.balance(pool, acct.bLoan)];
    const res = await clearBill(clearBody(b));
    expect(res.state.statusCode, errorText(res)).toBe(200);
    const out = clearedOf(res);
    expect(out).toMatchObject({ cleared: true, billId: b.bill });
    expect(await payer.journals(pool)).toBe(bJournals + 1);
    expect(await payer.journals(pool, co.A)).toBe(aJournals);
    expect(await ledger.balance(pool, acct.bLoan)).toBeCloseTo(loanBefore - 1150, 2);
    expect(await payer.open(pool, b.bill)).toBeCloseTo(0, 2);
    expect(await payer.status(pool, b.bill)).toBe('paid');
    const ap = await payer.ap(pool);
    expect(await ledger.lines(pool, out.journalEntryId)).toEqual([
      { gl_account_id: ap, debit: 1150, credit: 0, company_id: co.B },
      { gl_account_id: acct.bLoan, debit: 0, credit: 1150, company_id: co.B },
    ]);
    const je = (await pool.query('SELECT status, entry_date::text AS d, posting_agent, created_by::text AS by FROM gl_journal_entries WHERE id = $1', [out.journalEntryId])).rows[0];
    expect(je).toMatchObject({ status: 'posted', d: '2026-09-10', posting_agent: 'system:ic_loan_clear', by: U.b });
    const pay = (await pool.query(
      `SELECT payment_method, status, bank_account_id, total_amount::float8 AS t, payment_date::text AS d, created_by::text AS c, approved_by::text AS k,
              gl_journal_entry_id, description FROM supplier_payments WHERE id = $1`, [out.paymentId])).rows[0];
    expect(pay).toMatchObject({ payment_method: 'contra', status: 'processed', bank_account_id: acct.bLoan, t: 1150, d: '2026-09-10', c: U.b, k: U.b, gl_journal_entry_id: out.journalEntryId });
    expect(String(pay.description)).toMatch(/Cleared against intercompany loan, partner /);
    const alloc = (await pool.query('SELECT invoice_id, amount_allocated::float8 AS a FROM payment_allocations WHERE payment_id = $1', [out.paymentId])).rows;
    expect(alloc).toEqual([{ invoice_id: b.bill, a: 1150 }]);
  });

  it('the hook sent ONE allocation message with cashLegIsLoanAccount true, and the receiver clears it: equal loan balances, AP and AR cleared once', async () => {
    const b = await plantBill(pool, conn);
    const ap = await payer.ap(pool);
    const ar = await ledger.ar(pool);
    const before = { bLoan: await ledger.balance(pool, acct.bLoan), aLoan: await ledger.balance(pool, acct.aLoan), ap: await ledger.balance(pool, ap), ar: await ledger.balance(pool, ar) };
    const out = clearedOf(await clearBill(clearBody(b)));
    const msg = await payer.messageFor(pool, out.paymentId);
    expect(msg?.id).toBe(out.messageId);
    expect(msg?.status).toBe('pending');
    expect(msg?.payload).toMatchObject({ amount: 1150, payment: { cashLegIsLoanAccount: true, method: 'contra' }, issuerDocument: { id: b.invoice }, linkId: b.link });
    expect(await payer.messages(pool)).toBe(1);
    const acc = await receiverAccepts(out.messageId, b.invoice, 1150);
    expect(acc.state.statusCode, errorText(acc)).toBe(200);
    expect(outcomeOf(acc)).toMatchObject({ accepted: true });
    const after = { bLoan: await ledger.balance(pool, acct.bLoan), aLoan: await ledger.balance(pool, acct.aLoan), ap: await ledger.balance(pool, ap), ar: await ledger.balance(pool, ar) };
    // the payer's loan credit equals the receiver's loan debit; AP fell (debited) by R once, AR fell (credited) by R once
    expect(after.bLoan - before.bLoan).toBeCloseTo(-1150, 2);
    expect(after.aLoan - before.aLoan).toBeCloseTo(1150, 2);
    expect(after.ap - before.ap).toBeCloseTo(1150, 2);
    expect(after.ar - before.ar).toBeCloseTo(-1150, 2);
    expect(await payer.open(pool, b.bill)).toBeCloseTo(0, 2);
    expect(await ledger.open(pool, b.invoice)).toBeCloseTo(0, 2);
    // a second clearing of the same bill is refused (nothing open), and the receiver cannot clear more: nothing more was sent
    const again = await clearBill(clearBody(b, { open: 0 }));
    expect(again.state.statusCode).toBe(409);
    expect(errorText(again)).toMatch(/already paid/);
    expect(await payer.messages(pool)).toBe(1);
  });

  it('a partial clearing leaves the rest open; the second click clears only the remainder; a stale open amount is a 409', async () => {
    const b = await plantBill(pool, conn);
    const loanBefore = await ledger.balance(pool, acct.bLoan);
    expect(clearedOf(await clearBill(clearBody(b, { amount: 400 })))).toMatchObject({ cleared: true });
    expect(await payer.open(pool, b.bill)).toBeCloseTo(750, 2);
    expect(await payer.status(pool, b.bill)).toBe('partially_paid');
    const journals = await payer.journals(pool);
    const stale = await clearBill(clearBody(b, { amount: 400 }));
    expect(stale.state.statusCode).toBe(409);
    expect(await payer.journals(pool)).toBe(journals);
    const tooMuch = await clearBill(clearBody(b, { amount: 1150, open: 750 }));
    expect(tooMuch.state.statusCode).toBe(409);
    expect(clearedOf(await clearBill(clearBody(b, { amount: 750, open: 750 })))).toMatchObject({ cleared: true });
    expect(await payer.open(pool, b.bill)).toBeCloseTo(0, 2);
    expect(await payer.messages(pool)).toBe(2);
    expect(await ledger.balance(pool, acct.bLoan)).toBeCloseTo(loanBefore - 1150, 2);
  });

  it('two partial clicks at the same moment post once; the loser is a 409 with nothing written', async () => {
    const b = await plantBill(pool, conn);
    const journals = await payer.journals(pool);
    const [r1, r2] = await Promise.all([clearBill(clearBody(b, { amount: 400 })), clearBill(clearBody(b, { amount: 400 }))]);
    expect([r1.state.statusCode, r2.state.statusCode].sort()).toEqual([200, 409]);
    expect(await payer.journals(pool)).toBe(journals + 1);
    expect(await payer.open(pool, b.bill)).toBeCloseTo(750, 2);
    expect(await payer.messages(pool)).toBe(1);
  });
});

describe('the lock', () => {
  it('a bill held by another transaction: the wait is bounded (5 s) and answered 409 with nothing written', async () => {
    const b = await plantBill(pool, conn);
    const holder = await pool.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM supplier_invoices WHERE id = $1 FOR UPDATE', [b.bill]);
    try {
      const before = [await payer.journals(pool), await payer.payments(pool)];
      const res = await clearBill(clearBody(b));
      expect(res.state.statusCode).toBe(409);
      expect(errorText(res)).toMatch(/right now/);
      expect([await payer.journals(pool), await payer.payments(pool)]).toEqual(before);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect((await clearBill(clearBody(b))).state.statusCode).toBe(200);
  }, 30000);
});

describe('the preview', () => {
  it('names the debit (Accounts Payable) and the credit (the loan account), the open amount, the partner and the receiver is ready', async () => {
    const b = await plantBill(pool, conn);
    const res = await previewAs(U.b, co.B, b.bill);
    expect(res.state.statusCode, errorText(res)).toBe(200);
    const p = dataOf<Record<string, unknown>>(res);
    const loanCode = (await pool.query('SELECT account_code FROM gl_accounts WHERE id = $1', [acct.bLoan])).rows[0].account_code as string;
    expect(p).toMatchObject({ linked: true, billId: b.bill, linkId: b.link, loanAccountId: acct.bLoan, openAmount: 1150, maxAmount: 1150, receiverReady: true, blocked: null, floorDate: '2026-09-01' });
    expect(String(p.loanAccountLabel)).toContain(loanCode);
    expect(String(p.payableLabel)).toMatch(/IC AP/);
    expect(String(p.partnerName)).toMatch(/IC B supplier/);
    expect(typeof p.defaultPostingDate).toBe('string');
  });

  it('an unlinked bill is not linked (no action), and the receiver not ready is said before anything posts', async () => {
    const lone = await plantBill(pool, conn, { link: false });
    expect(dataOf<Record<string, unknown>>(await previewAs(U.b, co.B, lone.bill))).toMatchObject({ linked: false });
    const b = await plantBill(pool, conn);
    await pool.query("UPDATE customer_invoices SET status = 'paid' WHERE id = $1", [b.invoice]);
    const p = dataOf<Record<string, unknown>>(await previewAs(U.b, co.B, b.bill));
    expect(p).toMatchObject({ linked: true, receiverReady: false });
    expect(String(p.blocked)).toMatch(/partner/i);
  });
});

/**
 * Intercompany P4-D: the RECEIVER (A) clears B's allocation message through the real accept route. Exactly ONE balanced journal (DR A's loan
 * account / CR A's receivable control, = amount) and nothing else; the loan account and the invoice move by exactly the amount; the message is
 * accepted with the contra receipt (stamped IC:<message id>) as its target; creator == approver == the person; the author label is
 * system:ic_allocation_clear. A second accept (after, or at the same moment) posts nothing. Voiding the receipt afterwards leaves the message
 * accepted and flags the clearing voided; a new message for the same payment can then be cleared. A payer-side reversal after the accept
 * leaves the receiver as it is. The auto-accept worker never accepts an allocation.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { runAutoAccept } from '../../../src/modules/accounting/services/intercompany/autoAcceptWorker';
import { cancelCustomerPayment } from '../../../src/modules/accounting/services/ar/customerPaymentService';
import { acct, asAppUser, co, U, wipeConnections } from './intercompany.helpers';
import { asService, dataOf, mirrorCleanup, rawReverseJournal } from './mirror.helpers';
import { clearPayments } from './allocation.helpers';
import { allocationsApi } from './allocation-live.helpers';
import { lockWaiter } from './ledger.helpers';
import { accept, bodyFor, clearConnect, clearSetup, ledger, outcomeOf, reapply, sentClearable } from './allocation-clear.helpers';
import type { AllocationPage } from '../../../src/modules/accounting/services/intercompany/allocationInboxTypes';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let conn = '';

beforeAll(() => clearSetup(pool), 60000);
afterAll(async () => { await clearPayments(pool); await mirrorCleanup(pool); }, 60000);
beforeEach(async () => {
  await clearPayments(pool);
  await wipeConnections(pool);
  conn = await clearConnect(pool);
});

describe('accepting an allocation posts one contra settlement', () => {
  it('one journal of two legs (DR loan / CR receivable = amount), the loan and the invoice move by exactly the amount, the message accepted with the stamped receipt', async () => {
    const sent = await sentClearable(pool, conn);
    const [journals, receipts, loanBefore, openBefore, bJournals] = [await ledger.journals(pool), await ledger.receipts(pool), await ledger.balance(pool, acct.aLoan), await ledger.open(pool, sent.invoice), await ledger.journals(pool, co.B)];
    const res = await accept(sent.message, bodyFor(sent, { postingDate: '2026-09-10' }));
    expect(res.state.statusCode).toBe(200);
    const out = outcomeOf(res);
    expect(out).toMatchObject({ accepted: true, messageId: sent.message });
    expect(await ledger.journals(pool)).toBe(journals + 1);
    expect(await ledger.receipts(pool)).toBe(receipts + 1);
    expect(await ledger.journals(pool, co.B)).toBe(bJournals);
    expect(await ledger.balance(pool, acct.aLoan)).toBeCloseTo(loanBefore + 1150, 2);
    expect(await ledger.open(pool, sent.invoice)).toBeCloseTo(openBefore - 1150, 2);
    const ar = await ledger.ar(pool);
    expect(await ledger.lines(pool, out.journalEntryId!)).toEqual([
      { gl_account_id: acct.aLoan, debit: 1150, credit: 0, company_id: co.A },
      { gl_account_id: ar, debit: 0, credit: 1150, company_id: co.A },
    ]);
    const je = (await pool.query('SELECT status, entry_date::text AS d, posting_agent, created_by::text AS by FROM gl_journal_entries WHERE id = $1', [out.journalEntryId])).rows[0];
    expect(je).toMatchObject({ status: 'posted', d: '2026-09-10', posting_agent: 'system:ic_allocation_clear', by: U.a });
    const pay = (await pool.query('SELECT payment_method, status, bank_reference, bank_account_id, total_amount::float8 AS t, payment_date::text AS d, created_by::text AS c, confirmed_by::text AS k, gl_journal_entry_id FROM customer_payments WHERE id = $1', [out.paymentId])).rows[0];
    expect(pay).toMatchObject({ payment_method: 'contra', status: 'confirmed', bank_reference: `IC:${sent.message}`, bank_account_id: acct.aLoan, t: 1150, d: '2026-09-10', c: U.a, k: U.a, gl_journal_entry_id: out.journalEntryId });
    const alloc = (await pool.query('SELECT invoice_id, amount_allocated::float8 AS a FROM customer_payment_allocations WHERE payment_id = $1', [out.paymentId])).rows;
    expect(alloc).toEqual([{ invoice_id: sent.invoice, a: 1150 }]);
    expect(await ledger.message(pool, sent.message)).toMatchObject({ status: 'accepted', target_doc_type: 'customer_payment', target_doc_id: out.paymentId, error: null, handled_by: U.a, handled_via: 'user' });
    expect((await pool.query('SELECT status FROM customer_invoices WHERE id = $1', [sent.invoice])).rows[0].status).toBe('paid');
  });

  it('a part payment leaves the invoice partially paid, open by exactly the rest', async () => {
    const sent = await sentClearable(pool, conn, { amount: 400 });
    expect(outcomeOf(await accept(sent.message, bodyFor(sent)))).toMatchObject({ accepted: true });
    expect(await ledger.open(pool, sent.invoice)).toBeCloseTo(750, 2);
    expect((await pool.query('SELECT status FROM customer_invoices WHERE id = $1', [sent.invoice])).rows[0].status).toBe('partially_paid');
  });

  it('a second accept afterwards posts nothing (409, the message is final)', async () => {
    const sent = await sentClearable(pool, conn, { amount: 400 });
    expect(outcomeOf(await accept(sent.message, bodyFor(sent)))).toMatchObject({ accepted: true });
    const journals = await ledger.journals(pool);
    const again = await accept(sent.message, bodyFor(sent));
    expect(again.state.statusCode).toBe(409);
    expect(await ledger.journals(pool)).toBe(journals);
    expect(await ledger.open(pool, sent.invoice)).toBeCloseTo(750, 2);
  });

  it('two accepts at the same moment post once: the second waits on the message and then finds it accepted', async () => {
    const sent = await sentClearable(pool, conn, { amount: 400 });
    const journals = await ledger.journals(pool);
    // hold the message so both requests queue behind it, then let go
    const holder = await pool.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM intercompany_messages WHERE id = $1 FOR UPDATE', [sent.message]);
    const both = Promise.all([accept(sent.message, bodyFor(sent)), accept(sent.message, bodyFor(sent))]);
    expect(await lockWaiter(pool)).toBe(true);
    await holder.query('COMMIT');
    holder.release();
    const results = await both;
    const codes = results.map((r) => r.state.statusCode).sort();
    expect(codes).toEqual([200, 409]);
    expect(results.filter((r) => r.state.statusCode === 200).map((r) => outcomeOf(r).accepted)).toEqual([true]);
    expect(await ledger.journals(pool)).toBe(journals + 1);
    expect(await ledger.open(pool, sent.invoice)).toBeCloseTo(750, 2);
  });

  it('voiding the receipt afterwards reverses the journal once, leaves the message accepted and flags the clearing voided; a new message for the payment clears again', async () => {
    const sent = await sentClearable(pool, conn, { amount: 400 });
    const out = outcomeOf(await accept(sent.message, bodyFor(sent)));
    await asService(pool, U.a, co.A, () => cancelCustomerPayment(co.A, out.paymentId!, U.a, 'test void'));
    expect(await ledger.message(pool, sent.message)).toMatchObject({ status: 'accepted', target_doc_id: out.paymentId });
    expect(Number((await pool.query("SELECT count(*)::int AS n FROM gl_journal_entries WHERE reversal_of_id = $1 AND status = 'posted'", [out.journalEntryId])).rows[0].n)).toBe(1);
    expect(await ledger.open(pool, sent.invoice)).toBeCloseTo(1150, 2);
    const handled = dataOf<AllocationPage>(await allocationsApi.list(U.a, co.A, { filter: 'handled' }));
    expect(handled.items.find((i) => i.id === sent.message)?.clearedBy).toMatchObject({ paymentId: out.paymentId, voided: true });
    // the payer unapplies and re-applies: a new message; the voided clearing no longer counts against the payment
    await pool.query('DELETE FROM payment_allocations WHERE id = $1', [sent.allocation]);
    const again = await reapply(pool, sent.payment, sent.bill, 400);
    const second = outcomeOf(await accept(again.message, bodyFor(sent)));
    expect(second).toMatchObject({ accepted: true });
    expect(await ledger.open(pool, sent.invoice)).toBeCloseTo(750, 2);
  });

  it('an accepted clearing that stands is listed as not voided, with its receipt', async () => {
    const sent = await sentClearable(pool, conn, { amount: 400 });
    const out = outcomeOf(await accept(sent.message, bodyFor(sent)));
    const handled = dataOf<AllocationPage>(await allocationsApi.list(U.a, co.A, { filter: 'handled' }));
    expect(handled.items.find((i) => i.id === sent.message)?.clearedBy).toEqual({ paymentId: out.paymentId, paymentNumber: out.paymentNumber, journalEntryId: out.journalEntryId, voided: false });
  });

  it("the payer reversing its payment journal after the accept leaves the receiver's clearing as it is", async () => {
    const sent = await sentClearable(pool, conn, { amount: 400 });
    const out = outcomeOf(await accept(sent.message, bodyFor(sent)));
    await rawReverseJournal(pool, sent.journal!);
    expect(await ledger.message(pool, sent.message)).toMatchObject({ status: 'accepted', target_doc_id: out.paymentId });
    expect((await pool.query('SELECT status FROM gl_journal_entries WHERE id = $1', [out.journalEntryId])).rows[0].status).toBe('posted');
    expect(await ledger.open(pool, sent.invoice)).toBeCloseTo(750, 2);
  });

  it('the auto-accept worker never accepts an allocation, even with auto-accept on', async () => {
    const sent = await sentClearable(pool, conn);
    await asAppUser(pool, U.a, co.A, (q) => q.query('UPDATE intercompany_connection_sides SET auto_accept = true WHERE connection_id = $1 AND company_id = $2', [conn, co.A]), true);
    const journals = await ledger.journals(pool);
    expect(await runAutoAccept()).toMatchObject({ considered: 0 });
    expect(await ledger.message(pool, sent.message)).toMatchObject({ status: 'pending', target_doc_id: null });
    expect(await ledger.journals(pool)).toBe(journals);
  });
});

/**
 * Intercompany P4-D, fix round 2. A1: a loan account that holds bank-statement lines is real money, not a loan: refused on the payer side
 * (definer: cash_not_through_loan), the receiver side (service, guard), in the side form and its picker. A2: the clearing receipt's journal is
 * reversed only by the receipt's own cancel; a GL reversal of it, or of its reversal, is refused. A3: the cap lock is the receiver's only. A4:
 * a Login-as session cannot reject a payment. M1: the posting date floor is the later of the payment and the invoice dates. M2: the side form
 * validates the loan account only when it changes. M4: the inbox asks the light definer; accept and the guard the full one. L6: a malformed
 * payload is refused `malformed`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { impersonationToken } from '../r035-pr2.helpers';
import { callRoute } from '../r035-approval.helpers';
import rejectRoute from '../../../pages/api/accounting/intercompany/allocations/[id]/reject';
import { reverseJournalEntry } from '../../../src/modules/accounting/services/gl/journalEntryService';
import { settleDocumentByContra } from '../../../src/modules/accounting/services/core/contraSettlementPosting';
import { cancelCustomerPayment } from '../../../src/modules/accounting/services/ar/customerPaymentService';
import { CLEAR_REFUSAL_SENTENCES } from '../../../src/modules/accounting/services/intercompany/allocationClearRefusals';
import { acct, api, asAppUser, co, outcome, U, wipeConnections, withoutTrigger } from './intercompany.helpers';
import { asService, dataOf, mirrorCleanup } from './mirror.helpers';
import { bank, clearPayments } from './allocation.helpers';
import { allocationsApi } from './allocation-live.helpers';
import { accept, bodyFor, clearConnect, clearSetup, ledger, outcomeOf, previewFor, reapply, sentClearable } from './allocation-clear.helpers';
import type { SideOptions } from '../../../src/modules/accounting/services/intercompany/connectionTypes';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let conn = '';

const clearBankLines = () => pool.query('DELETE FROM bank_transactions WHERE company_id = ANY($1)', [[co.A, co.B, co.C]]);
beforeAll(() => clearSetup(pool), 60000);
afterAll(async () => { await clearBankLines(); await clearPayments(pool); await mirrorCleanup(pool); }, 60000);
beforeEach(async () => {
  await clearBankLines();
  await clearPayments(pool);
  await wipeConnections(pool);
  await pool.query("UPDATE gl_accounts SET account_type = 'asset', normal_balance = 'debit', account_subtype = 'other_current_asset' WHERE id = $1", [acct.aLoan]);
  await pool.query("UPDATE gl_accounts SET account_type = 'liability', normal_balance = 'credit', account_subtype = 'other_current_liability' WHERE id = $1", [acct.bLoan]);
  conn = await clearConnect(pool);
});

const bankLine = (company: string, account: string) => pool.query(
  "INSERT INTO bank_transactions(company_id, bank_account_id, transaction_date, amount, description) VALUES ($1, $2, DATE '2026-09-01', 10, 'IC money')", [company, account]);
const clearable = (m: string) => asAppUser(pool, U.a, co.A, async (q) => (await q.query(
  'SELECT live, reason, cap, payer_loan_type FROM public.intercompany_allocation_clearable($1)', [m])).rows[0]);
const failed = (code: keyof typeof CLEAR_REFUSAL_SENTENCES) => ({ accepted: false, status: 'failed', code, error: CLEAR_REFUSAL_SENTENCES[code] });
const REFUSED = /^23514: an allocation message is accepted with the clearing posted for it/;

describe('A1: an account holding bank-statement lines is money, not a loan', () => {
  it("the payer's: nothing counts as loan-funded (cash_not_through_loan), the clearing is refused", async () => {
    const sent = await sentClearable(pool, conn, { amount: 400 });
    await bankLine(co.B, acct.bLoan);
    expect(await clearable(sent.message)).toEqual({ live: true, reason: 'ok', cap: 'cash_not_through_loan', payer_loan_type: null });
    expect(outcomeOf(await accept(sent.message, bodyFor(sent)))).toMatchObject(failed('cash_not_through_loan'));
  });

  it("the receiver's: the service refuses it (loan_account_unusable) and the guard refuses the exact clearing", async () => {
    const sent = await sentClearable(pool, conn, { amount: 400 });
    await bankLine(co.A, acct.aLoan);
    expect(outcomeOf(await accept(sent.message, bodyFor(sent)))).toMatchObject(failed('loan_account_unusable'));
    await pool.query('DELETE FROM bank_transactions WHERE company_id = $1', [co.A]);
    const done = outcomeOf(await accept(sent.message, bodyFor(sent)));
    expect(done).toMatchObject({ accepted: true });
    // the guard: a second message's exact clearing, accepted directly once the loan account holds a bank line
    const two = await sentClearable(pool, conn, { amount: 300 });
    const posted = await asService(pool, U.a, co.A, () => settleDocumentByContra({
      companyId: co.A, subledger: 'ar', documentId: two.invoice, contraAccountId: acct.aLoan, amount: 300, date: '2026-09-01', reason: 'by hand',
      actor: { userId: U.a, approverUserId: U.a, postingAgent: 'mcp:settle_by_contra:v1' },
    }));
    await pool.query('UPDATE customer_payments SET bank_reference = $2 WHERE id = $1', [posted.paymentId, `IC:${two.message}`]);
    await bankLine(co.A, acct.aLoan);
    await asAppUser(pool, U.a, co.A, async (q) => {
      expect(await outcome(q, "UPDATE intercompany_messages SET status = 'accepted', target_doc_type = 'customer_payment', target_doc_id = $2 WHERE id = $1",
        [two.message, posted.paymentId])).toMatch(REFUSED);
    });
  });

  it('the side form refuses it, and its picker does not offer it (nor a bank account)', async () => {
    const money = crypto.randomUUID();
    await pool.query(
      `INSERT INTO gl_accounts(id, company_id, account_code, account_name, account_type, normal_balance, is_active, account_subtype)
       VALUES ($1, $2, $3, 'IC B money', 'liability', 'credit', true, 'other_current_liability')`, [money, co.B, `IMN${money.slice(0, 6)}`]);
    await bankLine(co.B, money);
    const res = await api.edit(U.b, co.B, conn, { loanAccountId: money });
    expect(res.state.statusCode).toBe(400);
    const options = dataOf<SideOptions>(await api.options(U.b, co.B));
    expect(options.loanAccounts.map((a) => a.id)).toContain(acct.bLoan);
    expect(options.loanAccounts.map((a) => a.id)).not.toContain(money);
    expect(options.loanAccounts.map((a) => a.id)).not.toContain(bank.b);
    expect(options.accounts.map((a) => a.id)).toContain(money);   // the expense picker is unchanged
  });
});

describe("A2: only the receipt's own cancel reverses a clearing", () => {
  it('a GL reversal of the clearing journal is refused; the cancel is not; a reversal of that reversal is refused, also after a re-clear', async () => {
    const sent = await sentClearable(pool, conn, { amount: 400 });
    const out = outcomeOf(await accept(sent.message, bodyFor(sent)));
    await expect(asService(pool, U.a, co.A, () => reverseJournalEntry(co.A, out.journalEntryId!, U.a))).rejects.toThrow(/clears an intercompany payment/);
    expect((await pool.query('SELECT count(*)::int AS n FROM gl_journal_entries WHERE reversal_of_id = $1', [out.journalEntryId])).rows[0].n).toBe(0);
    await asService(pool, U.a, co.A, () => cancelCustomerPayment(co.A, out.paymentId!, U.a, 'undo the clearing'));
    const reversal = (await pool.query("SELECT id FROM gl_journal_entries WHERE reversal_of_id = $1 AND status = 'posted'", [out.journalEntryId])).rows[0].id as string;
    // the payer unapplies and re-applies; the new message is cleared
    await pool.query('DELETE FROM payment_allocations WHERE id = $1', [sent.allocation]);
    const again = await reapply(pool, sent.payment, sent.bill, 400);
    expect(outcomeOf(await accept(again.message, bodyFor(sent)))).toMatchObject({ accepted: true });
    await expect(asService(pool, U.a, co.A, () => reverseJournalEntry(co.A, reversal, U.a))).rejects.toThrow(/clears an intercompany payment/);
    expect((await pool.query('SELECT count(*)::int AS n FROM gl_journal_entries WHERE reversal_of_id = $1', [reversal])).rows[0].n).toBe(0);
    expect(await ledger.open(pool, sent.invoice)).toBeCloseTo(750, 2);
  });
});

describe('A3, A4', () => {
  it("the cap lock takes nothing for the payer's session (the message is the receiver's), and three locks for the receiver's", async () => {
    const sent = await sentClearable(pool, conn, { amount: 400 });
    const held = (user: string, company: string) => asAppUser(pool, user, company, async (q) => {
      await q.query('SELECT public.intercompany_allocation_cap_lock($1)', [sent.message]);
      return Number((await q.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()")).rows[0].n);
    });
    expect(await held(U.b, co.B)).toBe(0);
    expect(await held(U.a, co.A)).toBe(3);
  });

  it('a Login-as session cannot reject a payment', async () => {
    const sent = await sentClearable(pool, conn, { amount: 400 });
    const token = await impersonationToken(pool, U.a, U.ab);
    const res = await callRoute(rejectRoute, token, co.A, 'POST', { reason: 'no' }, `/api/accounting/intercompany/allocations/${sent.message}/reject`, { id: sent.message });
    expect(res.state.statusCode).toBe(403);
    expect(JSON.stringify(res.state.body)).toMatch(/IMPERSONATION_FORBIDDEN/);
    expect(await ledger.message(pool, sent.message)).toMatchObject({ status: 'pending' });
  });
});

describe('M1, M2, M4, L6', () => {
  it('the preview carries the invoice date and proposes the later of it and the payment date', async () => {
    const sent = await sentClearable(pool, conn, { amount: 400 });
    await pool.query("UPDATE customer_invoices SET invoice_date = DATE '2026-09-05' WHERE id = $1", [sent.invoice]);
    expect((await previewFor(sent.message)).preview).toMatchObject({ paymentDate: '2026-09-01', invoiceDate: '2026-09-05', defaultPostingDate: '2026-09-05' });
  });

  it('a legacy side whose loan account is no loan class still saves another field, and keeps it; changing it to one is refused', async () => {
    await withoutTrigger(pool, 'intercompany_connection_sides', 'trg_intercompany_sides_guard', (q) => q.query(
      'UPDATE intercompany_connection_sides SET loan_account_id = $3 WHERE connection_id = $1 AND company_id = $2', [conn, co.A, acct.aExpense]));
    expect((await api.edit(U.a, co.A, conn, { autoAccept: false })).state.statusCode).toBe(200);
    expect((await api.edit(U.a, co.A, conn, { loanAccountId: acct.aExpense })).state.statusCode).toBe(200);
    expect((await api.edit(U.a, co.A, conn, { loanAccountId: acct.aInactive })).state.statusCode).toBe(400);
  });

  it('the light definer answers (live, reason, clearing_voided) for the inbox; the full one the caps; both registered; the payer scan has its index', async () => {
    const rows = (await pool.query(`
      SELECT p.proname, pg_get_function_result(p.oid) AS result, p.prosecdef,
             (SELECT count(*)::int FROM app_definer_reviews r WHERE r.signature = p.oid::regprocedure::text AND r.body_md5 = app_definer_hash(p.oid)) AS reviewed
        FROM pg_proc p WHERE p.proname IN ('intercompany_allocation_message_live', 'intercompany_allocation_clearable') ORDER BY p.proname`)).rows;
    expect(rows).toEqual([
      { proname: 'intercompany_allocation_clearable', result: 'TABLE(live boolean, reason text, cap text, payer_loan_type text)', prosecdef: true, reviewed: 1 },
      { proname: 'intercompany_allocation_message_live', result: 'TABLE(live boolean, reason text, clearing_voided boolean)', prosecdef: true, reviewed: 1 },
    ]);
    expect((await pool.query("SELECT 1 FROM pg_indexes WHERE indexname = 'intercompany_messages_allocation_accepted_by_payer'")).rows).toHaveLength(1);
    const sent = await sentClearable(pool, conn, { amount: 400 });
    const out = outcomeOf(await accept(sent.message, bodyFor(sent)));
    const voided = () => asAppUser(pool, U.a, co.A, async (q) => (await q.query('SELECT clearing_voided FROM public.intercompany_allocation_message_live($1)', [sent.message])).rows[0].clearing_voided);
    expect(await voided()).toBe(false);
    await asService(pool, U.a, co.A, () => cancelCustomerPayment(co.A, out.paymentId!, U.a, 'undo'));
    expect(await voided()).toBe(true);
    const handled = dataOf<{ items: Array<{ id: string; clearedBy: { voided: boolean } | null }> }>(await allocationsApi.list(U.a, co.A, { filter: 'handled' }));
    expect(handled.items.find((i) => i.id === sent.message)?.clearedBy?.voided).toBe(true);
  });

  it('a malformed payload is refused `malformed`, nothing posted', async () => {
    const sent = await sentClearable(pool, conn, { amount: 400 });
    await withoutTrigger(pool, 'intercompany_messages', 'trg_intercompany_messages_guard', (q) => q.query(
      "UPDATE intercompany_messages SET payload = payload - 'amount' WHERE id = $1", [sent.message]));
    const journals = await ledger.journals(pool);
    expect(outcomeOf(await accept(sent.message, bodyFor(sent)))).toMatchObject(failed('malformed'));
    expect(await ledger.journals(pool)).toBe(journals);
  });
});

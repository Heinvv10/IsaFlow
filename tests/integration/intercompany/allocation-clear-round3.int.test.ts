/**
 * Intercompany P4-D, fix round 3. A: an account registered as a bank account (bank_accounts.gl_account_id) or named by a bank feed, a statement
 * import, a reconciliation, an import batch or a transfer-link log is money, not a loan, even with no statement line yet. C: a payer whose loan
 * account is not set up for clearing has its own refusal. F: every other way to undo a clearing receipt's journal is refused: a reversal of a
 * non-root entry naming the receipt, the receipt void (void_receipt's service), the GL reversal route, the MCP reverse tool (dry run and real
 * call alike), a delete. G: a guard refusal of the accept after the posting rolls the posting back and is stored as `refused`. H: the
 * receipt's cancel names it however the id is spelt.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { callRoute } from '../r035-approval.helpers';
import journalActionRoute from '../../../pages/api/accounting/journal-entries-action';
import { reverseJournalEntry } from '../../../src/modules/accounting/services/gl/journalEntryService';
import { cancelCustomerPayment } from '../../../src/modules/accounting/services/ar/customerPaymentService';
import { voidPaymentDocument } from '../../../src/modules/accounting/services/core/paymentVoidService';
import { reverseJournalEntryTool } from '../../../src/lib/mcp/tools/writeJournalReverse';
import { CLEAR_REFUSAL_SENTENCES } from '../../../src/modules/accounting/services/intercompany/allocationClearRefusals';
import type { McpToolContext } from '../../../src/lib/mcp/types';
import { acct, api, asAppUser, co, outcome, tokens, U, wipeConnections } from './intercompany.helpers';
import { asService, mirrorCleanup } from './mirror.helpers';
import { bank, clearPayments } from './allocation.helpers';
import { accept, bodyFor, clearConnect, clearSetup, ledger, outcomeOf, sentClearable } from './allocation-clear.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let conn = '';
const MIGRATION_1027 = readFileSync(resolve(__dirname, '../../../scripts/migrations/sql/1027_intercompany_p4d_allocation_clearing.sql'), 'utf8');
// 1031 (intercompany F) redefines the messages guard, the message-document check, the allocation sender, the cap lock and the target index:
// replayed last, so the committed replay leaves the newest bodies
const MIGRATION_1031 = readFileSync(resolve(__dirname, '../../../scripts/migrations/sql/1031_intercompany_p6f_payment_messages.sql'), 'utf8');

const clearBankRows = async () => {
  for (const t of ['bank_transactions', 'bank_feed_connections', 'bank_accounts']) await pool.query(`DELETE FROM ${t} WHERE company_id = ANY($1)`, [[co.A, co.B, co.C]]);
};
beforeAll(() => clearSetup(pool), 60000);
afterAll(async () => { await clearBankRows(); await clearPayments(pool); await mirrorCleanup(pool); }, 60000);
beforeEach(async () => {
  await clearBankRows();
  await clearPayments(pool);
  await wipeConnections(pool);
  await pool.query("UPDATE gl_accounts SET account_type = 'asset', normal_balance = 'debit', account_subtype = 'other_current_asset' WHERE id = $1", [acct.aLoan]);
  await pool.query("UPDATE gl_accounts SET account_type = 'liability', normal_balance = 'credit', account_subtype = 'other_current_liability' WHERE id = $1", [acct.bLoan]);
  conn = await clearConnect(pool);
});

const registerBank = (company: string, account: string) => pool.query(
  "INSERT INTO bank_accounts(company_id, account_name, gl_account_id) VALUES ($1, 'IC registered bank', $2)", [company, account]);
const isLoanClass = async (account: string, company: string) => (await pool.query('SELECT public.intercompany_is_loan_class($1, $2) AS ok', [account, company])).rows[0].ok as boolean;
const failed = (code: keyof typeof CLEAR_REFUSAL_SENTENCES) => ({ accepted: false, status: 'failed', code, error: CLEAR_REFUSAL_SENTENCES[code] });
const mcp = { companyId: '', userId: '', companyRole: 'owner', tokenJti: 'jti-p4d-r3', scopes: [] } as unknown as McpToolContext;
const accepted = async (amount = 400) => {
  const sent = await sentClearable(pool, conn, { amount });
  return { sent, out: outcomeOf(await accept(sent.message, bodyFor(sent))) };
};

describe('A: an account any bank table names is money, not a loan', () => {
  it('registered in bank_accounts (no statement line): refused by the class, the service, the side form and its picker', async () => {
    await registerBank(co.A, acct.aLoan);
    expect(await isLoanClass(acct.aLoan, co.A)).toBe(false);
    const sent = await sentClearable(pool, conn, { amount: 400 });
    expect(outcomeOf(await accept(sent.message, bodyFor(sent)))).toMatchObject(failed('loan_account_unusable'));
    const money = crypto.randomUUID();
    await pool.query(
      `INSERT INTO gl_accounts(id, company_id, account_code, account_name, account_type, normal_balance, is_active, account_subtype)
       VALUES ($1, $2, $3, 'IC B registered', 'liability', 'credit', true, 'other_current_liability')`, [money, co.B, `IRB${money.slice(0, 6)}`]);
    await registerBank(co.B, money);
    expect((await api.edit(U.b, co.B, conn, { loanAccountId: money })).state.statusCode).toBe(400);
    expect(((await api.options(U.b, co.B)).state.body as { data: { loanAccounts: Array<{ id: string }> } }).data.loanAccounts.map((a) => a.id)).not.toContain(money);
  });

  it('named by a bank feed connection: no loan class', async () => {
    await pool.query("INSERT INTO bank_feed_connections(bank_account_id, company_id) VALUES ($1, $2)", [acct.bLoan, co.B]);
    expect(await isLoanClass(acct.bLoan, co.B)).toBe(false);
  });
});

describe('C: the payer side not set up for clearing', () => {
  it("the payer's loan account is no loan class: its own refusal, not cash_not_through_loan", async () => {
    const sent = await sentClearable(pool, conn, { amount: 400 });
    await registerBank(co.B, acct.bLoan);
    const cap = await asAppUser(pool, U.a, co.A, async (q) => (await q.query('SELECT cap, payer_loan_type FROM public.intercompany_allocation_clearable($1)', [sent.message])).rows[0]);
    expect(cap).toEqual({ cap: 'payer_loan_unset', payer_loan_type: null });
    expect(outcomeOf(await accept(sent.message, bodyFor(sent)))).toMatchObject(failed('payer_loan_not_set_up'));
    expect(CLEAR_REFUSAL_SENTENCES.payer_loan_not_set_up).toBe("The payer's loan account is not set up for clearing: ask them to fix their intercompany connection. Nothing was posted.");
  });

  it('the payer through its bank (its loan account fine) is still cash_not_through_loan', async () => {
    const sent = await sentClearable(pool, conn, { leg: bank.b, amount: 400 });
    expect(outcomeOf(await accept(sent.message, bodyFor(sent)))).toMatchObject(failed('cash_not_through_loan'));
  });
});

describe("F: only the receipt's cancel undoes a clearing", () => {
  it('a non-root entry of the chain naming the receipt as its cancel is refused', async () => {
    const { out } = await accepted();
    await asService(pool, U.a, co.A, () => cancelCustomerPayment(co.A, out.paymentId!, U.a, 'undo'));
    const reversal = (await pool.query('SELECT id FROM gl_journal_entries WHERE reversal_of_id = $1', [out.journalEntryId])).rows[0].id as string;
    await expect(asService(pool, U.a, co.A, () => reverseJournalEntry(co.A, reversal, U.a, { voidingReceiptId: out.paymentId! })))
      .rejects.toThrow(/clears an intercompany payment/);
  });

  it('the receipt void (void_receipt) is refused: the receipt stays confirmed, the invoice unchanged', async () => {
    const { sent, out } = await accepted();
    const open = await ledger.open(pool, sent.invoice);
    await expect(asService(pool, U.a, co.A, () => voidPaymentDocument(co.A, 'customer', out.paymentId!, U.a))).rejects.toThrow(/clears an intercompany payment/);
    expect((await pool.query('SELECT status FROM customer_payments WHERE id = $1', [out.paymentId])).rows[0].status).toBe('confirmed');
    expect(await ledger.open(pool, sent.invoice)).toBeCloseTo(open, 2);
  });

  it('the GL reversal route answers the refusal; a delete of the journal is refused; nothing moved', async () => {
    const { out } = await accepted();
    const res = await callRoute(journalActionRoute, tokens[U.a]!, co.A, 'POST', { action: 'reverse', id: out.journalEntryId }, '/api/accounting/journal-entries-action');
    expect(res.state.statusCode).toBe(400);
    expect(JSON.stringify(res.state.body)).toMatch(/clears an intercompany payment/);
    await asAppUser(pool, U.a, co.A, async (q) => { expect(await outcome(q, 'DELETE FROM gl_journal_entries WHERE id = $1', [out.journalEntryId])).not.toBe('ok'); });
    expect((await pool.query('SELECT count(*)::int AS n FROM gl_journal_entries WHERE reversal_of_id = $1', [out.journalEntryId])).rows[0].n).toBe(0);
  });

  it('the MCP reverse tool refuses the same way in its dry run and its real call', async () => {
    const { out } = await accepted();
    Object.assign(mcp, { companyId: co.A, userId: U.a });
    const said: string[] = [];
    for (const dryRun of [true, false]) {
      const answer = await asService(pool, U.a, co.A, () => reverseJournalEntryTool.handler(
        { journal_entry_id: out.journalEntryId, dry_run: dryRun, idempotency_key: `p4d-r3-${dryRun}-${out.journalEntryId}` }, mcp)).catch((err: unknown) => ({ isError: true, thrown: String(err) }));
      expect((answer as { isError?: boolean }).isError, `dry_run=${dryRun}`).toBe(true);
      said.push(JSON.stringify(answer).match(/Journal entry [^"\\]* clears an intercompany payment[^"\\]*/)?.[0] ?? 'no refusal');
    }
    expect(said[0]).not.toBe('no refusal');
    expect(said[1]).toBe(said[0]);
    expect((await pool.query('SELECT count(*)::int AS n FROM gl_journal_entries WHERE reversal_of_id = $1', [out.journalEntryId])).rows[0].n).toBe(0);
  });
});

describe('G, H', () => {
  it('the guard refusing the accept after the posting: everything rolls back and the message is failed `refused`, not a 500', async () => {
    const sent = await sentClearable(pool, conn, { amount: 400 });
    const journals = await ledger.journals(pool);
    try {
      await pool.query(`CREATE OR REPLACE FUNCTION public.intercompany_allocation_target_ok(
                          p_message uuid, p_payload jsonb, p_connection uuid, p_receiver uuid, p_type text, p_target uuid) RETURNS boolean
                        LANGUAGE sql STABLE AS $$ SELECT false $$`);
      const res = await accept(sent.message, bodyFor(sent));
      expect(res.state.statusCode).toBe(200);
      expect(outcomeOf(res)).toMatchObject(failed('refused'));
      expect(await ledger.journals(pool)).toBe(journals);
      expect(await ledger.message(pool, sent.message)).toMatchObject({ status: 'failed', target_doc_id: null });
    } finally {
      await pool.query(MIGRATION_1027);
      await pool.query(MIGRATION_1031);
    }
  });

  it("the receipt's cancel names it whatever the id's case or braces: the clearing is voided, not refused", async () => {
    const { out } = await accepted();
    const spelt = `{${out.paymentId!.toUpperCase()}}`;
    await asService(pool, U.a, co.A, () => cancelCustomerPayment(co.A, spelt, U.a, 'undo'));
    expect((await pool.query('SELECT status FROM customer_payments WHERE id = $1', [out.paymentId])).rows[0].status).toBe('cancelled');
  });
});

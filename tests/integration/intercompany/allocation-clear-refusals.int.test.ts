/**
 * Intercompany P4-D: every refusal of the clearing is stored as `failed` with its fixed sentence (never `rejected`: only a person's Reject is
 * final), answered 200 `accepted: false`, and posts NOTHING (no journal, no receipt, the invoice unchanged). Decided under the locks, before any
 * write: a stale message (the payer unapplied / voided, a cash or revoked connection), the loan account (none, inactive, not a loan class), the
 * invoice (gone, not open, another customer, not rand, before the pair's cut-over), the open amount (a bank receipt first, a draft receipt
 * pending), the payer's cash leg (not, or not all, through its loan account), the posting date's period (closed, locked, none, a VAT lock) and a
 * held invoice (busy). A failed message can be accepted once the cause is fixed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { CLEAR_REFUSAL_SENTENCES } from '../../../src/modules/accounting/services/intercompany/allocationClearRefusals';
import { acct, api, asAppUser, co, party, U, wipeConnections, withoutTrigger } from './intercompany.helpers';
import { mirrorCleanup } from './mirror.helpers';
import { enableFxDocuments } from '../r035-approval.helpers';
import { bank, clearPayments } from './allocation.helpers';
import { accept, backdateMirroring, bodyFor, clearConnect, clearSetup, ledger, outcomeOf, plantSplitJournal, sentClearable } from './allocation-clear.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let conn = '';

beforeAll(() => clearSetup(pool), 60000);
afterAll(async () => { await clearPayments(pool); await mirrorCleanup(pool); }, 60000);
beforeEach(async () => {
  await clearPayments(pool);
  await wipeConnections(pool);
  await pool.query("UPDATE fiscal_periods SET status = 'open' WHERE company_id = $1", [co.A]);
  await pool.query("UPDATE fiscal_periods SET start_date = '2026-01-01', end_date = '2026-12-31' WHERE company_id = $1", [co.A]);
  await pool.query('DELETE FROM vat_period_locks WHERE company_id = $1', [co.A]);
  await pool.query("UPDATE gl_accounts SET is_active = true, account_type = 'asset', account_subtype = 'other_current_asset' WHERE id = $1", [acct.aLoan]);
  conn = await clearConnect(pool);
});

type Sent = Awaited<ReturnType<typeof sentClearable>>;

/** Accept, and prove it was refused with `code`, stored as failed with its sentence, and posted nothing. */
async function refused(sent: Sent, code: keyof typeof CLEAR_REFUSAL_SENTENCES, body = bodyFor(sent)) {
  const [journals, receipts, open] = [await ledger.journals(pool), await ledger.receipts(pool), await ledger.open(pool, sent.invoice)];
  const res = await accept(sent.message, body);
  expect(res.state.statusCode).toBe(200);
  expect(outcomeOf(res)).toEqual({ accepted: false, messageId: sent.message, status: 'failed', code, error: CLEAR_REFUSAL_SENTENCES[code] });
  expect(await ledger.message(pool, sent.message)).toMatchObject({ status: 'failed', error: CLEAR_REFUSAL_SENTENCES[code], reason: null, target_doc_id: null });
  expect([await ledger.journals(pool), await ledger.receipts(pool), await ledger.open(pool, sent.invoice)]).toEqual([journals, receipts, open]);
}

describe('a refused clearing is failed with its sentence and posts nothing', () => {
  it('stale: the payer unapplied, the payer voided the payment', async () => {
    const unapplied = await sentClearable(pool, conn);
    await pool.query('DELETE FROM payment_allocations WHERE id = $1', [unapplied.allocation]);
    await refused(unapplied, 'not_live');
    const voided = await sentClearable(pool, conn);
    await pool.query("UPDATE supplier_payments SET status = 'cancelled' WHERE id = $1", [voided.payment]);
    await refused(voided, 'not_live');
  });

  it('the connection settles in cash, or is revoked', async () => {
    const cash = await sentClearable(pool, conn);
    await asAppUser(pool, U.ab, co.A, (q) => q.query("UPDATE intercompany_connections SET settlement_mode = 'cash' WHERE id = $1", [conn]), true);
    await refused(cash, 'not_live');
    await asAppUser(pool, U.ab, co.A, (q) => q.query("UPDATE intercompany_connections SET settlement_mode = 'loan' WHERE id = $1", [conn]), true);
    const revoked = await sentClearable(pool, conn);
    expect((await api.revoke(U.a, co.A, conn)).state.statusCode).toBe(200);
    await refused(revoked, 'not_live');
  });

  it('the loan account: none on the side, deactivated, a bank, a header', async () => {
    const sent = await sentClearable(pool, conn);
    await asAppUser(pool, U.a, co.A, (q) => q.query('UPDATE intercompany_connection_sides SET loan_account_id = NULL WHERE connection_id = $1 AND company_id = $2', [conn, co.A]), true);
    await refused(sent, 'no_loan_account');
    await asAppUser(pool, U.a, co.A, (q) => q.query('UPDATE intercompany_connection_sides SET loan_account_id = $3 WHERE connection_id = $1 AND company_id = $2', [conn, co.A, acct.aLoan]), true);
    await pool.query('UPDATE gl_accounts SET is_active = false WHERE id = $1', [acct.aLoan]);
    await refused(sent, 'loan_account_unusable');
    await pool.query("UPDATE gl_accounts SET is_active = true, account_subtype = 'bank' WHERE id = $1", [acct.aLoan]);
    await refused(sent, 'loan_account_unusable');
    await pool.query("UPDATE gl_accounts SET account_type = 'equity', account_subtype = 'equity' WHERE id = $1", [acct.aLoan]);
    await refused(sent, 'loan_account_unusable');
    await pool.query("UPDATE gl_accounts SET account_type = 'asset', account_subtype = 'other_current_asset' WHERE id = $1", [acct.aLoan]);
    await pool.query('UPDATE gl_accounts SET parent_account_id = $1 WHERE id = $2', [acct.aLoan, acct.aChild]);
    try {
      await refused(sent, 'loan_account_unusable');
    } finally {
      await pool.query('UPDATE gl_accounts SET parent_account_id = $1 WHERE id = $2', [acct.aHeader, acct.aChild]);
    }
  });

  it('the invoice: deleted, not open, on another customer, not in rand', async () => {
    const gone = await sentClearable(pool, conn);
    await pool.query('UPDATE customer_invoices SET deleted_at = now() WHERE id = $1', [gone.invoice]);
    await refused(gone, 'invoice_gone');
    const draft = await sentClearable(pool, conn);
    await withoutTrigger(pool, 'customer_invoices', 'trg_doc_journal_link_upd', (q) => q.query("UPDATE customer_invoices SET status = 'pending_approval' WHERE id = $1", [draft.invoice]));
    await refused(draft, 'invoice_not_open');
    const other = await sentClearable(pool, conn);
    const stranger = crypto.randomUUID();
    await pool.query("INSERT INTO customers(id, company_id, name) VALUES ($1, $2, 'IC stranger')", [stranger, co.A]);
    await pool.query('UPDATE customer_invoices SET client_id = $2, customer_id = $2 WHERE id = $1', [other.invoice, stranger]);
    await refused(other, 'wrong_customer');
    const usd = await sentClearable(pool, conn);
    await enableFxDocuments(pool, co.A);
    await pool.query("UPDATE customer_invoices SET currency_code = 'USD' WHERE id = $1", [usd.invoice]);
    await refused(usd, 'currency');
  });

  it("the pair's cut-over: the invoice before it, the payment before it, a side that does not mirror (no pair cut-over)", async () => {
    const early = await sentClearable(pool, conn);
    await pool.query("UPDATE customer_invoices SET invoice_date = DATE '2025-12-15' WHERE id = $1", [early.invoice]);
    await refused(early, 'pre_cutover_invoice');
    // the per-pair rule: the sides mirror only from 2026-09-02, later than the connection's 2026-01-01
    const late = await sentClearable(pool, conn);
    await backdateMirroring(pool, conn, '2026-09-02');
    await refused(late, 'pre_cutover_invoice');
    await pool.query("UPDATE customer_invoices SET invoice_date = DATE '2026-09-05' WHERE id = $1", [late.invoice]);
    await refused(late, 'pre_cutover_payment', bodyFor(late, { postingDate: '2026-09-05' }));
    await backdateMirroring(pool, conn);
    const unmirrored = await sentClearable(pool, conn);
    await asAppUser(pool, U.a, co.A, (q) => q.query('UPDATE intercompany_connection_sides SET supplier_id = NULL WHERE connection_id = $1 AND company_id = $2', [conn, co.A]), true);
    await refused(unmirrored, 'pre_cutover_invoice');
  });

  it('the open amount: a bank receipt cleared part of the invoice first; a draft receipt is pending on it', async () => {
    const bankFirst = await sentClearable(pool, conn);
    await pool.query("UPDATE customer_invoices SET amount_paid = 500, status = 'partially_paid' WHERE id = $1", [bankFirst.invoice]);
    await refused(bankFirst, 'exceeds_open');
    const pending = await sentClearable(pool, conn);
    const draft = (await pool.query(
      `INSERT INTO customer_payments(company_id, client_id, payment_date, total_amount, payment_method, status, created_by)
       VALUES ($1, $2, DATE '2026-09-01', 1, 'eft', 'draft', $3) RETURNING id`, [co.A, party.aCustomer, U.a])).rows[0].id as string;
    await pool.query('INSERT INTO customer_payment_allocations(payment_id, invoice_id, amount_allocated) VALUES ($1, $2, 1)', [draft, pending.invoice]);
    await refused(pending, 'exceeds_open');
  });

  it("the payer's cash leg: through its bank (nothing on the loan account), or split (part on the loan account)", async () => {
    const viaBank = await sentClearable(pool, conn, { leg: bank.b });
    await refused(viaBank, 'cash_not_through_loan');
    const split = await sentClearable(pool, conn, { journal: await plantSplitJournal(pool, 1150, 500, bank.b) });
    await refused(split, 'cash_not_through_loan');
  });

  it('the posting date: a closed period, a locked period, no period, a locked VAT period', async () => {
    const sent = await sentClearable(pool, conn);
    await pool.query("UPDATE fiscal_periods SET end_date = '2026-09-01' WHERE company_id = $1", [co.A]);
    await refused(sent, 'no_period', bodyFor(sent, { postingDate: '2026-09-02' }));
    await pool.query("UPDATE fiscal_periods SET end_date = '2026-12-31' WHERE company_id = $1", [co.A]);
    await pool.query(
      `INSERT INTO vat_period_locks(company_id, period_start, period_end, output_tax, input_tax, net_vat, posted_through, locked_by, actor_type)
       VALUES ($1, DATE '2026-09-01', DATE '2026-10-31', 0, 0, 0, now(), $2, 'human')`, [co.A, U.a]);
    await refused(sent, 'vat_locked');
    await pool.query('DELETE FROM vat_period_locks WHERE company_id = $1', [co.A]);
    for (const status of ['closed', 'locked']) {
      await pool.query('UPDATE fiscal_periods SET status = $2 WHERE company_id = $1', [co.A, status]);
      await refused(sent, 'period_locked');
    }
  });

  it('a held invoice (another receipt on it right now) is busy', async () => {
    const sent = await sentClearable(pool, conn);
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM customer_invoices WHERE id = $1 FOR UPDATE', [sent.invoice]);
      await refused(sent, 'busy');
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  }, 30000);

  it('a failed message is cleared once the cause is fixed: accepted, the old sentence gone', async () => {
    const sent = await sentClearable(pool, conn);
    await pool.query("UPDATE fiscal_periods SET status = 'closed' WHERE company_id = $1", [co.A]);
    await refused(sent, 'period_locked');
    await pool.query("UPDATE fiscal_periods SET status = 'open' WHERE company_id = $1", [co.A]);
    expect(outcomeOf(await accept(sent.message, bodyFor(sent)))).toMatchObject({ accepted: true });
    expect(await ledger.message(pool, sent.message)).toMatchObject({ status: 'accepted', error: null });
  });
});

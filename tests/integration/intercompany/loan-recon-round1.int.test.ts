/**
 * Intercompany P5, review round 1. The partner-consent gate b0 reads the loan class the way P4-D does (1027's intercompany_is_loan_class): a
 * partner loan account that is a bank account (a legacy side, or one that a statement line has since landed on) is `partner_setup`, never a
 * balance shown to S; S's own such account is `loan_unset`, and S's own facts treat it as no loan account (MED-2). With the partner withheld
 * b3 reads none of the partner's journal lines (no timing side channel). An accepted message that was never loan-paid is `not_through_loan`,
 * not `loan_account_changed` ((l).4 row (F, F)). A clearing receipt whose loan debit differs from its message is flagged
 * (`receiver_journal_differs`). `unsent` lists nothing on a cash connection (the sender never sends there: 1025 `not_loan`). A pair in two
 * groups has one deterministic cut-over.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { acct, asAppUser, co, party, U, wipeConnections } from './intercompany.helpers';
import { mirrorCleanup } from './mirror.helpers';
import { clearPayments } from './allocation.helpers';
import { setLoanClearing } from './loan-clearing.helpers';
import {
  accepted, ePay, errorText, fixturePaid, forgeConnection, forgeMessage, forgeSide, itemOf, opening, pair, plantJournal, rawMessages, rawSummary,
  reconConnect, reconSetup, reportAs, reportOf, rowsAs,
} from './loan-recon.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let conn = '';

beforeAll(() => reconSetup(pool), 90000);
afterAll(async () => {
  // the statement lines name the loan accounts (FK): gone first, so the fixture's cleanup can delete the accounts
  await pool.query("DELETE FROM bank_transactions WHERE description = 'P5 r1 statement line'");
  await clearPayments(pool);
  await mirrorCleanup(pool);
}, 60000);
beforeEach(async () => {
  await setLoanClearing(pool, [co.A, co.B], true);
  await clearPayments(pool);
  await wipeConnections(pool);
  await pool.query('UPDATE supplier_invoices SET deleted_at = now() WHERE company_id = $1 AND deleted_at IS NULL', [co.B]);
  conn = await reconConnect(pool);
});

/** A bank-statement line on `account` of `company`: the account is a bank account from now on (1027's loan-class test). */
const statementLine = (company: string, account: string) => pool.query(
  "INSERT INTO bank_transactions(company_id, bank_account_id, transaction_date, amount, description) VALUES ($1, $2, DATE '2026-10-01', 1, 'P5 r1 statement line')",
  [company, account]);

describe('HIGH-1: b0 reads the loan class (1027 intercompany_is_loan_class)', () => {
  it("a partner side naming a BANK-subtype account: partner_setup, its balance never shown (the R987 654.32 repro)", async () => {
    const bankAcct = crypto.randomUUID();
    await pool.query(
      `INSERT INTO gl_accounts(id, company_id, account_code, account_name, account_type, normal_balance, is_active, account_subtype)
       VALUES ($1, $2, $3, 'P5 r1 A main bank', 'asset', 'debit', true, 'bank')`, [bankAcct, co.A, `RBK${bankAcct.slice(0, 8)}`]);
    await forgeSide(pool, conn, co.A, 'loan_account_id = $3', [bankAcct]);
    await plantJournal(pool, co.A, '2026-10-01', [[bankAcct, 987654.32, 0], [acct.aExpense, 0, 987654.32]], 'P5 r1 A cash sale');
    const r = reportOf(await reportAs(U.b, co.B, conn));
    expect(r.summary).toMatchObject({ partnerState: 'partner_setup', partner: null, difference: null, reconciles: null });
    expect(JSON.stringify(r)).not.toContain('987654');
    expect((await rawSummary(pool, U.b, co.B, conn))[0]).toMatchObject({ partner_state: 'partner_setup', partner_balance: null, partner_other: null });
  });

  it("the partner's loan account became a bank account after it was set (a statement line landed): partner_setup", async () => {
    await opening(pool, 1000, 1000);
    expect(reportOf(await reportAs(U.b, co.B, conn)).summary.partnerState).toBe('ok');
    await statementLine(co.A, acct.aLoan);
    const r = reportOf(await reportAs(U.b, co.B, conn));
    expect(r.summary).toMatchObject({ partnerState: 'partner_setup', partner: null });
    expect((await rawSummary(pool, U.b, co.B, conn))[0]).toMatchObject({ partner_state: 'partner_setup', partner_balance: null });
  });

  it("S's own loan account became a bank account: loan_unset; S's own facts count it as no loan account (MED-2)", async () => {
    const m = await ePay(pool, conn, 400);
    await statementLine(co.B, acct.bLoan);
    const r = reportOf(await reportAs(U.b, co.B, conn));
    expect(r.summary).toMatchObject({ partnerState: 'loan_unset', own: null, partner: null });
    const row = (await rawMessages(pool, U.b, co.B, conn)).find((x) => x.message_id === m.message)!;
    // B's own journal credited what is now a bank account: no loan credit, and the loan-paid payload no longer has its loan line
    expect(row).toMatchObject({ payer_state: 'standing', payer_loan_credit: false, payer_counts: true, loan_account_changed: true });
  });
});

describe('LOW-timing: with the partner withheld b3 reads none of its journal lines', () => {
  it("from A's session, B's flag off, B's pending messages: no gl_journal_lines scan at all", async () => {
    await ePay(pool, conn, 300);
    await ePay(pool, conn, 200);
    await setLoanClearing(pool, [co.B], false);
    // the backend's pending (unflushed) counts can carry earlier transactions of this pooled connection: the delta inside one transaction
    const count = async (q: { query: (t: string) => Promise<{ rows: { n: number }[] }> }) => Number((await q.query(
      "SELECT COALESCE(sum(COALESCE(seq_scan, 0) + COALESCE(idx_scan, 0)), 0)::int AS n FROM pg_stat_xact_user_tables WHERE relname = 'gl_journal_lines'")).rows[0]!.n);
    const scans = await asAppUser(pool, U.a, co.A, async (q) => {
      const before = await count(q);
      const rows = (await q.query('SELECT * FROM public.intercompany_loan_recon_messages($1)', [conn])).rows;
      expect(rows).toHaveLength(2);
      expect(rows.every((x) => x.payer_state === null && x.payer_loan_credit === null)).toBe(true);
      return (await count(q)) - before;
    });
    expect(scans).toBe(0);
  });
});

describe('(g): an accepted message never loan-paid', () => {
  it('bank-paid, accepted by a forged state with no receipt: not_through_loan ((l).4 row (F, F)), not loan_account_changed', async () => {
    const m = await fixturePaid(pool, conn, 260);
    await forgeMessage(pool, m.message, "status = 'accepted', target_doc_type = 'customer_payment', target_doc_id = $2, handled_at = now()", [crypto.randomUUID()]);
    const r = await rowsAs(pool, U.b, co.B, conn);
    expect(r.summary.identityFailures).toBe(0);
    expect(itemOf(r, m.message)).toMatchObject({ bucket: 'not_through_loan', payerState: 'standing', receiverState: 'target_missing', contribution: 0 });
    expect(r.summary.loanAccountChanged).toBe(false);
  });
});

describe('LOW-5: receiver_journal_differs', () => {
  it("a clearing receipt debiting the loan account more than its message: flagged, an amount mismatch, no Reconciles", async () => {
    const m = await fixturePaid(pool, conn, 600, { leg: acct.bLoan });
    const ar = (await pool.query("SELECT id FROM gl_accounts WHERE company_id = $1 AND account_subtype = 'receivable' AND is_system_account", [co.A])).rows[0].id as string;
    const je = await plantJournal(pool, co.A, '2026-10-02', [[acct.aLoan, 650, 0], [ar, 0, 650]], 'P5 r1 receipt');
    const receipt = (await pool.query(
      `INSERT INTO customer_payments(company_id, client_id, payment_date, total_amount, payment_method, status, gl_journal_entry_id, created_by)
       VALUES ($1, $2, DATE '2026-10-02', 650, 'contra', 'confirmed', $3, $4) RETURNING id`, [co.A, party.aCustomer, je, U.ab])).rows[0].id as string;
    await forgeMessage(pool, m.message, "status = 'accepted', target_doc_type = 'customer_payment', target_doc_id = $2, handled_at = now()", [receipt]);
    const raw = (await rawMessages(pool, U.b, co.B, conn)).find((x) => x.message_id === m.message)!;
    expect(raw).toMatchObject({ receiver_state: 'clearing_standing', receiver_counts: true, receiver_journal_differs: true, payer_journal_differs: false });
    const r = await rowsAs(pool, U.b, co.B, conn);
    expect(itemOf(r, m.message)).toMatchObject({ bucket: 'matched', receiverJournalDiffers: true });
    expect(itemOf(r, m.message)?.mismatches).toContain('amount');
    expect(r.summary).toMatchObject({ reconciles: false, blockingRows: 1 });
    // the partner withheld: the receiver's column is NULL like every partner fact
    await setLoanClearing(pool, [co.A], false);
    expect((await rawMessages(pool, U.b, co.B, conn)).find((x) => x.message_id === m.message)?.receiver_journal_differs).toBeNull();
  });

  it('a receipt of exactly its message: not flagged', async () => {
    const m = await ePay(pool, conn, 300);
    await accepted(m);
    expect((await rawMessages(pool, U.b, co.B, conn)).find((x) => x.message_id === m.message)?.receiver_journal_differs).toBe(false);
  });
});

describe('(h): unsent on a cash connection', () => {
  it('the sender never sends on a cash connection (1025 not_loan): a bank-paid linked bill there is not unsent; on a loan connection it is', async () => {
    await fixturePaid(pool, conn, 120);
    const loanOnly = await fixturePaid(pool, conn, 130, { send: false });
    const onLoan = reportOf(await reportAs(U.b, co.B, conn, { section: 'attention' }));
    expect(onLoan.section.items.filter((i) => i.kind === 'unsent').map((i) => i.id)).toEqual([loanOnly.allocation]);
    await forgeConnection(pool, conn, "settlement_mode = 'cash'");
    const cashPaid = await fixturePaid(pool, conn, 140, { send: false });
    const res = await reportAs(U.b, co.B, conn, { section: 'attention' });
    expect(res.state.statusCode, errorText(res)).toBe(200);
    const unsent = reportOf(res).section.items.filter((i) => i.kind === 'unsent').map((i) => i.id);
    expect(unsent).not.toContain(cashPaid.allocation);
    expect(unsent).toEqual([]);
  });
});

describe('LOW-6: a pair in two groups', () => {
  it('one deterministic cut-over: the pair cut-over of the group its mirrors go to', async () => {
    await pool.query('INSERT INTO company_group_members(group_id, company_id) SELECT $1, c FROM unnest($2::uuid[]) c ON CONFLICT DO NOTHING', [co.H, [co.A, co.B]]);
    try {
      const lone = await pair(pool, conn, 330, { link: false, paid: 330 });
      for (let i = 0; i < 3; i += 1) {
        const att = reportOf(await reportAs(U.b, co.B, conn, { section: 'attention' }));
        const bills = att.section.items.filter((x) => x.kind === 'unlinked_bill');
        expect(bills.map((x) => x.id)).toEqual([lone.bill]);
        expect(bills[0]?.cutover).toBe('2026-01-01');
      }
    } finally {
      await pool.query('DELETE FROM company_group_members WHERE group_id = $1 AND company_id = ANY($2::uuid[])', [co.H, [co.A, co.B]]);
    }
  });
});

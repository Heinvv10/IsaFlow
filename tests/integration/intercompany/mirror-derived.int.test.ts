/**
 * Intercompany P2, round 6: the eliminations of mirrored documents are DERIVED at read time and never stored
 * (intercompany_mirror_eliminations / mirrorEliminations.ts). A pure function of the two ledgers AS AT the period end, so:
 *  F1  a hook that never ran, or timed out on a lock, leaves no wrong figure (there is no stored figure to leave);
 *  F2a a reversal pair across a year end does not revive a 2026 elimination the 2026 ledger does not support;
 *  F2b a reversal booked in a later period does not retroactively remove a 2026 elimination both 2026 ledgers support;
 * and a period report is the same before and after a later-period reversal.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { cancelSupplierInvoice } from '../../../src/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { cancelCustomerInvoice } from '../../../src/modules/accounting/services/ar/customerInvoiceCancelService';
import { reverseJournalEntry } from '../../../src/modules/accounting/services/gl/journalEntryService';
import { getPostedEliminations } from '../../../src/modules/accounting/services/reports/consolidatedTrialBalanceService';
import { getEliminationAdjustments } from '../../../src/modules/accounting/services/reports/consolidatedReportingService';
import { asAppUser, withoutTrigger } from './intercompany.helpers';
import { asService, co, groupAccounts, rawReverseJournal, reversalOf, U } from './mirror.helpers';
import { makeLedger } from './ledger.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const L = makeLedger(pool);
const { groupRow, adjustments, eliminate, derived, approveBill, accepted } = L;
const ga = groupAccounts;
beforeAll(async () => {
  await L.setup();
  await pool.query(
    `INSERT INTO fiscal_periods(company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
     VALUES ($1, 'IC A 2027', 1, 2027, '2027-01-01', '2027-12-31', 'open')`, [co.A]);
}, 60000);
afterAll(L.cleanup, 60000);   // (the 2027 period stays, like every fixture company's: the companies' ids are random per run)
beforeEach(L.reset);

const net = (lines: Array<{ groupAccountId: string; debit: number; credit: number }>) =>
  Object.fromEntries(['rev', 'exp'].map((k) => [k, lines.filter((l) => l.groupAccountId === (ga as Record<string, string>)[k]).reduce((n, l) => n + l.debit - l.credit, 0)]));
const lines = async (from: string, to: string) => (await derived(from, to)).flatMap((e) => e.lines);
const reverse = (company: string, user: string, je: string, date: string) =>
  asService(pool, user, company, () => reverseJournalEntry(company, je, user, { reversalDate: date }));

describe('F1: no hook, no stored figure: a hook that fails leaves nothing wrong', () => {
  it('the sender cancels while ANY session holds the old lock key: the cancel commits, nothing is stored, the figure is gone at once', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    expect(await derived()).toHaveLength(1);
    const c = await pool.connect();
    await c.query('BEGIN');
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('intercompany-eliminations:' || $1, 0))", [co.G]);
    try {
      const t0 = Date.now();
      await asService(pool, U.a, co.A, () => cancelCustomerInvoice(co.A, m.inv.id, U.a));
      expect(Date.now() - t0, 'the cancel never waits for a group lock').toBeLessThan(4000);
    } finally { await c.query('COMMIT'); c.release(); }
    expect(await derived()).toHaveLength(0);
    expect(await adjustments()).toHaveLength(0);
  });

  it('a reversal with NO hook at all (a raw statement): the display row still says matched, the derived figure is already gone', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    await rawReverseJournal(pool, (await groupRow()).first_target_journal_entry_id);
    expect(await groupRow()).toMatchObject({ match_status: 'matched' });
    expect(await derived()).toHaveLength(0);
    expect(await getPostedEliminations(co.G, '2026-01-01', '2026-12-31')).toEqual([]);
  });

  it('the three hook definers carry their own lock_timeout of 2 s (the connection\'s default is longer: a held lock must not stall a cancel for it)', async () => {
    const r = await pool.query(
      `SELECT proname, proconfig FROM pg_proc WHERE pronamespace = 'public'::regnamespace
        AND proname IN ('intercompany_withdraw_for_source', 'intercompany_sync_group_row', 'intercompany_journal_chain_changed') ORDER BY proname`);
    expect(r.rows.map((x) => [x.proname, (x.proconfig as string[]).includes('lock_timeout=2s')])).toEqual([
      ['intercompany_journal_chain_changed', true], ['intercompany_sync_group_row', true], ['intercompany_withdraw_for_source', true]]);
  });

  it.each([
    ['the receiver cancels its bill (the group-row sync)', 'receiver'],
    ['the sender cancels its invoice (the withdrawal and the reversal hook)', 'sender'],
  ] as const)('a hook blocked on a row lock gives up (lock_timeout 2 s), never hangs, and the document change still commits: %s', async (_name, who) => {
    const m = await accepted();
    await approveBill(m.bill);
    const c = await pool.connect();
    await c.query('BEGIN');
    await c.query('SELECT id FROM intercompany_transactions WHERE group_id = $1 FOR UPDATE', [co.G]);
    await c.query('SELECT id FROM intercompany_messages WHERE id = $1 FOR UPDATE', [m.id]);
    try {
      const t0 = Date.now();
      if (who === 'receiver') await asService(pool, U.b, co.B, () => cancelSupplierInvoice(co.B, m.bill, U.b));
      else await asService(pool, U.a, co.A, () => cancelCustomerInvoice(co.A, m.inv.id, U.a));
      expect(Date.now() - t0).toBeLessThan(20000);
    } finally { await c.query('COMMIT'); c.release(); }
    const table = who === 'receiver' ? 'supplier_invoices' : 'customer_invoices';
    expect((await pool.query(`SELECT status FROM ${table} WHERE id = $1`, [who === 'receiver' ? m.bill : m.inv.id])).rows[0].status).toBe('cancelled');
    expect(await derived()).toHaveLength(0);   // the figure follows the ledger whether or not the hook got through
  }, 60000);
});

describe('F2: the ledgers as at the period end', () => {
  it('F2a: reversed in Sep 2026 and re-reversed in Jan 2027: nothing for 2026 (A\'s 2026 revenue nets to 0); as at the end of 2027 it stands again', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    const j = m.message.source_journal_entry_id as string;
    expect(await derived('2026-01-01', '2026-12-31')).toHaveLength(1);
    await reverse(co.A, U.a, j, '2026-09-15');
    const r1 = (await reversalOf(pool, j))!;
    await reverse(co.A, U.a, r1, '2027-01-15');
    expect(await derived('2026-01-01', '2026-12-31')).toHaveLength(0);   // as at 31 Dec 2026 the invoice is reversed
    expect(await derived('2026-01-01', '2026-09-10')).toHaveLength(1);   // as at 10 Sep (before the reversal) it stood
    expect(await derived('2026-01-01', '2027-12-31')).toHaveLength(1);   // as at 31 Dec 2027 the re-reversal has put the invoice back (an odd chain again)
  });

  it('F2b: a reversal booked in Jan 2027 does not remove the 2026 elimination both 2026 ledgers support; the 2026 report is the same before and after', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    const before = await lines('2026-01-01', '2026-12-31');
    const beforeTb = await getPostedEliminations(co.G, '2026-01-01', '2026-12-31');
    expect(net(before)).toEqual({ rev: 1000, exp: -1000 });
    await reverse(co.A, U.a, m.message.source_journal_entry_id as string, '2027-01-15');
    expect(await lines('2026-01-01', '2026-12-31')).toEqual(before);
    expect(await getPostedEliminations(co.G, '2026-01-01', '2026-12-31')).toEqual(beforeTb);
    expect(net(await lines('2026-01-01', '2027-12-31'))).toEqual({ rev: 0, exp: 0 });   // the later period sees the reversal
  });

  it('a cancel rolled forward past a locked period (the reversal dated after the year end) leaves the earlier year\'s figure alone', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    const before = await lines('2026-01-01', '2026-12-31');
    await asService(pool, U.a, co.A, () => cancelCustomerInvoice(co.A, m.inv.id, U.a));   // (today's date: after 2026-12-31 or not, the as-at rule holds either way)
    const rev = String((await pool.query('SELECT entry_date FROM gl_journal_entries WHERE reversal_of_id = $1', [m.message.source_journal_entry_id])).rows[0].entry_date);
    const after = await lines('2026-01-01', '2026-12-31');
    const reversedWithinYear = rev.slice(0, 10) <= '2026-12-31';
    expect(after).toEqual(reversedWithinYear ? [] : before);
  });

  it('the receiver\'s bill journal dated after the period end is not carried at that end', async () => {
    const m = await accepted();   // sold 1 Sep 2026
    await pool.query("UPDATE supplier_invoices SET invoice_date = '2026-09-20', due_date = '2026-10-20' WHERE id = $1", [m.bill]);
    await approveBill(m.bill);
    expect(await derived('2026-01-01', '2026-09-10')).toHaveLength(0);   // the sale is in the period; the receiver's expense is not booked yet
    expect(await derived('2026-01-01', '2026-09-30')).toHaveLength(1);
  });
});

describe('the period and the value checks are the function\'s own', () => {
  it('a row is in the period of its sale date only: before it and after it, nothing', async () => {
    const m = await accepted();   // sold 1 Sep 2026
    await approveBill(m.bill);
    expect(await derived('2026-01-01', '2026-08-31')).toHaveLength(0);
    expect(await derived('2026-10-01', '2026-12-31')).toHaveLength(0);
    expect(await derived('2026-09-01', '2026-09-30')).toHaveLength(1);
  });

  const posted = async (company: string, lines: Array<[string, number, number]>) => {
    const id = (await pool.query(
      `INSERT INTO gl_journal_entries(entry_date, description, source, status, created_by, company_id) VALUES ('2026-09-01', 'planted', 'manual', 'draft', $1, $2) RETURNING id`, [U.ab, company])).rows[0].id as string;
    for (const [a, d, c] of lines) await pool.query('INSERT INTO gl_journal_lines(journal_entry_id, gl_account_id, debit, credit, company_id) VALUES ($1, $2, $3, $4, $5)', [id, a, d, c, company]);
    await pool.query("UPDATE gl_journal_entries SET status = 'posted', posted_at = now() WHERE id = $1", [id]);
    return id;
  };
  const acct = async (company: string, where: string) => (await pool.query(`SELECT id FROM gl_accounts WHERE company_id = $1 AND ${where} LIMIT 1`, [company])).rows[0].id as string;

  it('a row bound to a receiver journal of ANOTHER financial year (figures right, chains standing) is not eliminated: the cut-off is the function\'s own', async () => {
    const m = await accepted({ date: '2027-01-02' });
    await pool.query("UPDATE supplier_invoices SET invoice_date = '2026-12-30', due_date = '2027-01-30' WHERE id = $1", [m.bill]);
    await approveBill(m.bill);   // a variance (cut-off): the sender sold in 2027, the receiver booked it in 2026; its journal carries the right figures
    expect(await groupRow()).toMatchObject({ match_status: 'variance', variance_reason: 'cut-off: different financial years' });
    const journal = (await pool.query('SELECT gl_journal_entry_id AS je FROM supplier_invoices WHERE id = $1', [m.bill])).rows[0].je as string;
    await withoutTrigger(pool, 'intercompany_transactions', 'trg_intercompany_transaction_parties_immutable', (q) => q.query(
      'UPDATE intercompany_transactions SET first_target_journal_entry_id = $2 WHERE id = $1', [m.message.payload.groupTransactionId, journal]));
    expect(await derived('2027-01-01', '2027-12-31')).toHaveLength(0);
  });

  it('a group row that is not the one its message recorded (the row\'s source journal is another) is not eliminated', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    expect(await derived()).toHaveLength(1);
    const other = await posted(co.A, [[await acct(co.A, "account_subtype = 'receivable'"), 1, 0], [await acct(co.A, "account_type = 'revenue'"), 0, 1]]);
    await withoutTrigger(pool, 'intercompany_transactions', 'trg_intercompany_transaction_parties_immutable', (q) => q.query(
      'UPDATE intercompany_transactions SET source_journal_entry_id = $2 WHERE id = $1', [m.message.payload.groupTransactionId, other]));
    expect(await derived()).toHaveLength(0);
  });

  it('a row bound (by a forgery of the display columns) to a receiver journal that does not carry the figures is not eliminated', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    expect(await derived()).toHaveLength(1);
    // standing chain, same year, but no input VAT leg: the receiver's expense is 1000, its payable 1150, its VAT 0
    const bad = await posted(co.B, [[await acct(co.B, "account_type = 'expense'"), 1000, 0], [await acct(co.B, "account_subtype = 'payable'"), 0, 1000]]);
    await withoutTrigger(pool, 'intercompany_transactions', 'trg_intercompany_transaction_parties_immutable', (q) => q.query(
      'UPDATE intercompany_transactions SET first_target_journal_entry_id = $2 WHERE group_id = $1', [co.G, bad]));
    expect(await derived()).toHaveLength(0);
  });

  it('a row whose sender journal does not carry the invoice\'s figures is not eliminated', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    const bad = await posted(co.A, [[await acct(co.A, "account_subtype = 'receivable'"), 1150, 0], [await acct(co.A, "account_type = 'revenue'"), 0, 1150]]);   // no VAT leg: revenue 1150, not the invoice's 1000
    await withoutTrigger(pool, 'intercompany_messages', 'trg_intercompany_messages_guard', (q) => q.query(
      'UPDATE intercompany_messages SET source_journal_entry_id = $2 WHERE id = $1', [m.id, bad]));
    await withoutTrigger(pool, 'intercompany_transactions', 'trg_intercompany_transaction_parties_immutable', (q) => q.query(
      'UPDATE intercompany_transactions SET source_journal_entry_id = $2 WHERE group_id = $1', [co.G, bad]));
    expect(await derived()).toHaveLength(0);
  });
});

describe('the reports read the derived lines beside the stored manual ones; the generator takes no mirrored row', () => {
  it('getPostedEliminations returns the derived lines; the generator creates nothing for a mirrored row; the eliminations list shows an automatic, unactionable item', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    expect(await asService(pool, U.ab, co.A, () => eliminate())).toHaveLength(0);
    expect(await adjustments()).toHaveLength(0);
    const tb = await asService(pool, U.ab, co.A, () => getPostedEliminations(co.G, '2026-01-01', '2026-12-31'));
    expect(tb.map((l) => [l.groupAccountId, l.debit, l.credit]).sort()).toEqual([[ga.exp, 0, 1000], [ga.rev, 1000, 0]].sort());
    const list = await asService(pool, U.ab, co.A, () => getEliminationAdjustments(co.G, '2026-01-01', '2026-12-31'));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ automatic: true, status: 'posted', description: expect.stringMatching(/^Automatic: mirrored intercompany documents/) });
  });

  it('a manual (non-mirrored) matched row keeps today\'s generator behaviour', async () => {
    await accepted();
    await pool.query(
      `INSERT INTO intercompany_transactions(group_id, source_company_id, target_company_id, transaction_type, amount, currency, description, transaction_date)
       VALUES ($1, $2, $3, 'sale', 70, 'ZAR', 'manual row', '2026-09-01')`, [co.G, co.A, co.B]);
    await withoutTrigger(pool, 'intercompany_transactions', 'trg_intercompany_transaction_parties_immutable', (q) => q.query(
      "UPDATE intercompany_transactions SET match_status = 'matched' WHERE group_id = $1 AND description = 'manual row'", [co.G]));
    const made = await asService(pool, U.ab, co.A, () => eliminate());
    expect(made).toHaveLength(1);
    expect(made[0]!.lines).toEqual(expect.arrayContaining([expect.objectContaining({ groupAccountId: ga.rev, debit: 70 })]));
  });

  const manualRow = async () => {
    await pool.query(
      `INSERT INTO intercompany_transactions(group_id, source_company_id, target_company_id, transaction_type, amount, currency, description, transaction_date)
       VALUES ($1, $2, $3, 'sale', 70, 'ZAR', 'manual row', '2026-09-01')`, [co.G, co.A, co.B]);
    await withoutTrigger(pool, 'intercompany_transactions', 'trg_intercompany_transaction_parties_immutable', (q) => q.query(
      "UPDATE intercompany_transactions SET match_status = 'matched' WHERE group_id = $1 AND description = 'manual row'", [co.G]));
  };

  it('manual rows stay idempotent: a rerun adds nothing; two runs at once make ONE adjustment per row (the unique index, with the loser skipped)', async () => {
    await manualRow();
    expect(await asService(pool, U.ab, co.A, () => eliminate())).toHaveLength(1);
    expect(await asService(pool, U.ab, co.A, () => eliminate())).toHaveLength(0);
    expect(await adjustments()).toHaveLength(1);
    await pool.query('DELETE FROM consolidation_adjustments WHERE group_id = $1', [co.G]);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let written!: () => void;
    const wrote = new Promise<void>((r) => { written = r; });
    const first = asService(pool, U.ab, co.A, async () => { const out = await eliminate(); written(); await held; return out; });
    await wrote;
    const second = asService(pool, U.ab, co.A, () => eliminate());   // waits on the first's uncommitted insert, then does nothing
    await new Promise((r) => setTimeout(r, 500));
    release();
    const [a, b] = await Promise.all([first, second]);
    expect([a.length, b.length]).toEqual([1, 0]);
    expect(await adjustments()).toHaveLength(1);
  });

  it('the database refuses a second standing elimination of one row, and allows another once the first is reversed', async () => {
    await manualRow();
    const [made] = await asService(pool, U.ab, co.A, () => eliminate());
    const row = made!.sourceIntercompanyId;
    const insert = () => pool.query(
      `INSERT INTO consolidation_adjustments(group_id, adjustment_type, description, period_start, period_end, lines, source_intercompany_id)
       VALUES ($1, 'interco_revenue', 'dup', '2026-01-01', '2026-12-31', '[]'::jsonb, $2)`, [co.G, row]);
    await expect(insert()).rejects.toMatchObject({ code: '23505' });
    await pool.query("UPDATE consolidation_adjustments SET status = 'reversed' WHERE id = $1", [made!.id]);
    await insert();
    expect(await adjustments()).toHaveLength(2);
  });

  it('a user who is not a member of the group reads nothing (the definer\'s own membership check)', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    expect(await asAppUser(pool, U.c, co.C, async (q) => (await q.query('SELECT * FROM public.intercompany_mirror_eliminations($1, $2, $3)', [co.G, '2026-01-01', '2026-12-31'])).rowCount, true)).toBe(0);
  });
});

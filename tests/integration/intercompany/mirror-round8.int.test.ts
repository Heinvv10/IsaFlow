/**
 * Intercompany P2, round 8 (the round-7 breaker review of the derived eliminations):
 *  B-M1  a company that LEFT the group keeps no mirrored elimination: both companies must be current members (the reports' member set), so the
 *        income statement and the trial balance show no orphan line;
 *  B-M2  the derived elimination is a set of dated EVENTS (+E when the pair starts standing, -E when it stops), so any range is the sum of its
 *        months LINE BY LINE: a receiver reversal, a sender reversal and a reverse-and-repost (eliminated once in total, the earlier month kept);
 *  B-M3  the trial balance eliminates P&L over the SAME window as its members' P&L columns (the fiscal year start to the period end), so it
 *        agrees with the income statement for those dates.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { reverseJournalEntry } from '../../../src/modules/accounting/services/gl/journalEntryService';
import { getConsolidatedIncomeStatement } from '../../../src/modules/accounting/services/reports/consolidatedStatementsService';
import { getConsolidatedTrialBalance } from '../../../src/modules/accounting/services/reports/consolidatedTrialBalanceService';
import { getEliminationAdjustments } from '../../../src/modules/accounting/services/reports/consolidatedReportingService';
import { MIRRORED_REVERSAL_LABEL } from '../../../src/modules/accounting/services/reports/mirrorEliminations';
import { asService, co, groupAccounts as ga, U } from './mirror.helpers';
import { makeLedger } from './ledger.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const L = makeLedger(pool);
const { derived, approveBill, accepted, sync } = L;
beforeAll(async () => { await L.setup(); await L.monthly(co.A, 2026); await L.monthly(co.B, 2026); }, 60000);
afterAll(L.cleanup, 60000);
beforeEach(L.reset);

const redate = (bill: string, date: string) => pool.query('UPDATE supplier_invoices SET invoice_date = $2::date, due_date = $2::date + 30 WHERE id = $1', [bill, date]);
const billJournal = async (bill: string) => (await pool.query('SELECT gl_journal_entry_id AS je FROM supplier_invoices WHERE id = $1', [bill])).rows[0].je as string;
const reverse = (company: string, user: string, je: string, date: string) =>
  asService(pool, user, company, () => reverseJournalEntry(company, je, user, { reversalDate: date }));

/** The consolidated income statement's revenue and expense on the two group accounts (consolidated and eliminated). */
async function is(from: string, to: string) {
  const s = await asService(pool, U.ab, co.A, () => getConsolidatedIncomeStatement(co.G, from, to));
  const find = (id: string) => [...s.revenue, ...s.costOfSales, ...s.operatingExpenses].find((l) => l.groupAccountId === id);
  const r = find(ga.rev); const e = find(ga.exp);
  return { rev: r?.consolidatedAmount ?? 0, exp: e?.consolidatedAmount ?? 0, revElim: r?.eliminationAmount ?? 0, expElim: e?.eliminationAmount ?? 0 };
}
type IS = Awaited<ReturnType<typeof is>>;
const add = (a: IS, b: IS) => ({ rev: a.rev + b.rev, exp: a.exp + b.exp, revElim: a.revElim + b.revElim, expElim: a.expElim + b.expElim });
const sub = (a: IS, b: IS) => ({ rev: a.rev - b.rev, exp: a.exp - b.exp, revElim: a.revElim - b.revElim, expElim: a.expElim - b.expElim });
/** The IS figures of each range now, so a case reads what IT moved (the members' ledgers keep the earlier cases' journals). */
async function baseline(...ranges: Array<readonly [string, string]>) {
  const out = new Map<string, IS>();
  for (const [f, t] of ranges) out.set(`${f}:${t}`, await is(f, t));
  return async (f: string, t: string) => sub(await is(f, t), out.get(`${f}:${t}`)!);
}
/** The derived lines' net (debit - credit) on the two group accounts for a period. */
async function lines(from: string, to: string) {
  const all = (await derived(from, to)).flatMap((e) => e.lines);
  const net = (id: string) => all.filter((l) => l.groupAccountId === id).reduce((n, l) => n + l.debit - l.credit, 0);
  return { rev: net(ga.rev), exp: net(ga.exp) };
}
/** A sale on `date` booked by B on the same date. */
async function bookedOn(date: string) {
  const m = await accepted({ date });
  await redate(m.bill, date);
  await approveBill(m.bill);
  return m;
}

describe('B-M1: a company that left the group keeps no mirrored elimination', () => {
  it('B leaves: nothing is derived, and the IS and TB show no orphan expense line (B\'s ledger is no longer consolidated)', async () => {
    const moved = await baseline(['2026-01-01', '2026-12-31']);
    await bookedOn('2026-09-01');
    expect(await derived()).toHaveLength(1);
    await pool.query('UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1 AND company_id = $2', [co.G, co.B]);
    try {
      expect(await derived()).toHaveLength(0);
      expect(await moved('2026-01-01', '2026-12-31')).toEqual({ rev: 1000, exp: 0, revElim: 0, expElim: 0 });   // A's sale, uneliminated; nothing on B's expense
      const tb = await asService(pool, U.ab, co.A, () => getConsolidatedTrialBalance(co.G, '2026-01-01', '2026-12-31'));
      const row = (id: string) => tb.groupAccounts.find((a) => a.groupAccountId === id);
      expect(row(ga.exp)).toBeUndefined();   // no orphan credit on B's expense
      expect(row(ga.rev)).toMatchObject({ eliminationDebit: 0, eliminationCredit: 0 });
    } finally {
      await pool.query('UPDATE company_group_members SET left_date = NULL WHERE group_id = $1 AND company_id = $2', [co.G, co.B]);
    }
  });
});

describe('B-M2: dated events, so months add up to the range line by line', () => {
  const months = [['2026-01-01', '2026-01-31'], ['2026-02-01', '2026-02-28'], ['2026-03-01', '2026-03-31']] as const;
  const ranges = [...months, ['2026-01-01', '2026-02-28'], ['2026-01-01', '2026-03-31']] as const;
  /** The range is the sum of its months, every line (absolute figures: the earlier cases' journals are in every one of them alike). */
  async function additive(last: number) {
    const range = await is(months[0][0], months[last]![1]);
    let sum = { rev: 0, exp: 0, revElim: 0, expElim: 0 };
    for (const [f, t] of months.slice(0, last + 1)) sum = add(sum, await is(f, t));
    expect(sum).toEqual(range);
    return range;
  }

  it('receiver reversal: booked in Jan, B reverses its bill journal in Feb: Jan eliminated, Feb carries the counter-elimination, Jan-Feb = Jan + Feb', async () => {
    const moved = await baseline(...ranges);
    const m = await bookedOn('2026-01-15');
    await reverse(co.B, U.b, await billJournal(m.bill), '2026-02-10');
    expect(await moved(...months[0])).toEqual({ rev: 0, exp: 0, revElim: -1000, expElim: -1000 });
    expect(await moved(...months[1])).toEqual({ rev: 1000, exp: 0, revElim: 1000, expElim: 1000 });
    expect(await moved('2026-01-01', '2026-02-28')).toEqual({ rev: 1000, exp: 0, revElim: 0, expElim: 0 });
    await additive(1);
    const feb = await derived(...months[1]);
    expect(feb.map((e) => [e.kind, e.keyDate])).toEqual([['reverse', '2026-02-10']]);
    const list = await asService(pool, U.ab, co.A, () => getEliminationAdjustments(co.G, ...months[1]));
    expect(list).toHaveLength(1);
    expect(list[0]!.description.startsWith(MIRRORED_REVERSAL_LABEL)).toBe(true);
    expect(await derived('2026-01-01', '2026-02-28')).toHaveLength(0);   // within one period +E and -E cancel
  });

  it('sender reversal: booked in Jan, A reverses its invoice journal in Feb: Jan-Feb = Jan + Feb on every line', async () => {
    const moved = await baseline(...ranges);
    const m = await bookedOn('2026-01-15');
    await reverse(co.A, U.a, m.message.source_journal_entry_id as string, '2026-02-10');
    expect(await moved(...months[0])).toEqual({ rev: 0, exp: 0, revElim: -1000, expElim: -1000 });
    expect(await moved(...months[1])).toEqual({ rev: 0, exp: 1000, revElim: 1000, expElim: 1000 });
    expect(await moved('2026-01-01', '2026-02-28')).toEqual({ rev: 0, exp: 1000, revElim: 0, expElim: 0 });
    await additive(1);
  });

  it('reverse-and-repost: J1 in Jan, reversed in Feb, the bill re-posted on J2 in Mar: eliminated ONCE in total, Jan unchanged, months add up', async () => {
    const moved = await baseline(...ranges);
    const m = await bookedOn('2026-01-15');
    const j1 = await billJournal(m.bill);
    const janBefore = await lines(...months[0]);
    await reverse(co.B, U.b, j1, '2026-02-10');
    // the re-post: the same posting dated 5 Mar, the bill linked to it (a fixture: no service re-posts a bill in place)
    const j2 = (await pool.query(
      `INSERT INTO gl_journal_entries(entry_date, description, source, status, created_by, company_id)
       SELECT '2026-03-05', description, source, 'draft', created_by, company_id FROM gl_journal_entries WHERE id = $1 RETURNING id`, [j1])).rows[0].id as string;
    await pool.query(`INSERT INTO gl_journal_lines(journal_entry_id, gl_account_id, debit, credit, company_id, description)
                      SELECT $2, gl_account_id, debit, credit, company_id, description FROM gl_journal_lines WHERE journal_entry_id = $1`, [j1, j2]);
    await pool.query("UPDATE gl_journal_entries SET status = 'posted', posted_at = now() WHERE id = $1", [j2]);
    await pool.query('UPDATE supplier_invoices SET gl_journal_entry_id = $2 WHERE id = $1', [m.bill, j2]);
    expect(await sync(U.b, co.B, m.bill)).toBe('matched');
    expect(await L.groupRow()).toMatchObject({ first_target_journal_entry_id: j1, target_journal_entry_id: j2 });   // the first match is kept
    expect(await lines(...months[0])).toEqual(janBefore);
    expect((await derived(...months[2])).map((e) => [e.kind, e.receiverJournalId, e.keyDate])).toEqual([['eliminate', j2, '2026-03-05']]);
    expect(await lines('2026-01-01', '2026-03-31')).toEqual({ rev: 1000, exp: -1000 });   // once, not twice
    expect(await moved('2026-01-01', '2026-03-31')).toEqual({ rev: 0, exp: 0, revElim: -1000, expElim: -1000 });
    await additive(2);
  });
});

describe('B-M3: the TB eliminates P&L over its members\' fiscal year to date, as the IS does for the same dates', () => {
  const tbNet = async () => {
    const tb = await asService(pool, U.ab, co.A, () => getConsolidatedTrialBalance(co.G, '2028-06-01', '2028-06-30'));
    const row = (id: string) => tb.groupAccounts.find((a) => a.groupAccountId === id);
    const net = (id: string) => ({ elim: (row(id)?.eliminationDebit ?? 0) - (row(id)?.eliminationCredit ?? 0),
                                   cons: (row(id)?.consolidatedDebit ?? 0) - (row(id)?.consolidatedCredit ?? 0) });
    return { starts: Object.values(tb.fiscalYearStarts), rev: net(ga.rev), exp: net(ga.exp) };
  };
  // the financial year 1 Mar 2028 - 28 Feb 2029 for both companies (a stored year: the fixtures' 2026 years are calendar years)
  beforeAll(async () => {
    for (const c of [co.A, co.B]) {
      await pool.query(`INSERT INTO fiscal_periods(company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
                        VALUES ($1, 'IC FY2029', 1, 2029, '2028-03-01', '2029-02-28', 'open')`, [c]);
    }
  });
  it('a 1 Mar fiscal year, an April sale, the June TB: the members\' YTD revenue and expense are eliminated and the TB agrees with the IS for Mar-Jun', async () => {
    const before = await tbNet();
    const moved = await baseline(['2028-03-01', '2028-06-30']);
    await bookedOn('2028-04-10');
    const after = await tbNet();
    expect(after.starts).toEqual(['2028-03-01', '2028-03-01']);
    expect([after.rev.elim - before.rev.elim, after.rev.cons - before.rev.cons]).toEqual([1000, 0]);
    expect([after.exp.elim - before.exp.elim, after.exp.cons - before.exp.cons]).toEqual([-1000, 0]);
    expect(await moved('2028-03-01', '2028-06-30')).toEqual({ rev: 0, exp: 0, revElim: -1000, expElim: -1000 });
    const isNow = await is('2028-03-01', '2028-06-30');
    expect([isNow.rev + after.rev.cons, isNow.exp - after.exp.cons]).toEqual([0, 0]);   // the same figures for the same dates (a credit on the TB is the IS's revenue)
  });
});

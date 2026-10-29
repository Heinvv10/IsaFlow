/**
 * Budgets P3 PR-B review r2 ruling (the lead's, for Hein to confirm), on real
 * PostgreSQL: Projected FY month by month over FY*. Up to the cutoff's month,
 * actual; after it, the budget where the line has a budget row for the month,
 * else the month's posted actual (forward-dated included). So Projected FY is
 * never below the Actual beside it for an unbudgeted or partly budgeted line,
 * and a fully budgeted line is the spec's formula, unchanged.
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { asRequest, dropTrackingFixture, seedTrackingFixture, type TrackingFixture } from './helpers/budgetTrackingFixture';
import { buildBudgetTrackingReport } from '@/modules/accounting/services/budgets/tracking/budgetTrackingService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: TrackingFixture;
// Today is 15 November 2026: November is in progress, the cutoff is 31 October.
const NOW = new Date('2026-11-15T10:00:00+02:00');

beforeAll(async () => { f = await seedTrackingFixture(pool); }, 120_000);
afterAll(async () => {
  try { await dropTrackingFixture(pool, f); } finally { await pool.end(); }
});

/** An expense account BT-6500 with postings on the given dates, budgeted (company grain) for `budgeted` months only. */
async function unbudgeted(c: PoolClient, postings: Array<[string, number]>, budgeted: Array<[string, number]> = []) {
  const acct = crypto.randomUUID();
  await c.query('SET LOCAL session_replication_role = replica');
  await c.query(`INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, normal_balance, level, is_active)
                 VALUES ($1, $2, 'BT-6500', 'Unbudgeted opex', 'expense', 'debit', 3, true)`, [acct, f.a]);
  for (const [i, [date, amount]] of postings.entries()) {
    const eid = crypto.randomUUID();
    await c.query(`INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, status, created_by, description, source, created_at)
                   VALUES ($1, $2, $3, $4::DATE, 'posted', $5, 'bt', 'manual', NOW())`, [eid, f.a, `BT-UB-${i}`, date, f.userA]);
    await c.query(`INSERT INTO gl_journal_lines (id, journal_entry_id, company_id, gl_account_id, debit, credit, description)
                   VALUES ($1, $2, $3, $4, $5, 0, 'bt'), ($6, $2, $3, $7, 0, $5, 'bt')`,
    [crypto.randomUUID(), eid, f.a, acct, amount, crypto.randomUUID(), f.acc.bank]);
  }
  for (const [month, amount] of budgeted) {
    await c.query(`INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount) VALUES ($1, $2, $3, $4::DATE, $5)`,
      [f.a, f.v.primary27, acct, `${month}-01`, amount]);
  }
  await c.query('SET LOCAL session_replication_role = origin');
}

/** A posted BT-6000 (fully budgeted opex) journal on `date`. */
async function postOpex(c: PoolClient, date: string, amount: number) {
  const eid = crypto.randomUUID();
  await c.query('SET LOCAL session_replication_role = replica');
  await c.query(`INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, status, created_by, description, source, created_at)
                 VALUES ($1, $2, 'BT-FD-1', $3::DATE, 'posted', $4, 'bt', 'manual', NOW())`, [eid, f.a, date, f.userA]);
  await c.query(`INSERT INTO gl_journal_lines (id, journal_entry_id, company_id, gl_account_id, debit, credit, description)
                 VALUES ($1, $2, $3, $4, $5, 0, 'bt'), ($6, $2, $3, $7, 0, $5, 'bt')`,
  [crypto.randomUUID(), eid, f.a, f.acc.opex, amount, crypto.randomUUID(), f.acc.bank]);
  await c.query('SET LOCAL session_replication_role = origin');
}

describe('Projected FY, month by month', () => {
  it('YTD: a posting in the in-progress month (10 Nov, and a forward-dated 28 Nov) counts; Projected FY >= YTD actual', async () => {
    const out = await asRequest(pool, f.a, f.userA, async () => {
      const r = await buildBudgetTrackingReport(f.a, { period: 'ytd', fiscalYear: 2027 }, NOW);
      return { r, line: r.lines.find((l) => l.accountCode === 'BT-6500')! };
    }, { before: (c) => unbudgeted(c, [['2026-06-05', 100], ['2026-11-10', 1000], ['2026-11-28', 7]]) });
    expect(out.line.budget).toBeNull();
    expect([out.line.actual, out.line.projected, out.line.fyBudget]).toEqual([1107, 1107, null]);
    expect(out.r.projection.cutoff).toBe('2026-10-31');
  });

  it('a past window (Q1) projects the whole year: every later month with no budget keeps its actual', async () => {
    const out = await asRequest(pool, f.a, f.userA, async () => {
      const r = await buildBudgetTrackingReport(f.a, { period: 'quarter', fiscalYear: 2027, quarter: 1 }, NOW);
      return r.lines.find((l) => l.accountCode === 'BT-6500')!;
    }, { before: (c) => unbudgeted(c, [['2026-04-02', 40], ['2026-09-30', 60], ['2026-12-01', 500]]) });
    // Window Mar - May: 40. Projection: 40 + September's 60 + December's forward-dated 500 (no budget for either).
    expect([out.actual, out.projected]).toEqual([40, 600]);
  });

  it('the bands still total their lines: NP projected = Σ line projections by polarity', async () => {
    const r = await asRequest(pool, f.a, f.userA, () => buildBudgetTrackingReport(f.a, { period: 'ytd', fiscalYear: 2027 }, NOW),
      { before: (c) => unbudgeted(c, [['2026-11-10', 1000]]) });
    const cents = (n: number) => Math.round(n * 100);
    const lineNp = r.lines.reduce((s, l) => s + (l.accountType === 'revenue' ? cents(l.projected) : -cents(l.projected)), 0);
    expect(cents(r.bands.find((b) => b.key === 'net_profit')!.projected)).toBe(lineNp);
  });

  it('a line budgeted for some months only: budget where budgeted, actual elsewhere (ledger-breaker r2 B)', async () => {
    const line = await asRequest(pool, f.a, f.userA, async () =>
      (await buildBudgetTrackingReport(f.a, { period: 'ytd', fiscalYear: 2027 }, NOW)).lines.find((l) => l.accountCode === 'BT-6500')!,
    { before: (c) => unbudgeted(c, [['2026-05-10', 300], ['2026-11-10', 1000], ['2027-01-20', 50]], [['2026-05', 250], ['2026-12', 400]]) });
    // Mar - Oct actual (300) + Nov: no budget, actual 1000 + Dec: budget 400 + Jan: no budget, actual 50 + Feb: 0.
    expect([line.actual, line.projected, line.fyBudget, line.projVariance]).toEqual([1300, 1750, 650, 1100]);
    expect(line.projected).toBeGreaterThanOrEqual(line.actual);
  });

  it('a fully budgeted line is unchanged: actuals to the cutoff, then every month its budget, a forward-dated actual included', async () => {
    const out = await asRequest(pool, f.a, f.userA, async () => {
      const r = await buildBudgetTrackingReport(f.a, { period: 'fy', fiscalYear: 2027 }, NOW);
      return { r, line: r.lines.find((l) => l.accountCode === 'BT-6000')! };
    }, { before: (c) => postOpex(c, '2026-12-15', 777) });
    // BT-6000 is budgeted 200 in every month of the fixture's 14-month FY2027; actual months end at October.
    const { r, line } = out;
    expect(r.projection.budgetMonths).toEqual(['2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04']);
    const toCutoff = line.monthly.filter((m) => m.month <= '2026-10').reduce((s, m) => s + Math.round(m.actual * 100), 0);
    expect(Math.round(line.projected * 100)).toBe(toCutoff + r.projection.budgetMonths.length * 200 * 100);
    expect(line.monthly.find((m) => m.month === '2026-12')!.actual).toBeGreaterThanOrEqual(777);
  });
});

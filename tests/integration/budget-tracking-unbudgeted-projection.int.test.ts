/**
 * Budgets P3 PR-B review r1 ruling (for Hein to confirm), on real PostgreSQL:
 * an UNBUDGETED line projects its posted actuals from FY* start through the
 * month holding today (forward-dated postings in it included, as Actual counts
 * them), so Projected FY is never below the YTD actual. Before, the cutoff (the
 * last complete month) dropped the in-progress month's real postings and put
 * nothing in their place. A budgeted line keeps the cutoff rule.
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

/** An unbudgeted expense account BT-6500 with postings on the given dates. */
async function unbudgeted(c: PoolClient, postings: Array<[string, number]>) {
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
  await c.query('SET LOCAL session_replication_role = origin');
}

describe('Projected FY of an unbudgeted line', () => {
  it('YTD: a posting in the in-progress month (10 Nov, and a forward-dated 28 Nov) counts; Projected FY >= YTD actual', async () => {
    const out = await asRequest(pool, f.a, f.userA, async () => {
      const r = await buildBudgetTrackingReport(f.a, { period: 'ytd', fiscalYear: 2027 }, NOW);
      return { r, line: r.lines.find((l) => l.accountCode === 'BT-6500')! };
    }, { before: (c) => unbudgeted(c, [['2026-06-05', 100], ['2026-11-10', 1000], ['2026-11-28', 7]]) });
    expect(out.line.budget).toBeNull();
    expect([out.line.actual, out.line.projected, out.line.fyBudget]).toEqual([1107, 1107, null]);
    expect(out.r.projection.unbudgetedMonths.at(-1)).toBe('2026-11');
    // A budgeted line keeps the cutoff: BT-6000 is budgeted, so October is its last actual month.
    expect(out.r.projection.cutoff).toBe('2026-10-31');
  });

  it('a past window (Q1) still projects the year to today, and its window Actual stays the window', async () => {
    const out = await asRequest(pool, f.a, f.userA, async () => {
      const r = await buildBudgetTrackingReport(f.a, { period: 'quarter', fiscalYear: 2027, quarter: 1 }, NOW);
      return r.lines.find((l) => l.accountCode === 'BT-6500')!;
    }, { before: (c) => unbudgeted(c, [['2026-04-02', 40], ['2026-09-30', 60], ['2026-12-01', 500]]) });
    // Window Mar - May: 40. Projection Mar - Nov: 40 + 60; December is after the month holding today.
    expect([out.actual, out.projected]).toEqual([40, 100]);
  });

  it('the bands still total their lines: NP projected = Σ line projections by polarity', async () => {
    const r = await asRequest(pool, f.a, f.userA, () => buildBudgetTrackingReport(f.a, { period: 'ytd', fiscalYear: 2027 }, NOW),
      { before: (c) => unbudgeted(c, [['2026-11-10', 1000]]) });
    const cents = (n: number) => Math.round(n * 100);
    const lineNp = r.lines.reduce((s, l) => s + (l.accountType === 'revenue' ? cents(l.projected) : -cents(l.projected)), 0);
    expect(cents(r.bands.find((b) => b.key === 'net_profit')!.projected)).toBe(lineNp);
  });
});

/**
 * CS-01, behavioural: the trial balance reports BALANCES, not the period's
 * movement — asserted against a real ledger rather than against SQL text.
 *
 * The mocked suite can only observe the query the service builds. That let a
 * mutation reproduce the exact wrong numbers while satisfying every assertion:
 * adding `AND je.entry_date >= ${periodStart}` to the WHERE clause bounds the
 * ROW SET, keeps `fyStart` bound, never mentions `fiscal_period_id`, and
 * passes the `not.toContain` checks. Measured against production (Velocity
 * Fibre, September 2026) it returned 7 of 83 accounts and R3,564,987.50 of
 * R139,181,540.68. The distinction between a cumulative and a period-bounded
 * basis lives entirely in SQL, so only a real database can tell them apart by
 * outcome.
 *
 * Read-only. No fixture is written: the assertions are properties of whatever
 * the ledger holds, not fixed amounts, so concurrent sessions changing dev data
 * cannot make this flake. Skips without DATABASE_URL.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { sql } from '@/lib/neon';
import { getTrialBalanceReport } from '@/modules/accounting/services/gl/trialBalanceService';
import {
  BROUGHT_FORWARD_CODE,
  getRetainedEarningsBroughtForward,
} from '@/modules/accounting/services/gl/trialBalanceBasis';
import { isDbReachable } from '../../helpers/dbReachable';

let dbUp = false;
beforeAll(async () => { dbUp = await isDbReachable(); });

interface Candidate {
  companyId: string;
  periodId: string;
  periodStart: string;
  periodEnd: string;
  fyStart: string;
}

/**
 * A company + period that discriminates BOTH halves of the basis:
 *
 *   - balance-sheet postings exist before the period, so a period-bounded
 *     basis gives a different balance;
 *   - the period is NOT the first of its fiscal year AND income-statement
 *     postings exist between the fiscal-year start and the period start, so
 *     cutting revenue/expense at the period start instead of the year start
 *     also gives a different answer.
 *
 * The first candidate this returned was March 2027 — the opening month of the
 * fiscal year, where fyStart == periodStart makes that second mutation a
 * genuine no-op and the fixture proves nothing about it.
 */
async function findCandidate(): Promise<Candidate | null> {
  const rows = (await sql`
    WITH periods AS (
      SELECT fp.id AS period_id, fp.company_id, fp.start_date, fp.end_date,
             make_date(
               CASE WHEN EXTRACT(MONTH FROM fp.start_date) >= COALESCE(c.financial_year_start, 3)
                    THEN EXTRACT(YEAR FROM fp.start_date)::int
                    ELSE EXTRACT(YEAR FROM fp.start_date)::int - 1 END,
               COALESCE(c.financial_year_start, 3), 1
             ) AS fy_start
      FROM fiscal_periods fp
      JOIN companies c ON c.id = fp.company_id
    )
    SELECT p.period_id, p.company_id, p.start_date, p.end_date, p.fy_start
    FROM periods p
    WHERE p.fy_start < p.start_date
      AND EXISTS (
        SELECT 1 FROM gl_journal_entries je
        JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id
        WHERE je.company_id = p.company_id AND je.status = 'posted'
          AND ga.account_type IN ('asset', 'liability', 'equity')
          AND je.entry_date < p.start_date
      )
      AND EXISTS (
        SELECT 1 FROM gl_journal_entries je2
        WHERE je2.company_id = p.company_id AND je2.status = 'posted'
          AND je2.entry_date BETWEEN p.start_date AND p.end_date
      )
      AND EXISTS (
        SELECT 1 FROM gl_journal_entries je3
        JOIN gl_journal_lines jl3 ON jl3.journal_entry_id = je3.id
        JOIN gl_accounts ga3 ON ga3.id = jl3.gl_account_id
        WHERE je3.company_id = p.company_id AND je3.status = 'posted'
          AND ga3.account_type IN ('revenue', 'expense')
          AND je3.entry_date >= p.fy_start AND je3.entry_date < p.start_date
      )
    ORDER BY p.end_date DESC
    LIMIT 1
  `) as Array<Record<string, unknown>>;

  const r = rows[0];
  if (!r) return null;
  return {
    companyId: String(r.company_id),
    periodId: String(r.period_id),
    periodStart: String(r.start_date).slice(0, 10),
    periodEnd: String(r.end_date).slice(0, 10),
    fyStart: String(r.fy_start).slice(0, 10),
  };
}

/** Income-statement movement in [from, to). What a period-bounded cut would drop. */
async function isMovementBetween(companyId: string, from: string, to: string): Promise<number> {
  const rows = (await sql`
    SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) AS net
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = jl.company_id
    WHERE je.status = 'posted'
      AND je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND ga.account_type IN ('revenue', 'expense')
      AND je.entry_date >= ${from} AND je.entry_date < ${to}
  `) as Array<Record<string, unknown>>;
  return Number(rows[0]!.net);
}

/** Balance-sheet balances computed independently, straight from the ledger. */
async function inceptionBalances(companyId: string, asAt: string): Promise<Map<string, number>> {
  const rows = (await sql`
    SELECT ga.account_code, SUM(jl.debit) - SUM(jl.credit) AS net
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = jl.company_id
    WHERE je.status = 'posted'
      AND je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND ga.account_type IN ('asset', 'liability', 'equity')
      AND je.entry_date <= ${asAt}
    GROUP BY ga.account_code
  `) as Array<Record<string, unknown>>;
  return new Map(rows.map(r => [String(r.account_code), Number(r.net)]));
}

/** The same accounts measured the WRONG way — movement inside the period only. */
async function periodMovements(
  companyId: string, from: string, to: string,
): Promise<Map<string, number>> {
  const rows = (await sql`
    SELECT ga.account_code, SUM(jl.debit) - SUM(jl.credit) AS net
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = jl.company_id
    WHERE je.status = 'posted'
      AND je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND ga.account_type IN ('asset', 'liability', 'equity')
      AND je.entry_date >= ${from} AND je.entry_date <= ${to}
    GROUP BY ga.account_code
  `) as Array<Record<string, unknown>>;
  return new Map(rows.map(r => [String(r.account_code), Number(r.net)]));
}

describe('trial balance basis — against a real ledger', () => {
  /**
   * LOAD-BEARING for the WHERE-clause mutation as well as the CASE-arm ones:
   * a lower `entry_date` bound on the row set drops every account that did not
   * move in the period and values the rest at movement, so this comparison
   * against an independent inception sum fails on both counts.
   */
  it('reports balance-sheet accounts cumulatively, matching an independent inception sum', async () => {
    if (!dbUp) return;
    const c = await findCandidate();
    if (!c) return;

    const report = await getTrialBalanceReport(c.companyId, c.periodId);
    const cumulative = await inceptionBalances(c.companyId, c.periodEnd);

    const bsRows = report.rows.filter(
      r => ['asset', 'liability', 'equity'].includes(r.accountType)
        && r.accountCode !== BROUGHT_FORWARD_CODE,
    );
    expect(bsRows.length).toBeGreaterThan(0);

    for (const row of bsRows) {
      const expected = cumulative.get(row.accountCode);
      expect(expected, `no independent balance for ${row.accountCode}`).toBeDefined();
      expect(
        Math.abs((row.debitBalance - row.creditBalance) - (expected ?? 0)),
        `${row.accountCode} is not its inception-to-date balance`,
      ).toBeLessThan(0.01);
    }
  });

  /**
   * The mutation this exists for: a period-bounded basis. It produces different
   * numbers on real data, so the assertion above cannot pass under it — the
   * check here is that the two bases genuinely diverge on this fixture, i.e.
   * that the test above has something to catch.
   */
  it('the wrong (period-bounded) basis gives materially different numbers on this data', async () => {
    if (!dbUp) return;
    const c = await findCandidate();
    if (!c) return;

    const cumulative = await inceptionBalances(c.companyId, c.periodEnd);
    const movement = await periodMovements(c.companyId, c.periodStart, c.periodEnd);

    const diverging = [...cumulative.entries()].filter(
      ([code, net]) => Math.abs(net - (movement.get(code) ?? 0)) >= 0.01,
    );
    expect(
      diverging.length,
      'fixture is useless: cumulative and period-bounded agree everywhere',
    ).toBeGreaterThan(0);
  });

  /**
   * The fixture must discriminate the income-statement half too, or a mutation
   * that cuts revenue/expense at the period start instead of the fiscal-year
   * start passes unnoticed.
   */
  it('the fixture has income-statement activity the period-bounded basis would drop', async () => {
    if (!dbUp) return;
    const c = await findCandidate();
    if (!c) return;

    expect(c.fyStart < c.periodStart).toBe(true);
    const dropped = await isMovementBetween(c.companyId, c.fyStart, c.periodStart);
    expect(
      Math.abs(dropped),
      'fixture is useless for the income statement half: nothing between the year start and the period start',
    ).toBeGreaterThan(0.01);
  });

  it('measures income-statement accounts from the fiscal-year start, not the period start', async () => {
    if (!dbUp) return;
    const c = await findCandidate();
    if (!c) return;

    const report = await getTrialBalanceReport(c.companyId, c.periodId);
    expect(report.fiscalYearStart).toBe(c.fyStart);

    const isRows = report.rows.filter(r => ['revenue', 'expense'].includes(r.accountType));
    const isTotal = isRows.reduce((s, r) => s + (r.debitBalance - r.creditBalance), 0);

    const periodOnly = await isMovementBetween(c.companyId, c.periodStart, c.periodEnd);
    const yearToDate = await isMovementBetween(c.companyId, c.fyStart, c.periodEnd);

    // Year-to-date, not the period's own movement.
    expect(Math.abs(isTotal - yearToDate)).toBeLessThan(0.01);
    expect(Math.abs(isTotal - periodOnly)).toBeGreaterThan(0.01);
  });

  it('balances: total debits equal total credits on real data', async () => {
    if (!dbUp) return;
    const c = await findCandidate();
    if (!c) return;

    const report = await getTrialBalanceReport(c.companyId, c.periodId);
    expect(report.balanced).toBe(true);
    expect(report.difference).toBe(0);
    expect(report.accountCount).toBeGreaterThan(0);
  });
});

/**
 * The brought-forward bound is STRICT: profit earned before `fromDate`, not on
 * it. `<` → `<=` passed the whole mocked suite while double-counting every
 * entry dated exactly on the fiscal-year start — 1 March for every production
 * company, which is precisely where opening journals land — pushing the trial
 * balance out of balance by that amount.
 *
 * `fromDate` here is any real posting date, not a fiscal-year start: the
 * boundary semantics are identical and it needs no fixture written.
 */
describe('retained earnings brought forward — the date bound is strict', () => {
  /** A company and date where posted revenue/expense entries fall exactly on the date. */
  async function findBoundaryDate(): Promise<{ companyId: string; onDate: string; onDateNet: number } | null> {
    const rows = (await sql`
      SELECT je.company_id, je.entry_date, SUM(jl.credit - jl.debit) AS net_on_date
      FROM gl_journal_entries je
      JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = jl.company_id
      WHERE je.status = 'posted' AND ga.account_type IN ('revenue', 'expense')
      GROUP BY je.company_id, je.entry_date
      HAVING ABS(SUM(jl.credit - jl.debit)) > 1
      ORDER BY ABS(SUM(jl.credit - jl.debit)) DESC
      LIMIT 1
    `) as Array<Record<string, unknown>>;
    const r = rows[0];
    if (!r) return null;
    return {
      companyId: String(r.company_id),
      onDate: String(r.entry_date).slice(0, 10),
      onDateNet: Number(r.net_on_date),
    };
  }

  /** Independently: profit strictly before, and profit up to and including, `date`. */
  async function bothBounds(companyId: string, date: string): Promise<{ strict: number; inclusive: number }> {
    const rows = (await sql`
      SELECT
        COALESCE(SUM(jl.credit - jl.debit) FILTER (WHERE je.entry_date <  ${date}), 0) AS strict,
        COALESCE(SUM(jl.credit - jl.debit) FILTER (WHERE je.entry_date <= ${date}), 0) AS inclusive
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = jl.company_id
      WHERE je.status = 'posted'
        AND je.company_id = ${companyId}::UUID
        AND jl.company_id = ${companyId}::UUID
        AND ga.account_type IN ('revenue', 'expense')
    `) as Array<Record<string, unknown>>;
    return { strict: Number(rows[0]!.strict), inclusive: Number(rows[0]!.inclusive) };
  }

  it('excludes entries dated exactly on the cut-off, and includes everything before it', async () => {
    if (!dbUp) return;
    const b = await findBoundaryDate();
    if (!b) return;

    const bounds = await bothBounds(b.companyId, b.onDate);
    // The fixture must actually straddle the boundary or it proves nothing.
    expect(
      Math.abs(bounds.inclusive - bounds.strict),
      'fixture is useless: nothing is dated exactly on the cut-off',
    ).toBeGreaterThan(1);

    const actual = await getRetainedEarningsBroughtForward(b.companyId, b.onDate);

    expect(Math.abs(actual - bounds.strict)).toBeLessThan(0.01);
    // ...and is NOT the inclusive figure, which is what `<=` would produce.
    expect(Math.abs(actual - bounds.inclusive)).toBeGreaterThan(1);
  });

  it('an inclusive bound would unbalance the report by the entries on the boundary', async () => {
    if (!dbUp) return;
    const b = await findBoundaryDate();
    if (!b) return;
    const bounds = await bothBounds(b.companyId, b.onDate);
    // The size of the break `<=` would introduce — non-trivial, not a rounding wobble.
    expect(Math.abs(bounds.inclusive - bounds.strict)).toBeGreaterThan(100);
  });
});

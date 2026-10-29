/**
 * Budgets P3, review round 6, on real PostgreSQL: a budget that covers only PART of a cross-year
 * window, wherever it shows. A band holding a partial line has no band budget (F2; the profit
 * totals above it neither, so no bridge), while a band whose lines are whole keeps its own. A member
 * bullet that is partial at its own grain leaves every member without a budget (F1, so the members
 * keep partitioning NP), judged per (member, account) like the lines (r7). The partial lines are
 * named in `notices.partialBudget` (F3).
 * Seed: helpers/budgetTrackingFixture.ts (FY2027 Mar 2026 - Apr 2027; FY2028 May 2027 - Apr 2028).
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { asRequest, dropTrackingFixture, seedTrackingFixture, type TrackingFixture } from './helpers/budgetTrackingFixture';
import { buildBudgetTrackingReport } from '@/modules/accounting/services/budgets/tracking/budgetTrackingService';
import { budgetBridgeSteps } from '@/modules/accounting/services/budgets/tracking/budgetBridgeSteps';
import type { BudgetTrackingReport, TrackingParams } from '@/modules/accounting/services/budgets/tracking/trackingTypes';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: TrackingFixture;
const NOW = new Date('2026-11-15T10:00:00+02:00');
// FY2027's Mar - Apr 2027 and FY2028's May - Jun 2027.
const W: TrackingParams = { period: 'custom', from: '2027-03', to: '2027-06' };

beforeAll(async () => { f = await seedTrackingFixture(pool); }, 120_000);
afterAll(async () => {
  try { await dropTrackingFixture(pool, f); } finally { await pool.end(); }
});

const line = (r: BudgetTrackingReport, acct: string) => r.lines.find((l) => l.accountId === acct)!;
const band = (r: BudgetTrackingReport, k: string) => r.bands.find((b) => b.key === k)!;
const run = (p: TrackingParams, before: (c: PoolClient) => Promise<unknown>) =>
  asRequest(pool, f.a, f.userA, () => buildBudgetTrackingReport(f.a, p, NOW), { before });
const amt = (c: PoolClient, vid: string, acct: string, month: string, amount: number, d: { cc2?: string } = {}) =>
  c.query(`INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount, cc2_id) VALUES ($1, $2, $3, $4::DATE, $5, $6)`,
    [f.a, vid, acct, month, amount, d.cc2 ?? null]);
/** FY2028 budgets these accounts at company level in May and June (opex is budgeted there already). */
const fy28 = async (c: PoolClient, accts: string[], amount = 10) => {
  for (const a of accts) for (const m of ['2027-05-01', '2027-06-01']) await amt(c, f.v.primary28, a, m, amount);
};

describe('F2: a band holding a partial line has no band budget', () => {
  it('T1c: turnover with a partial line (sales) and a whole one: no turnover budget, no profit totals, no bridge', async () => {
    const extra = crypto.randomUUID();
    const r = await run(W, async (c) => {
      await c.query(`INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, normal_balance) VALUES ($1, $2, 'BT-4100', 'Sales 2', 'revenue', 'credit')`, [extra, f.a]);
      for (const m of ['2027-03-01', '2027-04-01']) await amt(c, f.v.primary27, extra, m, 1);
      await fy28(c, [extra, f.acc.cos, f.acc.interest, f.acc.fin]);
    });
    expect([line(r, f.acc.sales).partialBudget, line(r, extra).partialBudget, line(r, extra).budget]).toEqual([true, false, 22]);
    expect([band(r, 'turnover').budget, band(r, 'turnover').variance, band(r, 'turnover').variancePct]).toEqual([null, null, null]);
    expect(['gross_profit', 'operating_profit', 'net_profit'].map((k) => band(r, k).budget)).toEqual([null, null, null]);
    expect(budgetBridgeSteps(r)).toEqual([]);
    // The bands whose lines are whole keep their budget.
    // COS: FT 40 + HT 30 a month in FY2027 (Mar, Apr), 10 a month in FY2028 (May, Jun).
    expect(band(r, 'cost_of_sales').budget).toBe((40 + 30) * 2 + 10 * 2);
  });

  it('T1b: only other income partial: gross profit keeps its budget; operating and net profit have none', async () => {
    const r = await run(W, (c) => fy28(c, [f.acc.sales, f.acc.cos, f.acc.fin]));
    expect(line(r, f.acc.interest).partialBudget).toBe(true);
    expect(band(r, 'other_income').budget).toBeNull();
    expect(band(r, 'gross_profit').budget).toBe((150 * 2 + 10 * 2) - (70 * 2 + 10 * 2));
    expect([band(r, 'operating_profit').budget, band(r, 'net_profit').budget]).toEqual([null, null]);
  });
});

describe('F1: a member partial at its own grain', () => {
  it('T8: group_by cc2, P1 budgeted in FY2027 only (no line partial): every member budget is absent', async () => {
    const r = await run({ ...W, groupBy: 'cc2' }, async (c) => {
      await fy28(c, [f.acc.cos, f.acc.interest, f.acc.fin]);
      for (const m of ['2027-05-01', '2027-06-01']) await amt(c, f.v.primary28, f.acc.sales, m, 150, { cc2: f.cc.P2 });
    });
    expect(r.lines.some((l) => l.partialBudget)).toBe(false);
    expect(band(r, 'net_profit').budget).not.toBeNull();
    const members = r.members!;
    expect(members.length).toBeGreaterThan(2);
    for (const m of members) expect([m.name, m.budget, m.variance, m.favourable]).toEqual([m.name, null, null, null]);
  });
});

describe('r7: the member rule per account, the untagged member, a nulled band keeps its unallocated', () => {
  type D = { cc1?: string; cc2?: string; bu?: string };
  const put28 = async (c: PoolClient, acct: string, amount: number, d: D) => {
    for (const m of ['2027-05-01', '2027-06-01']) {
      await c.query(`INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount, cc1_id, cc2_id, bu_id) VALUES ($1, $2, $3, $4::DATE, $5, $6, $7, $8)`,
        [f.a, f.v.primary28, acct, m, amount, d.cc1 ?? null, d.cc2 ?? null, d.bu ?? null]);
    }
  };

  it("A3: P1's sales move to P2 in FY2028: FT keeps COS but loses its sales, so FT is partial and every member is null", async () => {
    const r = await run({ ...W, groupBy: 'cc1' }, async (c) => {
      await put28(c, f.acc.sales, 150, { cc2: f.cc.P2 });
      await put28(c, f.acc.cos, 40, { cc1: f.cc.FT }); await put28(c, f.acc.cos, 30, { cc1: f.cc.HT });
      await put28(c, f.acc.interest, 5, { bu: f.bu.B1 }); await put28(c, f.acc.fin, 7, { cc2: f.cc.PN });
    });
    expect(r.lines.some((l) => l.partialBudget)).toBe(false);
    expect(band(r, 'net_profit').budget).not.toBeNull();
    for (const m of r.members!) expect([m.name, m.budget, m.variance, m.favourable]).toEqual([m.name, null, null, null]);
  });

  it('A2: the untagged remainder budgeted in FY2027 only (FY2028 fully tagged at CC1): every member is null', async () => {
    const r = await run({ ...W, groupBy: 'cc1' }, async (c) => {
      await c.query('DELETE FROM budget_month_amounts WHERE version_id = $1', [f.v.primary28]);
      await put28(c, f.acc.sales, 100, { cc2: f.cc.P1 }); await put28(c, f.acc.sales, 50, { cc2: f.cc.P2 });
      await put28(c, f.acc.cos, 40, { cc1: f.cc.FT }); await put28(c, f.acc.cos, 30, { cc1: f.cc.HT });
      await put28(c, f.acc.opex, 210, { cc1: f.cc.FT }); await put28(c, f.acc.interest, 5, { cc1: f.cc.FT });
      await put28(c, f.acc.fin, 7, { cc1: f.cc.HT });
    });
    expect(r.lines.some((l) => l.partialBudget)).toBe(false);
    expect(band(r, 'net_profit').budget).not.toBeNull();
    for (const m of r.members!) expect([m.name, m.budget, m.variance, m.favourable]).toEqual([m.name, null, null, null]);
  });

  it('A2b: only the UNTAGGED remainder is partial (every line and every tagged member whole): every member is null', async () => {
    // Finance cost: FY2027 at CC2 P1 (rolls up to FT) AND the chainless PN (untagged under CC1); FY2028 at P1
    // only. Every other account mirrors FY2027's grain in FY2028 (opex is company level in both already).
    const r = await run({ ...W, groupBy: 'cc1' }, async (c) => {
      for (const m of ['2027-03-01', '2027-04-01']) {
        await c.query(`INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount, cc2_id) VALUES ($1, $2, $3, $4::DATE, 3, $5)`,
          [f.a, f.v.primary27, f.acc.fin, m, f.cc.P1]);
      }
      await put28(c, f.acc.sales, 100, { cc2: f.cc.P1 }); await put28(c, f.acc.sales, 50, { cc2: f.cc.P2 });
      await put28(c, f.acc.cos, 40, { cc1: f.cc.FT }); await put28(c, f.acc.cos, 30, { cc1: f.cc.HT });
      await put28(c, f.acc.interest, 5, { bu: f.bu.B1 }); await put28(c, f.acc.fin, 3, { cc2: f.cc.P1 });
    });
    expect(r.lines.some((l) => l.partialBudget)).toBe(false);
    expect(band(r, 'net_profit').budget).not.toBeNull();
    for (const m of r.members!) expect([m.name, m.budget, m.variance, m.favourable]).toEqual([m.name, null, null, null]);
  });

  it('A6: CC2 = P1, sales at P1 in FY2027 and company level in FY2028: turnover has no budget but keeps its unallocated', async () => {
    const r = await run({ ...W, cc2Id: f.cc.P1 }, (c) => put28(c, f.acc.sales, 100, {}));
    expect([line(r, f.acc.sales).partialBudget, line(r, f.acc.sales).budgetAboveFilter, line(r, f.acc.sales).unallocatedBudget]).toEqual([true, true, 200]);
    expect([band(r, 'turnover').budget, band(r, 'turnover').unallocatedBudget]).toEqual([null, 200]);
  });
});

describe('F3: the partial lines are named', () => {
  it('notices.partialBudget counts them and keeps their actual per polarity; null when none', async () => {
    const r = await run(W, (c) => fy28(c, [f.acc.sales, f.acc.cos, f.acc.fin]));
    const interest = line(r, f.acc.interest);
    expect(r.notices.partialBudget).toEqual({ count: 1, actual: { income: interest.actual, expense: 0 } });
    const whole = await run(W, (c) => fy28(c, [f.acc.sales, f.acc.cos, f.acc.interest, f.acc.fin]));
    expect(whole.notices.partialBudget).toBeNull();
  });
});

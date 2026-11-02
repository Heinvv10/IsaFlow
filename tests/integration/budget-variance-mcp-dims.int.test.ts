/**
 * Budgets P3 PR-F, on real PostgreSQL: MCP budget_variance with `version_id`, `cc1_id`, `cc2_id`
 * or `bu_id` answers with the tracking engine's figures for that filter (`buildRangeTracking`,
 * whole months), names every line whose budget sits above the filter, and reads another
 * company's ids as a plain miss. The tool's DEFAULT output (no new argument) is held byte for byte
 * by budget-variance-mcp-default.int.test.ts. app_user under forced RLS.
 * Seed: helpers/budgetTrackingFixture.ts.
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { budgetVarianceTool } from '@/lib/mcp/tools/budgetVariance';
import type { McpToolContext } from '@/lib/mcp/types';
import { buildRangeTracking, type RangeTrackingOptions } from '@/modules/accounting/services/budgets/tracking/trackingRange';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { asRequest, dropTrackingFixture, seedTrackingFixture, type TrackingFixture } from './helpers/budgetTrackingFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: TrackingFixture;

beforeAll(async () => { f = await seedTrackingFixture(pool); }, 120_000);
afterAll(async () => {
  try { await dropTrackingFixture(pool, f); } finally { await pool.end(); }
});

const START = '2026-03-01';
const END = '2026-05-31';

interface Out {
  rows: Array<{ account_id: string; budget_amount: number; actual_amount: number }>;
  excludedRows: Array<{ id: string; reason: string; amount: number }>;
  version: { name: string } | null;
  dimension_filter: Record<string, string | null>;
  unallocated_budget?: { income: number; expense: number } | null;
  completenessFault?: string;
}

/** The tool and the engine for the same arguments, in one rolled-back request as app_user. */
function both(args: Record<string, string>, opts: RangeTrackingOptions) {
  return asRequest(pool, f.a, f.userA, async () => {
    const ctx: McpToolContext = { userId: f.userA, companyId: f.a, scopes: ['read:reports'], tokenJti: 'j', oauthAppId: null };
    const res = await budgetVarianceTool.handler({ period_start: START, period_end: END, ...args }, ctx);
    const engine = await buildRangeTracking(f.a, START, END, { ...opts, wholeMonthsOnly: true });
    return { res, engine };
  }, { appUser: true });
}
const parse = (res: { content: Array<{ text: string }>; isError?: boolean }): Out => {
  expect(res.isError, res.content[0]?.text).toBeUndefined();
  return JSON.parse(res.content[0]!.text) as Out;
};

/** Rows are the engine's budgeted lines with its budget and actual; exclusions are its other verdicts. */
function expectEngine(out: Out, engine: Awaited<ReturnType<typeof buildRangeTracking>>): void {
  const budgeted = engine.lines.filter((l) => l.budgetVerdict === 'budgeted');
  expect(out.rows.map((r) => [r.account_id, r.budget_amount, r.actual_amount]))
    .toEqual(budgeted.map((l) => [l.accountId, l.budget, l.actual]));
  const reason = { 'above-filter': 'budget_above_filter', partial: 'budget_partial', unbudgeted: 'no_budget_set' } as const;
  expect(out.excludedRows.map((x) => [x.id, x.reason, x.amount])).toEqual(engine.lines
    .filter((l) => l.budgetVerdict in reason)
    .map((l) => [l.accountId, reason[l.budgetVerdict as keyof typeof reason], l.actual]));
  expect(out.completenessFault).toBeUndefined();
}

describe('budget_variance with a version or a dimension, on a real ledger', () => {
  it('cc1_id: the engine\'s figures, company-level opex named above the filter and unallocated', async () => {
    const { res, engine } = await both({ cc1_id: f.cc.FT }, { cc1Id: f.cc.FT });
    const out = parse(res);
    expectEngine(out, engine);
    expect(out.excludedRows.find((x) => x.id === f.acc.opex)?.reason).toBe('budget_above_filter');
    expect(out.unallocated_budget).toEqual(engine.notices.unallocatedBudget);
    expect(out.unallocated_budget?.expense).toBeGreaterThanOrEqual(600);
    expect(out.dimension_filter).toEqual({ cc1_id: f.cc.FT, cc2_id: null, bu_id: null });
  });

  it('cc2_id and bu_id each reach the engine', async () => {
    for (const [args, opts] of [[{ cc2_id: f.cc.P1 }, { cc2Id: f.cc.P1 }], [{ bu_id: f.bu.B1 }, { buId: f.bu.B1 }]] as const) {
      const { res, engine } = await both(args, opts);
      expectEngine(parse(res), engine);
    }
    // bu B1 holds the interest budget (5 a month); without the filter forwarded it would be company-wide.
    const { res } = await both({ bu_id: f.bu.B1 }, { buId: f.bu.B1 });
    expect(parse(res).rows.find((r) => r.account_id === f.acc.interest)?.budget_amount).toBe(15);
  });

  it('version_id reads that version, draft included', async () => {
    const { res, engine } = await both({ version_id: f.v.reforecast27 }, { versionId: f.v.reforecast27 });
    const out = parse(res);
    expectEngine(out, engine);
    expect(out.version?.name).toBe('Reforecast 1');
    expect(out.rows.find((r) => r.account_id === f.acc.sales)?.budget_amount).toBe(2997);
    expect(out).not.toHaveProperty('unallocated_budget');
  });

  it.each([
    ['a range that cuts a budget month', { period_start: '2026-03-15' }, { splits_budget_month: true }],
    ['a year with no budget', { period_start: '2026-01-01', period_end: '2026-01-31' }, { budget_absent_years: [2026] }],
  ])('%s: no rows, every account accounted for as budget_absent', async (_n, range, says) => {
    const res = await asRequest(pool, f.a, f.userA, () => budgetVarianceTool.handler({ period_start: START, period_end: END, ...range, cc1_id: f.cc.FT },
      { userId: f.userA, companyId: f.a, scopes: ['read:reports'], tokenJti: 'j', oauthAppId: null }), { appUser: true });
    const out = parse(res) as Out & Record<string, unknown>;
    expect(out).toMatchObject(says);
    expect(out.rows).toEqual([]);
    expect(out.excludedRows.length).toBeGreaterThan(0);
    expect(new Set(out.excludedRows.map((x) => x.reason))).toEqual(new Set(['budget_absent']));
    expect(out.completenessFault).toBeUndefined();
  });

  it('another company\'s version or cost centre is a plain miss, carrying none of its figures', async () => {
    for (const args of [{ version_id: f.v.b27 }, { cc1_id: f.cc.BX }, { bu_id: f.bu.BBX }]) {
      const { res } = await asRequest(pool, f.a, f.userA, async () => ({
        res: await budgetVarianceTool.handler({ period_start: START, period_end: END, ...args },
          { userId: f.userA, companyId: f.a, scopes: ['read:reports'], tokenJti: 'j', oauthAppId: null }),
      }), { appUser: true });
      expect(res).toEqual({ content: [{ type: 'text', text: 'Not found' }], isError: true });
    }
  });
});

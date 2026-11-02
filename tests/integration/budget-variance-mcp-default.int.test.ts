/**
 * Budgets P3 PR-C: MCP budget_variance answers BYTE FOR BYTE as it did before
 * `getBudgetVariance` became a facade (a standing constraint: its default
 * output and `figureBasis` must not change). The snapshot beside this file was
 * RECORDED ON origin/master's service (P0's `budgetWindowActuals.ts` and
 * `budgetVarianceService.ts`, f83b3960a) against this fixture, then committed;
 * this test compares the facade's answer with it, text for text.
 *
 * Windows: single-year, day-level edges, a year with no version, multi-year ones
 * P0 sums (a year with no budget in it; lines budgeted in one year only), three
 * years, the summary detail. The fixture's random ids are replaced by names
 * before comparing; nothing else is touched.
 *
 * Seed: helpers/budgetTrackingFixture.ts. Fixture route: isaflow_schema_fixture
 * (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { budgetVarianceTool } from '@/lib/mcp/tools/budgetVariance';
import type { McpToolContext } from '@/lib/mcp/types';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { asRequest, dropTrackingFixture, seedTrackingFixture, type TrackingFixture } from './helpers/budgetTrackingFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: TrackingFixture;

beforeAll(async () => { f = await seedTrackingFixture(pool); }, 120_000);
afterAll(async () => {
  try { await dropTrackingFixture(pool, f); } finally { await pool.end(); }
});

/** The fixture's random ids, named, so the snapshot holds across seeds. */
function named(text: string): string {
  const names: Array<[string, string]> = [
    ...Object.entries(f.acc).map(([k, v]) => [v, `<acc.${k}>`] as [string, string]),
    [f.a, '<company.a>'], [f.b, '<company.b>'],
  ];
  return names.reduce((t, [id, name]) => t.split(id).join(name), text);
}

const WINDOWS: Array<[string, Record<string, string>]> = [
  ['FY2027 whole', { period_start: '2026-03-01', period_end: '2027-04-30' }],
  ['day-level edges', { period_start: '2026-03-16', period_end: '2026-10-29' }],
  ['FY2026, no version', { period_start: '2026-01-01', period_end: '2026-02-28' }],
  ['across FY2026 and FY2027', { period_start: '2026-01-01', period_end: '2026-06-30' }],
  ['across FY2027 and FY2028', { period_start: '2027-04-01', period_end: '2027-05-31' }],
  ['three years', { period_start: '2026-02-15', period_end: '2027-06-15' }],
  ['summary detail', { period_start: '2026-03-01', period_end: '2026-08-31', detail: 'summary' }],
];

describe('MCP budget_variance: unchanged by the facade', () => {
  it('answers every window exactly as the pre-facade service did (snapshot recorded on master)', async () => {
    const ctx: McpToolContext = { userId: f.userA, companyId: f.a, scopes: ['read:reports'], tokenJti: 'j', oauthAppId: null };
    const out: Record<string, string> = {};
    for (const [name, args] of WINDOWS) {
      const res = await asRequest(pool, f.a, f.userA, () => budgetVarianceTool.handler(args, ctx));
      expect(res.isError, name).toBeUndefined();
      out[name] = named(res.content[0]!.text);
    }
    expect(Object.values(out).every((t) => t.includes('"figureBasis":"budget.actual.v1"'))).toBe(true);
    await expect(`${JSON.stringify(out, null, 1)}\n`).toMatchFileSnapshot('./__snapshots__/budget-variance-mcp-default.json');
  });
});

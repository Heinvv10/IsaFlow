/**
 * Budgets P3 PR-C review r4 (R4-3), on real PostgreSQL: the members ("Bullets by cost centre") partition Net
 * Profit, so they carry no budget whenever Net Profit has none. Under the final R9 rule that is also the case
 * when a band has actuals and NO budget (no partial line, no version gap): the old wiring only looked for
 * partial lines, and left a one-sided member profit budget beside an NP of "—".
 * Seed: helpers/budgetTrackingFixture.ts. Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { asRequest, dropTrackingFixture, seedTrackingFixture, type TrackingFixture } from './helpers/budgetTrackingFixture';
import { buildBudgetTrackingReport } from '@/modules/accounting/services/budgets/tracking/budgetTrackingService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: TrackingFixture;
const NOW = new Date('2026-11-15T10:00:00+02:00');
const WINDOW = { period: 'custom' as const, from: '2026-03', to: '2026-08', groupBy: 'cc1' as const };

beforeAll(async () => { f = await seedTrackingFixture(pool); }, 120_000);
afterAll(async () => {
  try { await dropTrackingFixture(pool, f); } finally { await pool.end(); }
});

describe('members follow Net Profit', () => {
  it('control: every band with actuals is budgeted, so NP has a budget and the members keep theirs', async () => {
    const r = await asRequest(pool, f.a, f.userA, () => buildBudgetTrackingReport(f.a, WINDOW, NOW));
    expect(r.bands.find((b) => b.key === 'net_profit')!.budget).not.toBeNull();
    expect(r.members!.some((m) => m.budget !== null)).toBe(true);
  });

  it('a band with actuals and no budget makes NP absent, and every member budget with it', async () => {
    const r = await asRequest(pool, f.a, f.userA, () => buildBudgetTrackingReport(f.a, WINDOW, NOW), {
      before: (c) => c.query('DELETE FROM budget_month_amounts WHERE company_id = $1 AND gl_account_id = $2', [f.a, f.acc.cos]),
    });
    expect(r.bands.find((b) => b.key === 'cost_of_sales')!.budget).toBeNull();
    expect(r.bands.find((b) => b.key === 'net_profit')!.budget).toBeNull();
    expect(r.members!.length).toBeGreaterThan(1);
    for (const m of r.members!) expect([m.name, m.budget, m.variance, m.favourable]).toEqual([m.name, null, null, null]);
  });
});

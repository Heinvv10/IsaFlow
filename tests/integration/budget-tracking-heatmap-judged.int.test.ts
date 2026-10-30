/**
 * Budgets P3 PR-B review r3 M1, on real PostgreSQL: the heatmap judges a month only once it is
 * complete. The projection cutoff is clamped up to FY*.start - 1 day, so on a custom window from the
 * month in progress into a FUTURE FY* the cutoff's month would judge the month in progress; the
 * engine's `projection.judgedThrough` is min(cutoff month, the month before today's).
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { asRequest, dropTrackingFixture, seedTrackingFixture, type TrackingFixture } from './helpers/budgetTrackingFixture';
import { buildBudgetTrackingReport } from '@/modules/accounting/services/budgets/tracking/budgetTrackingService';
import { heatmapSummary } from '@/components/accounting/budgets/tracking/trackingChartSummaries';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: TrackingFixture;
// 15 April 2027: April (FY2027's last month) is in progress; FY2028 starts 1 May 2027.
const NOW = new Date('2027-04-15T10:00:00+02:00');
beforeAll(async () => { f = await seedTrackingFixture(pool); }, 120_000);
afterAll(async () => { try { await dropTrackingFixture(pool, f); } finally { await pool.end(); } });

it('custom 2027-03..2027-07: the in-progress month (2027-04) is not judged by the heatmap', async () => {
  const r = await asRequest(pool, f.a, f.userA, () => buildBudgetTrackingReport(f.a, { period: 'custom', from: '2027-03', to: '2027-07' }, NOW));
  expect(r.window.inProgress?.month).toBe('2027-04');
  // The cutoff is clamped to FY2028's start - 1 (30 April 2027), past the month in progress.
  expect(r.projection.cutoff).toBe('2027-04-30');
  const judgedThrough = r.projection.judgedThrough; // what BudgetTrackingVisuals passes
  expect(judgedThrough).toBe('2027-03');
  const summary = heatmapSummary(r.lines, r.window.months, judgedThrough);
  expect(summary).toContain('Apr 2027 to Jul 2027 not yet judged');
});

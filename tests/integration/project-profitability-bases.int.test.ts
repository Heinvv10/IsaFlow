/**
 * Project Profitability against a real database, on both project bases
 * (Hein, 2026-10-10): `jobs` (the default — jl.project_id against `projects`,
 * master's behaviour) and `cc2` (jl.cc2_id against cost centres). Each basis is
 * company-scoped on every table, P&L accounts only, keeps a foreign project in
 * its own unnamed bucket, and never reads the other basis's ids. Replaces the
 * SQL-text regexes of the old unit test projectProfitabilityCc2.test.ts.
 *
 * Seed: helpers/glDimensionFixture.ts (April 2025, company A). The job-keyed
 * suites that predate the cc2 basis — invoice-line-revenue-posting and
 * k051-reversal-foreign-dimension — still pin the default. Disposable
 * databases only — the suite skips elsewhere.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { dropGlDimensionFixture, seedGlDimensionFixture, type GlDimFixture } from './helpers/glDimensionFixture';
import {
  getProjectProfitability,
  getProjectTaggingCoverage,
} from '@/modules/accounting/services/reports/projectProfitabilityService';

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
const FROM = '2025-04-01';
const TO = '2025-04-30';

describeIfDisposable('project profitability on a real ledger', () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let f: GlDimFixture;

  beforeAll(async () => { f = await seedGlDimensionFixture(pool, `pp-${Date.now()}`); }, 60_000);
  afterAll(async () => { await dropGlDimensionFixture(pool, f); await pool.end(); });

  const summary = (reports: Awaited<ReturnType<typeof getProjectProfitability>>) =>
    reports.map((r) => [r.projectId, r.projectName, r.revenue, r.costs, r.profit]);

  it('jobs (the default): one report per job, A\'s posted P&L lines only, a foreign job unnamed', async () => {
    const reports = await getProjectProfitability(f.a, FROM, TO);
    expect(summary(reports)).toEqual([
      [f.job.JB, 'Unknown Project', 0, 1, -1],
      [f.job.J2, 'Job Two', -100, 0, -100],
      [f.job.J1, 'Job One', 0, 300, -300],
    ]);
    expect(await getProjectProfitability(f.a, FROM, TO, 'jobs')).toEqual(reports);
    expect(JSON.stringify(reports)).not.toContain('SECRET');
  });

  it('cc2: one report per CC2 project, same scoping, never a job id', async () => {
    const reports = await getProjectProfitability(f.a, FROM, TO, 'cc2');
    expect(summary(reports)).toEqual([
      [f.cc.BP, 'Unknown Project', 0, 1, -1],
      [f.cc.P1, 'P1 — Project 1', -100, 0, -100],
      [f.cc.P2, 'P2 — Project 2', 0, 340, -340],
    ]);
    // The CC2-tagged bank line of E09 is not a project cost, and E04's
    // balance-sheet-only CC2 is not a project at all.
    expect(reports.find((r) => r.projectId === f.cc.P2)!.costLines.map((l) => l.accountCode)).toEqual(['6000']);
    expect(JSON.stringify(reports)).not.toContain('SECRET');
  });

  it('the coverage counts A\'s P&L lines tagged on the same basis', async () => {
    const jobs = await getProjectTaggingCoverage(f.a, FROM, TO);
    expect([jobs.taggedLines, jobs.untaggedLines]).toEqual([3, 14]);
    expect(jobs.untaggedAmount).toBeCloseTo(793.03, 2);
    const cc2 = await getProjectTaggingCoverage(f.a, FROM, TO, 'cc2');
    expect([cc2.taggedLines, cc2.untaggedLines]).toEqual([4, 13]);
    expect(cc2.untaggedAmount).toBeCloseTo(753.03, 2);
  });
});

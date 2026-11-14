/**
 * Trial counts leave out deleted and internal companies (PR #1367 review M3):
 * the Trials stats, the billing overview's trial_count and the health
 * widget's "expiring in 7 days" all come from trialQueries.ts, which marks a
 * company `internal` by the metrics module's companyOutOfMetrics.
 *   L  live trial company, trial ends in 3 days    -> listed, counted
 *   M  is_demo trial company, trial ends in 3 days -> listed as internal, not counted
 *   N  deleted company, trial ends in 3 days       -> neither listed nor counted
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import healthRoute from '../../pages/api/admin/health';
import { getBillingOverview } from '@/modules/admin/services/billingService';
import { getAllTrials, getTrialStats } from '@/modules/admin/services/trialQueries';
import { callRoute, ok, pool } from './admin-metrics.helpers';

const tag = crypto.randomUUID().slice(0, 8);
const admin = crypto.randomUUID();
const ids = { L: crypto.randomUUID(), M: crypto.randomUUID(), N: crypto.randomUUID() };
const endsAt = new Date(Date.now() + 3 * 86_400_000);
const health = async () =>
  ok<{ trials: { expiring_in_7d: number } }>(await callRoute(healthRoute, { sub: admin, method: 'GET' })).trials.expiring_in_7d;
const counts = async () => {
  const [stats, overview, expiring] = await Promise.all([getTrialStats(), getBillingOverview(), health()]);
  return { total: stats.total_trials, active: stats.active_trials, week: stats.expiring_this_week, overview: overview.trial_count, expiring };
};
let before: Awaited<ReturnType<typeof counts>>;

beforeAll(async () => {
  await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'super_admin', true)`, [admin, `${admin}@test.local`]);
  before = await counts();
  for (const [letter, status, isDemo] of [['L', 'active', false], ['M', 'active', true], ['N', 'deleted', false]] as const) {
    await pool.query(`INSERT INTO companies (id, name, status, is_demo, trial_ends_at) VALUES ($1, $2, $3, $4, $5)`,
      [ids[letter], `WP8T ${letter} ${tag}`, status, isDemo, endsAt]);
  }
});

afterAll(async () => {
  await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [Object.values(ids)]);
  await pool.query('DELETE FROM admin_audit_log WHERE admin_user_id = $1', [admin]);
  await pool.query('DELETE FROM users WHERE id = $1', [admin]);
});

describe('trial counts exclude internal and deleted companies (M3)', () => {
  it('stats, overview trial_count and health expiring_in_7d each move by the live company only', async () => {
    const after = await counts();
    expect({
      total: after.total - before.total, active: after.active - before.active, week: after.week - before.week,
      overview: after.overview - before.overview, expiring: after.expiring - before.expiring,
    }).toEqual({ total: 1, active: 1, week: 1, overview: 1, expiring: 1 });
  });

  it('the Trials table lists the demo company as internal (so it can be managed) and never a deleted one', async () => {
    const listed = await getAllTrials();
    const row = (id: string) => listed.find((t) => t.id === id);
    expect(row(ids.L)?.internal).toBe(false);
    expect(row(ids.M)?.internal).toBe(true);
    expect(row(ids.N)).toBeUndefined();
  });
});

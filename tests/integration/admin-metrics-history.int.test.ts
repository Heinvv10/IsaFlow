/**
 * Revenue history (PR #1367 review H1). A trial is converted IN PLACE, so
 * its row's created_at is the trial start: MRR history must count it from the
 * conversion (the `trial.convert_to_paid` audit row), else from the trial end.
 *
 * Shapes (monthly plan R10 = 1 000 cents of MRR per unit below):
 *   T  trial row created 20 days ago, converted 5 days ago (audit row)  x1
 *   U  trial row created 20 days ago, trial ended 3 days ago, no audit  x2
 *   V  trial still running (ends in 10 days), row already active        x4
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTrends } from '@/modules/admin/services/analyticsService';
import { loadSubscriptionFacts } from '@/modules/admin/services/metrics/metricsSql';
import { pool } from './admin-metrics.helpers';

const DAY = 86_400_000;
const tag = crypto.randomUUID().slice(0, 8);
const admin = crypto.randomUUID();
const ids = { T: crypto.randomUUID(), U: crypto.randomUUID(), V: crypto.randomUUID() };
const now = Date.now();
const at = (daysAgo: number) => new Date(now - daysAgo * DAY);
let planId = '';
let trendBefore: Awaited<ReturnType<typeof getTrends>>['mrr_trend'];

async function company(id: string, letter: string, trialEndsAt: Date | null) {
  await pool.query(`INSERT INTO companies (id, name, status, created_at, trial_ends_at) VALUES ($1, $2, 'active', $3, $4)`,
    [id, `WP8H ${letter} ${tag}`, at(80), trialEndsAt]);
}
async function sub(companyId: string, created: Date, plan = planId) {
  await pool.query(`INSERT INTO subscriptions (company_id, plan_id, status, billing_cycle, created_at)
    VALUES ($1, $2, 'active', 'monthly', $3)`, [companyId, plan, created]);
}

beforeAll(async () => {
  trendBefore = (await getTrends()).mrr_trend;
  await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'super_admin', true)`, [admin, `${admin}@test.local`]);
  planId = (await pool.query(`INSERT INTO plans (code, name, monthly_price_cents, annual_price_cents) VALUES ($1, $2, 1000, 10000) RETURNING id`,
    [`wp8h-${tag}`, `WP8H ${tag}`])).rows[0].id as string;
  const double = (await pool.query(`INSERT INTO plans (code, name, monthly_price_cents, annual_price_cents) VALUES ($1, $2, 2000, 20000) RETURNING id`,
    [`wp8h2-${tag}`, `WP8H2 ${tag}`])).rows[0].id as string;
  const quad = (await pool.query(`INSERT INTO plans (code, name, monthly_price_cents, annual_price_cents) VALUES ($1, $2, 4000, 40000) RETURNING id`,
    [`wp8h4-${tag}`, `WP8H4 ${tag}`])).rows[0].id as string;
  await company(ids.T, 'T', at(15)); await sub(ids.T, at(20));
  await pool.query(`INSERT INTO admin_audit_log (admin_user_id, action, target_type, target_id, created_at)
    VALUES ($1, 'trial.convert_to_paid', 'company', $2, $3)`, [admin, ids.T, at(5)]);
  await company(ids.U, 'U', at(3)); await sub(ids.U, at(20), double);
  await company(ids.V, 'V', new Date(now + 10 * DAY)); await sub(ids.V, at(2), quad);
});

afterAll(async () => {
  const all = Object.values(ids);
  await pool.query('DELETE FROM subscriptions WHERE company_id = ANY($1::uuid[])', [all]);
  await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [all]);
  await pool.query(`DELETE FROM plans WHERE code LIKE $1`, [`wp8h%-${tag}`]);
  await pool.query('DELETE FROM admin_audit_log WHERE admin_user_id = $1', [admin]);
  await pool.query('DELETE FROM users WHERE id = $1', [admin]);
});

describe('a converted trial earns from its conversion (H1)', () => {
  it('the facts reader dates each row: audit conversion, else trial end, never later than now', async () => {
    const facts = (await loadSubscriptionFacts()).filter((f) => Object.values(ids).includes(f.company_id));
    const from = (id: string) => facts.find((f) => f.company_id === id)!.mrr_from.getTime();
    expect(Math.abs(from(ids.T) - at(5).getTime())).toBeLessThan(1_000);
    expect(Math.abs(from(ids.U) - at(3).getTime())).toBeLessThan(1_000);
    expect(Math.abs(from(ids.V) - Date.now())).toBeLessThan(60_000);
  });

  it('the MRR trend adds T only from its conversion and U only from its trial end', async () => {
    const after = (await getTrends()).mrr_trend;
    const delta = (back: number) => after.at(-1 - back)!.mrr_cents - trendBefore.at(-1 - back)!.mrr_cents;
    expect(delta(10)).toBe(0);      // both still trials
    expect(delta(4)).toBe(1_000);   // T converted 5 days ago
    expect(delta(1)).toBe(3_000);   // U's trial ended 3 days ago
    expect(delta(0)).toBe(7_000);   // and V, active now
  });
});

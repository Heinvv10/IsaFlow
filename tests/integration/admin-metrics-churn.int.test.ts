/**
 * Churn uses the MRR population and live rule (PR #1367 review M1): of the
 * companies paying when the SAST month began, those paying nothing now. A
 * deleted company's cancellation is not churn on the admin site, as its
 * revenue was never in MRR.
 *   X  paying for 70 days, cancelled this month   -> churned
 *   Y  the same, but the company is deleted        -> not counted
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getRevenueIntelligence } from '@/modules/admin/services/revenueService';
import { sastMonthStartFrom } from '@/modules/admin/services/metrics/timeSeriesMath';
import { pool } from './admin-metrics.helpers';

const tag = crypto.randomUUID().slice(0, 8);
const ids = { X: crypto.randomUUID(), Y: crypto.randomUUID() };
const created = new Date(Date.now() - 70 * 86_400_000);
// This SAST month, and before now: an hour ago, or a minute into the month if that is later.
const cancelled = new Date(Math.max(Date.now() - 3_600_000, sastMonthStartFrom(new Date(), 0).getTime() + 60_000));
let planId = '';
let before: Awaited<ReturnType<typeof getRevenueIntelligence>>['churn_trend'];

beforeAll(async () => {
  before = (await getRevenueIntelligence()).churn_trend;
  planId = (await pool.query(`INSERT INTO plans (code, name, monthly_price_cents, annual_price_cents) VALUES ($1, $2, 1000, 10000) RETURNING id`,
    [`wp8c-${tag}`, `WP8C ${tag}`])).rows[0].id as string;
  for (const [letter, status] of [['X', 'active'], ['Y', 'deleted']] as const) {
    const id = ids[letter];
    await pool.query(`INSERT INTO companies (id, name, status, created_at) VALUES ($1, $2, $3, $4)`, [id, `WP8C ${letter} ${tag}`, status, created]);
    await pool.query(`INSERT INTO subscriptions (company_id, plan_id, status, billing_cycle, created_at, cancelled_at)
      VALUES ($1, $2, 'cancelled', 'monthly', $3, $4)`, [id, planId, created, cancelled]);
  }
});

afterAll(async () => {
  await pool.query('DELETE FROM subscriptions WHERE company_id = ANY($1::uuid[])', [Object.values(ids)]);
  await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [Object.values(ids)]);
  await pool.query('DELETE FROM plans WHERE id = $1', [planId]);
});

describe('churn uses the MRR population (M1)', () => {
  it("this month: a live company's cancellation is churn, a deleted company's is not; SAST month label", async () => {
    const after = (await getRevenueIntelligence()).churn_trend;
    const month = `${new Date(Date.now() + 2 * 3_600_000).toISOString().slice(0, 7)}-01`;
    expect(after.at(-1)!.month).toBe(month);
    expect(after.at(-1)!.churned_companies - before.at(-1)!.churned_companies).toBe(1);
  });
});

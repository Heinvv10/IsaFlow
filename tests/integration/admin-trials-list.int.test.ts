/**
 * Admin audit 1.13 (and 2.2, E-1, code-2 #6): the Trials page lists expired
 * trials with a true state, "+N days" on an expired trial runs from today, and
 * the stats cards, the billing overview and the health widget count trials from
 * one definition.
 *
 * On master `/api/admin/trials` only ever returned trials ending in the future,
 * the stats counted every company with a trial_ends_at as a "trial", the
 * overview counted `subscriptions.status = 'trial'` rows and health counted
 * `companies.status = 'trial'` (a status provisioning never sets).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import trialsRoute from '../../pages/api/admin/trials';
import statsRoute from '../../pages/api/admin/trials/stats';
import overviewRoute from '../../pages/api/admin/billing/overview';
import healthRoute from '../../pages/api/admin/health';
import bulkRoute from '../../pages/api/admin/companies/bulk-action';
import {
  asAdmin, companyRow, makeCompany, nowSkewSeconds, pool, seedPlans, startAdmin, stopAdmin, subsOf, tag, type TrialPlans,
} from './admin-trials.helpers';

interface Row { id: string; name: string; trial_state: string; days_left: number; plan_name: string | null; status: string }
interface Stats { total_trials: number; active_trials: number; expiring_this_week: number; expired_unpaid: number;
  converted_this_month: number; conversion_rate_percent: number }

let plans: TrialPlans;
const ids: Record<string, string> = {};
let before: { stats: Stats; overview: number; health: number };

const data = <T>(r: { status: number; body: unknown }): T => {
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return (r.body as { data: T }).data;
};
const listAll = async () => data<Row[]>(await asAdmin(trialsRoute, 'GET', { query: { scope: 'all' } }));
const counts = async () => ({
  stats: data<Stats>(await asAdmin(statsRoute, 'GET')),
  overview: data<{ trial_count: number }>(await asAdmin(overviewRoute, 'GET')).trial_count,
  health: data<{ trials: { expiring_in_7d: number } }>(await asAdmin(healthRoute, 'GET')).trials.expiring_in_7d,
});

beforeAll(async () => {
  await startAdmin();
  plans = await seedPlans();
  before = await counts();
  const trialSub = { plan: plans.trial, status: 'trial' };
  ids.running = await makeCompany({ name: 'List running', endsInDays: 3, sub: trialSub });
  ids.later = await makeCompany({ name: 'List twenty days', endsInDays: 20, sub: trialSub });
  ids.hours = await makeCompany({ name: 'List twelve hours', endsInDays: 0.5, sub: trialSub });
  ids.expired = await makeCompany({ name: 'List expired', endsInDays: -20, sub: trialSub });
  ids.converted = await makeCompany({ name: 'List converted', endsInDays: -30, sub: { plan: plans.paid, status: 'active', periodEndDays: 10 } });
  ids.suspended = await makeCompany({ name: 'List suspended expired', endsInDays: -5, status: 'suspended', sub: trialSub });
  ids.activeOnTrialPlan = await makeCompany({ name: 'List active on trial plan', endsInDays: -60,
    sub: { plan: plans.trial, status: 'active', periodEndDays: -45 } });
  ids.deleted = await makeCompany({ name: 'List deleted', endsInDays: 2, status: 'deleted', sub: trialSub });
}, 60000);

afterAll(async () => {
  try { await stopAdmin(); } finally { await pool.end(); }
}, 60000);

describe('the trials list', () => {
  it('scope=all returns expired and converted trials with their true state, never a deleted company', async () => {
    const rows = await listAll();
    const mine = new Map(rows.filter((r) => r.name.endsWith(tag)).map((r) => [r.id, r]));
    expect(mine.has(ids.deleted)).toBe(false);
    expect(mine.size).toBe(7);
    expect(mine.get(ids.running)?.trial_state).toBe('active');
    expect(mine.get(ids.hours)?.trial_state).toBe('active');
    expect(mine.get(ids.later)?.trial_state).toBe('active');
    expect(mine.get(ids.expired)?.trial_state).toBe('expired');
    expect(mine.get(ids.suspended)?.trial_state).toBe('expired');
    expect(mine.get(ids.converted)?.trial_state).toBe('converted');
    // "active" on the free trial plan is not a paying customer: it shows as the expired trial it is.
    expect(mine.get(ids.activeOnTrialPlan)?.trial_state).toBe('expired');
    expect(mine.get(ids.converted)?.plan_name).toBe('WP2 Pro');
  }, 30000);

  it('twelve hours left is "1 day left", not expired; an expired trial has a non-positive count', async () => {
    const rows = await listAll();
    const get = (id: string) => rows.find((r) => r.id === id)!;
    expect(get(ids.hours).days_left).toBe(1);
    expect(get(ids.running).days_left).toBe(3);
    expect(get(ids.expired).days_left).toBeLessThanOrEqual(0);
  }, 30000);

  it('within=7 (the dashboard) lists only unconverted trials still running, soonest first', async () => {
    const rows = data<Row[]>(await asAdmin(trialsRoute, 'GET', { query: { within: '7' } }))
      .filter((r) => r.name.endsWith(tag));
    expect(rows.map((r) => r.id)).toEqual([ids.hours, ids.running]);
    expect(rows[0]!.days_left).toBe(1);
  }, 30000);
});

describe('one definition of a trial', () => {
  it('the stats, the billing overview and the health widget agree with the list', async () => {
    const after = await counts();
    const d = (n: number, b: number) => n - b;
    expect(d(after.stats.total_trials, before.stats.total_trials)).toBe(7);
    expect(d(after.stats.active_trials, before.stats.active_trials)).toBe(3);
    expect(d(after.stats.expiring_this_week, before.stats.expiring_this_week)).toBe(2);
    expect(d(after.stats.expired_unpaid, before.stats.expired_unpaid)).toBe(3);
    expect(d(after.overview, before.overview)).toBe(3); // running trials, whenever they end
    expect(d(after.health, before.health)).toBe(2); // only those ending within 7 days
  }, 60000);
});

describe('extending a trial', () => {
  it('an expired trial restarts from today: +7 days ends in 7 days, and its trial subscription follows', async () => {
    const r = await asAdmin(trialsRoute, 'POST', { body: { company_id: ids.expired, days: 7 } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const co = await companyRow(ids.expired);
    expect(nowSkewSeconds(co.trial_ends_at!, 7 * 86400)).toBeLessThan(120);
    const sub = (await subsOf(ids.expired))[0];
    expect(new Date(sub.current_period_end).getTime()).toBe(co.trial_ends_at!.getTime());
    const row = (await listAll()).find((x) => x.id === ids.expired)!;
    expect(row.trial_state).toBe('active');
  }, 30000);

  it('a running trial extends from its own end date', async () => {
    const before3 = (await companyRow(ids.running)).trial_ends_at!;
    const r = await asAdmin(trialsRoute, 'POST', { body: { company_id: ids.running, days: 7 } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const after = (await companyRow(ids.running)).trial_ends_at!;
    expect(Math.round((after.getTime() - before3.getTime()) / 1000)).toBe(7 * 86400);
  }, 30000);

  it('bulk extend (trials route) restarts an expired trial from today', async () => {
    const r = await asAdmin(trialsRoute, 'POST', { body: { company_ids: [ids.suspended, ids.deleted], days: 3 } });
    expect(data<{ extended: number }>(r).extended).toBe(1);
    expect(nowSkewSeconds((await companyRow(ids.suspended)).trial_ends_at!, 3 * 86400)).toBeLessThan(120);
    expect(new Date((await subsOf(ids.suspended))[0].current_period_end).getTime())
      .toBe((await companyRow(ids.suspended)).trial_ends_at!.getTime());
  }, 30000);

  it('bulk extend (companies bulk-action) also runs from today and skips a deleted company, counting only what moved', async () => {
    const gone = (await companyRow(ids.deleted)).trial_ends_at!;
    const r = await asAdmin(bulkRoute, 'POST', { body: { action: 'extend_trial', company_ids: [ids.activeOnTrialPlan, ids.deleted], days: 5 } });
    const out = data<{ processed: number; errors: string[] }>(r);
    expect(out.processed).toBe(1);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toContain(ids.deleted);
    expect(nowSkewSeconds((await companyRow(ids.activeOnTrialPlan)).trial_ends_at!, 5 * 86400)).toBeLessThan(120);
    expect((await companyRow(ids.deleted)).trial_ends_at!.getTime()).toBe(gone.getTime());
  }, 30000);
});

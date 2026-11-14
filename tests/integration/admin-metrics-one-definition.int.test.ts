/**
 * Admin audit 2.1, 2.3, 2.6, 2.9, 2.10: one MRR definition everywhere (goal
 * §2a). Active subscriptions only, discount applied, annual / 12, never a
 * deleted or suspended company or the Demo tenant; trials never in MRR;
 * ARPU = MRR / paying companies; ARR summed from unrounded amounts.
 *
 * On master the billing overview and dashboard counted deleted/suspended/demo
 * companies, revenue, trends and the plan tables counted trials and ignored
 * the discount, the company list and subscription list ignored the discount,
 * and ARR was a rounded MRR x 12. Fixture shapes: admin-metrics.helpers.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getBillingOverview, listSubscriptions } from '@/modules/admin/services/billingService';
import { getDashboardStats } from '@/modules/admin/services/adminDashboardService';
import { getRevenueIntelligence } from '@/modules/admin/services/revenueService';
import { getTrends, getUsageAnalytics } from '@/modules/admin/services/analyticsService';
import { getCompanyDetail, listCompanies } from '@/modules/admin/services/adminCompanyService';
import { cleanup, flagNames, ids, planNames, seed, tag } from './admin-metrics.helpers';

type Overview = Awaited<ReturnType<typeof getBillingOverview>> & { paying_companies?: number };
let before: Overview;

beforeAll(async () => {
  before = await getBillingOverview();
  await seed();
});
afterAll(cleanup);

describe('one MRR definition (goal §2a)', () => {
  it('billing overview: MRR, ARR, paying companies and active subscriptions move by exactly the fixture', async () => {
    const after: Overview = await getBillingOverview();
    expect(after.mrr_cents - before.mrr_cents).toBe(104_700);
    expect(after.arr_cents - before.arr_cents).toBe(1_256_400);
    expect((after.paying_companies ?? NaN) - (before.paying_companies ?? NaN)).toBe(3);
    // A, B, C (two), H, K: the R0 subscriptions are active but pay nothing.
    expect(after.active_subscriptions - before.active_subscriptions).toBe(6);
    expect(after.arpu_cents).toBe(after.mrr_cents === 0 ? null : Math.round(after.mrr_cents / (after.paying_companies ?? NaN)));
  });

  it('dashboard, analytics trend, revenue intelligence and the overview agree', async () => {
    const [overview, dash, trends, revenue] = await Promise.all([
      getBillingOverview(), getDashboardStats(), getTrends(), getRevenueIntelligence(),
    ]);
    expect(dash.mrr_cents).toBe(overview.mrr_cents);
    expect(dash.arr_cents).toBe(overview.arr_cents);
    expect(trends.mrr_trend.at(-1)?.mrr_cents).toBe(overview.mrr_cents);
    expect(revenue.arpu_cents).toBe(overview.arpu_cents);
  });

  it('plan breakdown and revenue by plan: paying companies only, discount applied', async () => {
    const [revenue, usage] = await Promise.all([getRevenueIntelligence(), getUsageAnalytics()]);
    const breakdown = revenue.plan_breakdown.filter((r) => r.plan_name.endsWith(tag))
      .map((r) => ({ plan: r.plan_name, cycle: r.billing_cycle, n: r.company_count, mrr: r.mrr_cents, arr: r.arr_cents }));
    expect(breakdown).toEqual([
      // B + C's two: 3 x 29 900 000 units = 74 750 MRR, 897 000 ARR.
      { plan: planNames.starter, cycle: 'annual', n: 2, mrr: 74_750, arr: 897_000 },
      { plan: planNames.pro, cycle: 'monthly', n: 1, mrr: 29_950, arr: 359_400 },
    ]);
    const byPlan = usage.revenue_by_plan.filter((r) => r.plan_name.endsWith(tag))
      .map((r) => ({ plan: r.plan_name, n: r.company_count, mrr: r.mrr_cents }));
    expect(byPlan).toEqual([
      { plan: planNames.starter, n: 2, mrr: 74_750 },
      { plan: planNames.pro, n: 1, mrr: 29_950 },
    ]);
  });

  it('company list: each company once, its own MRR by the same rule', async () => {
    const list = await listCompanies({ search: tag, limit: 100 });
    const mrr = Object.fromEntries(list.items.map((c) => [c.name.split(' ')[1], c.mrr_cents]));
    expect(list.items.map((c) => c.id).length).toBe(new Set(list.items.map((c) => c.id)).size);
    expect(mrr).toEqual({ A: 29_950, B: 24_917, C: 49_833, D: 0, F: 0, G: 0, H: 0, K: 0 });
    expect(list.total).toBe(8);
  });

  it('company detail: MRR by the same rule and the billing cycle of the current subscription', async () => {
    const a = (await getCompanyDetail(ids.A)) as unknown as { mrr_cents: number; billing_cycle?: string };
    expect(a.mrr_cents).toBe(29_950);
    expect(a.billing_cycle).toBe('monthly');
    const b = (await getCompanyDetail(ids.B)) as unknown as { billing_cycle?: string };
    expect(b.billing_cycle).toBe('annual');
  });

  it('subscription list: the amount shown is after the discount', async () => {
    const subs = await listSubscriptions({ company_id: ids.A });
    expect(subs.items.map((s) => s.monthly_amount_cents)).toEqual([29_950]);
  });
});

describe('feature adoption counts effective access (audit 2.6)', () => {
  it('plan and override grant it, a global flag reaches every live company', async () => {
    const usage = await getUsageAnalytics();
    const row = (name: string) => usage.feature_adoption.find((f) => f.feature === name);
    // A through Pro, B by override; E (deleted, on Pro) and G (demo, on Pro) are not counted.
    expect(row(flagNames.planned)?.user_count).toBe(2);
    expect(row(flagNames.global)?.adoption_percent).toBe(100);
  });
});

describe('cohort retention (audit 2.4)', () => {
  it('shows no month that has not ended and a real M0', async () => {
    const { cohort_retention: rows } = await getRevenueIntelligence();
    const sastNow = new Date(Date.now() + 2 * 3_600_000);
    const thisMonth = `${sastNow.toISOString().slice(0, 7)}-01`;
    const current = rows.find((r) => r.cohort_month === thisMonth);
    expect(current, JSON.stringify(rows)).toBeDefined();
    expect([current!.m0_pct, current!.m1_pct, current!.m2_pct, current!.m3_pct]).toEqual([null, null, null, null]);
    const previous = rows.at(rows.indexOf(current!) - 1)!;
    expect(previous.cohort_month < thisMonth).toBe(true);
    expect(previous.m0_pct).toBeGreaterThan(0);
    expect([previous.m1_pct, previous.m2_pct, previous.m3_pct]).toEqual([null, null, null]);
  });
});

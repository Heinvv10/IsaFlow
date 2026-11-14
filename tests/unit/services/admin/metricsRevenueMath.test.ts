/**
 * Pure revenue arithmetic of the admin metrics module (audit 2.1, 2.3, 2.10).
 * Every expectation is worked by hand in the comment beside it.
 */
import { describe, expect, it } from 'vitest';
import {
  averageChurnRate, ltvEstimateCents, netRevenueRetention, percentOrNull, planBreakdown,
  revenueAt, revenueByPlan, summariseRevenue, type SubscriptionFact,
} from '@/modules/admin/services/metrics/revenueMath';

const T0 = new Date('2026-09-01T00:00:00Z');
let n = 0;
function fact(over: Partial<SubscriptionFact> & { company_id: string; annual_units: number }): SubscriptionFact {
  n += 1;
  const status = over.status ?? 'active';
  const company_excluded = over.company_excluded ?? false;
  return {
    id: `s${n}`, plan_id: 'p-starter', plan_name: 'Starter', billing_cycle: 'annual',
    created_at: T0, cancelled_at: null, status, company_excluded,
    counts_toward_mrr: status === 'active' && !company_excluded,
    ...over,
  };
}
// Starter annual R2 990.00 = 299 000 cents -> 29 900 000 units (x100, no discount).
const STARTER_ANNUAL = 29_900_000;
// Pro monthly R599 at 50% off: 59 900 x 12 x 50 = 35 940 000 units.
const PRO_MONTHLY_HALF = 35_940_000;

describe('summariseRevenue', () => {
  it('rounds MRR and ARR once over the sum, not per subscription', () => {
    const r = summariseRevenue([
      fact({ company_id: 'a', annual_units: STARTER_ANNUAL }),
      fact({ company_id: 'b', annual_units: STARTER_ANNUAL }),
    ]);
    // 59 800 000 / 1200 = 49 833.33 -> 49 833 (per-row rounding gave 24 917 x 2 = 49 834).
    expect(r.mrr_cents).toBe(49_833);
    // 59 800 000 / 100 = 598 000 exactly (rounded MRR x 12 gave 598 008).
    expect(r.arr_cents).toBe(598_000);
  });

  it('counts only subscriptions in MRR; ARPU divides by paying companies', () => {
    const r = summariseRevenue([
      fact({ company_id: 'a', annual_units: PRO_MONTHLY_HALF }),          // 29 950
      fact({ company_id: 'b', annual_units: STARTER_ANNUAL }),            // 24 916.67
      fact({ company_id: 'b', annual_units: STARTER_ANNUAL }),            // same company again
      fact({ company_id: 'h', annual_units: 0 }),                         // R0 plan: active, not paying
      fact({ company_id: 'd', annual_units: 3_588_000, status: 'trial' }), // trial: never MRR
      fact({ company_id: 'e', annual_units: 7_188_000, company_excluded: true }), // deleted / demo
    ]);
    // (35 940 000 + 59 800 000) / 1200 = 79 783.33 -> 79 783
    expect(r.mrr_cents).toBe(79_783);
    expect(r.active_subscriptions).toBe(4);
    expect(r.paying_companies).toBe(2);
    // 95 740 000 / 1200 / 2 = 39 891.67 -> 39 892
    expect(r.arpu_cents).toBe(39_892);
  });

  it('has no ARPU when nobody pays', () => {
    const r = summariseRevenue([fact({ company_id: 'h', annual_units: 0 })]);
    expect(r).toEqual({ mrr_cents: 0, arr_cents: 0, active_subscriptions: 1, paying_companies: 0, arpu_cents: null });
  });
});

describe('revenueAt (history without status history)', () => {
  const created = new Date('2026-10-01T00:00:00Z');
  const cancelled = new Date('2026-10-20T00:00:00Z');
  const facts = [
    fact({ company_id: 'a', annual_units: 1_200_000, created_at: created }),                                   // 1 000
    fact({ company_id: 'b', annual_units: 2_400_000, created_at: created, status: 'cancelled', cancelled_at: cancelled }), // 2 000
    fact({ company_id: 'c', annual_units: 3_600_000, created_at: created, status: 'cancelled' }),               // no cancelled_at
    fact({ company_id: 'd', annual_units: 4_800_000, created_at: created, status: 'past_due' }),
  ];
  it('a cancelled subscription counts before its cancelled_at and not after', () => {
    expect(revenueAt(facts, new Date('2026-09-30T23:59:59Z')).mrr_cents).toBe(0);
    expect(revenueAt(facts, new Date('2026-10-19T12:00:00Z')).mrr_cents).toBe(3_000);
    expect(revenueAt(facts, new Date('2026-10-20T00:00:00Z')).mrr_cents).toBe(1_000);
  });
});

describe('plan tables', () => {
  const facts = [
    fact({ company_id: 'a', annual_units: PRO_MONTHLY_HALF, plan_id: 'p-pro', plan_name: 'Pro', billing_cycle: 'monthly' }),
    fact({ company_id: 'b', annual_units: STARTER_ANNUAL }),
    fact({ company_id: 'c', annual_units: STARTER_ANNUAL }),
    fact({ company_id: 'c', annual_units: 3_588_000, billing_cycle: 'monthly' }), // monthly R29.90: 2 990 x 12 x 100
    fact({ company_id: 'h', annual_units: 0, plan_id: 'p-free', plan_name: 'Free' }),
    fact({ company_id: 'd', annual_units: 3_588_000, status: 'trial', billing_cycle: 'monthly' }),
  ];
  it('planBreakdown: per plan and cycle, paying only, share of MRR', () => {
    // Total units 35 940 000 + 59 800 000 + 3 588 000 = 99 328 000.
    expect(planBreakdown(facts)).toEqual([
      // 59 800 000 / 99 328 000 = 60.2045% -> 60.2
      { plan_name: 'Starter', billing_cycle: 'annual', company_count: 2, mrr_cents: 49_833, arr_cents: 598_000, pct_of_total: 60.2 },
      // 35 940 000 / 99 328 000 = 36.1832% -> 36.18
      { plan_name: 'Pro', billing_cycle: 'monthly', company_count: 1, mrr_cents: 29_950, arr_cents: 359_400, pct_of_total: 36.18 },
      // 3 588 000 / 99 328 000 = 3.6123% -> 3.61
      { plan_name: 'Starter', billing_cycle: 'monthly', company_count: 1, mrr_cents: 2_990, arr_cents: 35_880, pct_of_total: 3.61 },
    ]);
  });
  it('revenueByPlan: both cycles together, distinct paying companies', () => {
    // Starter: (59 800 000 + 3 588 000) / 1200 = 52 823.33 -> 52 823; companies b, c.
    expect(revenueByPlan(facts)).toEqual([
      { plan_name: 'Starter', mrr_cents: 52_823, company_count: 2 },
      { plan_name: 'Pro', mrr_cents: 29_950, company_count: 1 },
    ]);
  });
  it('a breakdown with no revenue has no share', () => {
    expect(planBreakdown([fact({ company_id: 'h', annual_units: 0 })])).toEqual([]);
  });
});

describe('netRevenueRetention', () => {
  const start = new Date('2026-10-01T00:00:00Z');
  const now = new Date('2026-11-14T10:00:00Z');
  const old = new Date('2026-08-01T00:00:00Z');
  it('ignores new sales; counts expansion and churn of the starting companies', () => {
    const facts = [
      fact({ company_id: 'a', annual_units: 1_200_000, created_at: old }),                    // 1 000 then and now
      fact({ company_id: 'a', annual_units: 600_000, created_at: new Date('2026-10-10T00:00:00Z') }), // expansion +500
      fact({ company_id: 'b', annual_units: 1_200_000, created_at: old, status: 'cancelled',
        cancelled_at: new Date('2026-10-15T00:00:00Z') }),                                  // churned 1 000
      fact({ company_id: 'n', annual_units: 6_000_000, created_at: new Date('2026-10-05T00:00:00Z') }), // new sale 5 000
    ];
    // start: a 1 000 + b 1 000 = 2 000; now: a 1 500, b 0; n is a new sale -> 1 500 / 2 000 = 75%.
    expect(netRevenueRetention(facts, start, now)).toBe(75);
  });
  it('is null when nobody paid at the start', () => {
    expect(netRevenueRetention([fact({ company_id: 'n', annual_units: 1_200_000, created_at: now })], start, now)).toBeNull();
  });
});

describe('rates with no denominator', () => {
  it('percentOrNull', () => {
    expect(percentOrNull(1, 3)).toBe(33.33);
    expect(percentOrNull(1, 3, 1)).toBe(33.3);
    expect(percentOrNull(0, 0)).toBeNull();
  });
  it('averageChurnRate skips months with nobody to churn', () => {
    // Three empty months and three at 6%: the mean is 6, not 3.
    expect(averageChurnRate([null, null, null, 6, 6, 6].map((churn_rate_pct) => ({ churn_rate_pct })))).toBe(6);
    expect(averageChurnRate([{ churn_rate_pct: null }])).toBeNull();
  });
  it('ltvEstimateCents', () => {
    // 59 900 / 0.06 = 998 333.33 -> 998 333
    expect(ltvEstimateCents(59_900, 6)).toBe(998_333);
    expect(ltvEstimateCents(59_900, 0)).toBeNull();
    expect(ltvEstimateCents(null, 6)).toBeNull();
    expect(ltvEstimateCents(59_900, null)).toBeNull();
  });
});

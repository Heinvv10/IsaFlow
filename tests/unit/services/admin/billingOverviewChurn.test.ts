/**
 * The billing overview's churn card is Revenue Intelligence's latest churn
 * month (PR #1367 review round 2 M2 / round 3 L2): churnTrend(facts, now, 1)[0],
 * rate and period. Database mocked; the facts loader returns a fixed set.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubscriptionFact } from '@/modules/admin/services/metrics/revenueMath';

const facts = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({
  sql: async (strings: TemplateStringsArray) => (strings.join('?').includes('admin_invoices')
    ? [{ total_revenue_cents: '0', outstanding_cents: '0' }]
    : [{ total: '2', past_due: '0', trial: '0' }]),
}));
vi.mock('@/modules/admin/services/metrics/metricsSql', () => ({
  companyOutOfMrr: () => '', subscriptionInMrr: () => '', subscriptionMrrCents: () => '',
  loadSubscriptionFacts: async () => facts.rows,
}));

import { getBillingOverview } from '@/modules/admin/services/billingService';
import { churnTrend } from '@/modules/admin/services/metrics/timeSeriesMath';

const NOW = new Date('2026-11-14T10:00:00Z');
const aug = new Date('2026-08-01T00:00:00Z');
function fact(company_id: string, extra: Partial<SubscriptionFact> = {}): SubscriptionFact {
  return { id: company_id, company_id, plan_id: 'p', plan_name: 'P', billing_cycle: 'monthly', status: 'active',
    created_at: aug, mrr_from: aug, cancelled_at: null, annual_units: 1_200_000, counts_toward_mrr: true,
    company_excluded: false, ...extra };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

describe('overview churn = the latest churnTrend month', () => {
  it('this SAST month so far, not last month', async () => {
    // a pays throughout; b cancelled on 10 Oct: October churn 50%, November so far 0%.
    facts.rows = [fact('a'), fact('b', { status: 'cancelled', cancelled_at: new Date('2026-10-10T00:00:00Z'), counts_toward_mrr: false })];
    const latest = churnTrend(facts.rows as SubscriptionFact[], NOW, 1)[0]!;
    expect(latest).toEqual({ month: '2026-11-01', churned_companies: 0, churn_rate_pct: 0 });
    const overview = await getBillingOverview();
    expect(overview.churn_rate_percent).toBe(latest.churn_rate_pct);
    expect(overview.churn_period).toBe(latest.month);
  });

  it('a month with nobody paying at its start has no churn rate (null)', async () => {
    facts.rows = [fact('n', { created_at: new Date('2026-11-05T00:00:00Z'), mrr_from: new Date('2026-11-05T00:00:00Z') })];
    const overview = await getBillingOverview();
    expect(overview.churn_rate_percent).toBeNull();
    expect(overview.churn_period).toBe('2026-11-01');
  });
});

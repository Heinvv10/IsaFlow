/**
 * The admin companies list / detail / export pick a company's current
 * subscription by the feature-gating rule, spliced from currentPlanSql.ts,
 * never a copy of it (PR #1367 review). DB-free: reads the built query text.
 * Behaviour against a real database: admin-companies-current-plan.int.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { currentSubscriptionJoin } from '@/modules/admin/services/metrics/metricsSql';
import { CURRENT_PLAN_ID_SQL, CURRENT_SUBSCRIPTION_SQL } from '@/modules/admin/services/currentPlanSql';

describe('currentSubscriptionJoin', () => {
  it('selects plan and cycle from the one row CURRENT_SUBSCRIPTION_SQL picks, with nothing bound', () => {
    const q = currentSubscriptionJoin();
    const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
    expect(squash(q.text)).toBe(squash(`LEFT JOIN LATERAL ( SELECT s.plan_id, s.billing_cycle ${CURRENT_SUBSCRIPTION_SQL} ) cur ON true`));
    expect(q.values).toEqual([]);
  });

  it('feature gating reads the same rule', () => {
    expect(CURRENT_PLAN_ID_SQL).toContain(CURRENT_SUBSCRIPTION_SQL);
    // A trial is current only while its end is ahead.
    expect(CURRENT_SUBSCRIPTION_SQL).toContain("s.status = 'trial'");
    expect(CURRENT_SUBSCRIPTION_SQL).toContain('GREATEST(s.current_period_end, c.trial_ends_at) > NOW()');
  });
});

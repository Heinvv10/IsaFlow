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
  });

  it('the rule: active or past_due, or a trial whose end is ahead; latest created first; one row', () => {
    // The whole text, whitespace-insensitive: a changed status set, trial-end
    // test, ordering direction, tiebreak or limit turns this red.
    const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
    expect(squash(CURRENT_SUBSCRIPTION_SQL)).toBe(
      "FROM public.subscriptions s WHERE s.company_id = c.id"
      + " AND (s.status IN ('active', 'past_due')"
      + " OR (s.status = 'trial' AND GREATEST(s.current_period_end, c.trial_ends_at) > NOW()))"
      + ' ORDER BY s.created_at DESC NULLS LAST, s.id DESC LIMIT 1');
  });
});

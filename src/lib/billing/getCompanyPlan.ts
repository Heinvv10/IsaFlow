/**
 * Resolve the current plan `code` for a company by looking up the active
 * subscription.  Returns null when the company has no active subscription
 * (new signups mid-flow, or admin-created records without billing set up).
 *
 * Used by `withFlowMeter` to short-circuit non-PAYG routes without any debit.
 */

import { sql } from '@/lib/neon';

export interface CompanyPlanInfo {
  planCode: string;      // 'payg' | 'starter' | 'professional' | 'enterprise' | ...
  planId: string;
  subscriptionId: string;
}

export async function getCompanyPlan(companyId: string): Promise<CompanyPlanInfo | null> {
  const rows = (await sql`
    SELECT s.id AS subscription_id, p.id AS plan_id, p.code
      FROM subscriptions s
      JOIN plans p ON p.id = s.plan_id
     WHERE s.company_id = ${companyId}
       AND s.status = 'active'
     ORDER BY s.created_at DESC
     LIMIT 1
  `) as Array<{ subscription_id: string; plan_id: string; code: string }>;
  const r = rows[0];
  if (!r) return null;
  return { subscriptionId: r.subscription_id, planId: r.plan_id, planCode: r.code };
}

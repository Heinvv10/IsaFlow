/**
 * Who an announcement is for, as one SQL condition shared by "what do I see" (GET /api/announcements/active) and
 * "may I dismiss this" (POST /api/announcements/dismiss), so the two can never disagree. `a` is system_announcements.
 * Plan target: any of the company's live subscriptions (a company can hold more than one row).
 */
import { sql } from '@/lib/neon';

export function announcementTargetsCompany(companyId: string) {
  return sql`(
    a.target = 'all'
    OR (a.target = 'company' AND ${companyId}::uuid = ANY(a.target_ids))
    OR (
      a.target = 'plan'
      AND a.target_ids && ARRAY(
        SELECT s.plan_id FROM subscriptions s
        WHERE s.company_id = ${companyId}::uuid AND s.status IN ('active', 'trial')
      )
    )
  )`;
}

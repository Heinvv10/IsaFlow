/**
 * companyAccessService — tenant-membership guards shared by the group and
 * permission APIs.
 *
 * User identity is a STRING in this schema, not a uuid:
 *   users.id              character varying  (default (gen_random_uuid())::text)
 *   company_users.user_id text
 *
 * So `user_id` is compared to the bare parameter. NEVER add a `::UUID` cast to
 * a company_users.user_id comparison — Postgres has no `text = uuid` operator
 * and the query throws at runtime (500), which is exactly the bug these
 * functions were extracted to fix. `company_id` IS a uuid and keeps its cast.
 *
 * These guards previously lived as duplicated closures in
 * company-groups.ts, consolidated-reports.ts and intercompany-transactions.ts.
 */

import { sql } from '@/lib/neon';

/**
 * True when the user is a member of the given company.
 *
 * Multi-tenant: this IS the tenant check — callers rely on it to reject
 * body-supplied companyIds.
 */
export async function userBelongsToCompany(userId: string, companyId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1
    FROM   company_users
    WHERE  company_id = ${companyId}::UUID
      AND  user_id    = ${userId}
    LIMIT  1
  `) as Record<string, unknown>[];

  return rows.length > 0;
}

/**
 * True when the user belongs to at least one company in the group.
 *
 * Group reads aggregate across every member company, so membership of any one
 * of them grants access to the consolidated view — that is the intended
 * consolidation model, not a gap.
 */
export async function userBelongsToGroup(userId: string, groupId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1
    FROM   company_group_members cgm
    JOIN   company_users cu ON cu.company_id = cgm.company_id
    WHERE  cgm.group_id = ${groupId}::UUID
      AND  cu.user_id   = ${userId}
    LIMIT  1
  `) as Record<string, unknown>[];

  return rows.length > 0;
}

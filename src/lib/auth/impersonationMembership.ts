/**
 * Company impersonation needs a real membership: impersonate-exchange sets the active company cookie, and withAuth
 * hard-requires a company_users row on every later request (no super_admin bypass, by design). One check, used by
 * the exchange and by POST /api/admin/companies/[id]/impersonate, so the admin route never mints a token the exchange
 * would refuse (review #1407).
 *
 * The relation is schema-qualified (S-07e): an unqualified name finds a temporary table of the same name first.
 */
import { sql } from '@/lib/neon';

/** The exchange's 403 when the admin is not a member: it points at the impersonation that signs in as a member. */
export const NOT_A_MEMBER_FOR_IMPERSONATION =
  'You are not a member of this company — use user-impersonation (admin platform → Users → Impersonate), which signs you in as an actual member';

/** Whether `userId` has a company_users row in `companyId` (a UUID; callers validate it first). */
export async function isMemberForImpersonation(userId: string, companyId: string): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM public.company_users
    WHERE user_id = ${userId} AND company_id = ${companyId}::UUID
    LIMIT 1
  `;
  return rows.length > 0;
}

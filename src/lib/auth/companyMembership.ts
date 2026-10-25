import type { PoolClient } from 'pg';
import type { UserAccountRow } from './userAccountStatus';

export type CompanyMembershipRow = UserAccountRow & {
  role: string;
  account_user_id: string | null;
};

/**
 * The one test for a live company, on a `companies` row aliased `c`: not
 * suspended, not soft-deleted. A constant, never caller input, so it is safe
 * to splice into query text (here, and via `sql.unsafe` in captureApiKeyAuth).
 */
export const LIVE_COMPANY_SQL = `c.status IS DISTINCT FROM 'suspended'
        AND c.status IS DISTINCT FROM 'deleted'
        AND c.suspended_at IS NULL`;

/**
 * Recheck tenant standing with membership inside the caller's app_user
 * transaction. Schema-qualified (S-07e): an unqualified name finds a temporary
 * table of the same name first.
 */
export function getCompanyMembership(client: PoolClient, userId: string, companyId: string) {
  return client.query<CompanyMembershipRow>(
    `SELECT cu.role,
            u.id AS account_user_id,
            u.is_active,
            u.status,
            u.suspended_at
       FROM public.company_users cu
       JOIN public.companies c ON c.id = cu.company_id
        AND ${LIVE_COMPANY_SQL}
       LEFT JOIN public.users u ON u.id = cu.user_id
      WHERE cu.user_id = $1::text AND cu.company_id = $2::uuid
      LIMIT 1`,
    [userId, companyId],
  );
}

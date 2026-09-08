import type { PoolClient } from 'pg';
import type { UserAccountRow } from './userAccountStatus';

export type CompanyMembershipRow = UserAccountRow & {
  role: string;
  account_user_id: string | null;
};

/** Recheck tenant standing with membership inside the caller's app_user transaction. */
export function getCompanyMembership(client: PoolClient, userId: string, companyId: string) {
  return client.query<CompanyMembershipRow>(
    `SELECT cu.role,
            u.id AS account_user_id,
            u.is_active,
            u.status,
            u.suspended_at
       FROM company_users cu
       JOIN companies c ON c.id = cu.company_id
        AND c.status IS DISTINCT FROM 'suspended'
        AND c.status IS DISTINCT FROM 'deleted'
        AND c.suspended_at IS NULL
       LEFT JOIN users u ON u.id = cu.user_id
      WHERE cu.user_id = $1::text AND cu.company_id = $2::uuid
      LIMIT 1`,
    [userId, companyId],
  );
}

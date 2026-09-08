import { sql } from '@/lib/neon';

/**
 * A bureau-wide delegation needs both bureau ownership and company management
 * authority. Authorization and insert share one statement snapshot; an existing
 * authorized link is a successful idempotent repeat, never an authorization bypass.
 */
export async function linkCompanyToBureau(opts: {
  bureauId: string;
  companyId: string;
  addedBy: string;
}): Promise<boolean> {
  const rows = await sql<{ authorized: boolean }>`
    WITH authorized AS (
      SELECT b.id AS bureau_id, c.id AS company_id
        FROM bureaus b
        JOIN company_users cu ON cu.user_id = ${opts.addedBy}
         AND cu.company_id = ${opts.companyId}::uuid
         AND cu.role IN ('owner', 'admin')
        JOIN companies c ON c.id = cu.company_id
       WHERE b.id = ${opts.bureauId}::uuid
         AND b.owner_user_id = ${opts.addedBy}
         AND c.status IS DISTINCT FROM 'suspended'
         AND c.status IS DISTINCT FROM 'deleted'
         AND c.suspended_at IS NULL
    ), inserted AS (
      INSERT INTO bureau_companies (bureau_id, company_id, added_by)
      SELECT bureau_id, company_id, ${opts.addedBy} FROM authorized
      ON CONFLICT (bureau_id, company_id) DO NOTHING
      RETURNING company_id
    )
    SELECT EXISTS (SELECT 1 FROM authorized) AS authorized
  `;
  return rows[0]?.authorized === true;
}

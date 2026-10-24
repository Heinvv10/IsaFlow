import { migrationAdminTx } from '@/lib/auth/migrationAdminPool';

/*
 * Client links run on the migration_admin pool (migration 932): no app role may write bureau_companies,
 * because SQL injected on an app pool can forge the claims its policy judges, and a link decides who reads
 * the shared merchant pool (931). Each write is one statement whose authorization reads the caller's bureau
 * ownership and company role live, keyed on the verified session's user id.
 */

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
  const { rows } = await migrationAdminTx('bureau-link', (c) => c.query<{ authorized: boolean }>(`
    WITH authorized AS (
      SELECT b.id AS bureau_id, c.id AS company_id
        FROM bureaus b
        JOIN company_users cu ON cu.user_id = $3
         AND cu.company_id = $2::uuid
         AND cu.role IN ('owner', 'admin')
        JOIN companies c ON c.id = cu.company_id
       WHERE b.id = $1::uuid
         AND b.owner_user_id = $3
         AND c.status IS DISTINCT FROM 'suspended'
         AND c.status IS DISTINCT FROM 'deleted'
         AND c.suspended_at IS NULL
    ), inserted AS (
      INSERT INTO bureau_companies (bureau_id, company_id, added_by)
      SELECT bureau_id, company_id, $3 FROM authorized
      ON CONFLICT (bureau_id, company_id) DO NOTHING
      RETURNING company_id
    )
    SELECT EXISTS (SELECT 1 FROM authorized) AS authorized
  `, [opts.bureauId, opts.companyId, opts.addedBy]));
  return rows[0]?.authorized === true;
}

/**
 * Remove a company from a bureau (the company itself is untouched). Allowed for the bureau's owner, or for
 * the company's owner or admin, so a company can always withdraw from a bureau (Hein, 2026-10-24).
 * Authorization and delete share one statement snapshot. Returns whether the caller was authorized; an
 * authorized unlink of a link that does not exist is an idempotent success.
 */
export async function unlinkCompanyFromBureau(opts: {
  bureauId: string;
  companyId: string;
  removedBy: string;
}): Promise<boolean> {
  const { rows } = await migrationAdminTx('bureau-unlink', (c) => c.query<{ authorized: boolean }>(`
    WITH authorized AS (
      SELECT 1
       WHERE EXISTS (SELECT 1 FROM bureaus b WHERE b.id = $1::uuid AND b.owner_user_id = $3)
          OR EXISTS (SELECT 1 FROM company_users cu
                      WHERE cu.company_id = $2::uuid AND cu.user_id = $3 AND cu.role IN ('owner', 'admin'))
    ), deleted AS (
      DELETE FROM bureau_companies bc
       WHERE bc.bureau_id = $1::uuid AND bc.company_id = $2::uuid AND EXISTS (SELECT 1 FROM authorized)
      RETURNING bc.company_id
    )
    SELECT EXISTS (SELECT 1 FROM authorized) AS authorized
  `, [opts.bureauId, opts.companyId, opts.removedBy]));
  return rows[0]?.authorized === true;
}

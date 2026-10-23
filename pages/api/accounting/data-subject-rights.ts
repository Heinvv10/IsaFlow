/**
 * POPIA Data Subject Rights — M9
 * GET  ?action=access  — returns all PII stored for the authenticated user
 * GET  ?action=export  — returns user data as JSON download
 * POST { action: 'erasure' } — anonymizes user PII (soft delete pattern)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { migrationAdminPool } from '@/lib/auth/migrationAdminPool';
import { log } from '@/lib/logger';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withErrorHandler } from '@/lib/api-error-handler';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import type { CompanyAuthedRequest } from '@/lib/auth/withAuth';
type Row = Record<string, unknown>;


async function getUserPii(userId: string, companyId: string) {
  const userRows = (await sql`
    SELECT id, first_name, last_name, email, created_at, updated_at
    FROM users
    WHERE id = ${userId}
  `) as Row[];

  const companyUserRows = (await sql`
    SELECT cu.role, cu.created_at AS joined_at, c.name AS company_name
    FROM company_users cu
    JOIN companies c ON c.id = cu.company_id
    WHERE cu.user_id = ${userId}
      AND cu.company_id = ${companyId}::UUID
  `) as Row[];

  const invitationRows = (await sql`
    SELECT email, role, created_at, accepted_at
    FROM company_invitations
    WHERE invited_by = ${userId}::VARCHAR
      AND company_id = ${companyId}::UUID
    ORDER BY created_at DESC
    LIMIT 50
  `) as Row[];

  return {
    user: userRows[0] ?? null,
    companyMemberships: companyUserRows,
    invitationsSent: invitationRows,
  };
}

async function handleAccess(req: NextApiRequest, res: NextApiResponse) {
  const companyReq = req as CompanyAuthedRequest;
  const userId = companyReq.user.id;
  const companyId = companyReq.companyId;

  const data = await getUserPii(userId, companyId);

  return apiResponse.success(res, data, 'PII access report compiled');
}

async function handleExport(req: NextApiRequest, res: NextApiResponse) {
  const companyReq = req as CompanyAuthedRequest;
  const userId = companyReq.user.id;
  const companyId = companyReq.companyId;

  const data = await getUserPii(userId, companyId);
  const json = JSON.stringify({ exportedAt: new Date().toISOString(), ...data }, null, 2);

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="isaflow-data-export.json"');
  res.status(200).send(json);
}

async function handleErasure(req: NextApiRequest, res: NextApiResponse) {
  const companyReq = req as CompanyAuthedRequest;
  const userId = companyReq.user.id;
  // Irreversible: an administrator impersonating this user must not erase them.
  await assertNotImpersonating();

  const placeholder = `anonymized_${userId.slice(0, 8)}`;

  // On the migration_admin pool, outside the request's app_user transaction
  // (migrations 902, 918). Neither app pool may write users.email:
  // createInvitation adds an existing user to a company by email, and no
  // in-database guard holds against SQL that can switch role or forge
  // request.jwt.claims mid-statement. userId is the verified session's, not
  // auth.uid(). One statement, so it commits on its own, which is safe for an
  // idempotent erasure that is this handler's last write.
  const erased = await migrationAdminPool().query(
    `UPDATE users SET first_name = 'Anonymized', last_name = $2, email = $3, updated_at = NOW()
      WHERE id = $1`,
    [userId, placeholder, `${placeholder}@deleted.invalid`],
  );
  // Never answer "anonymized" for a write that matched nothing: no profile row.
  if (erased.rowCount !== 1) {
    log.error('Data subject erasure matched no users row', { userId, rowCount: erased.rowCount }, 'data-subject-rights');
    throw new Error('Data subject erasure did not update the profile');
  }

  log.info('Data subject erasure completed', { userId }, 'data-subject-rights');

  return apiResponse.success(res, { anonymized: true }, 'Personal data has been anonymized');
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    const { action } = req.query as { action?: string };
    if (action === 'export') return handleExport(req, res);
    return handleAccess(req, res);
  }

  if (req.method === 'POST') {
    const { action } = req.body as { action?: string };
    if (action === 'erasure') return handleErasure(req, res);
    return apiResponse.badRequest(res, 'Unknown action. Valid POST action: erasure');
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'unknown', ['GET', 'POST']);
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));

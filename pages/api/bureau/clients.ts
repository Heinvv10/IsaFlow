/**
 * GET    /api/bureau/clients?bureauId=...   — list companies linked to a bureau
 * POST   /api/bureau/clients                — link a company { bureauId, companyId }
 * DELETE /api/bureau/clients                — unlink { bureauId, companyId }
 *
 * Auth: caller must be a member of the bureau (any role) for GET; for POST the
 * bureau owner who is also the company's owner or admin; for DELETE the bureau
 * owner, or the company's owner or admin (a company can always withdraw). The
 * link services re-check that inside their one write statement, on the
 * migration_admin pool (migration 932).
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withUserAuth, type UserAuthedRequest } from '@/lib/auth/withUserAuth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
// The shared primitive, not an inline z.string().uuid(): Zod 4's strict check
// refuses the seeded demo company id, and companyId here names a company.
import { UUID } from '@/lib/schemas/common';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import {
  listBureauCompanies,
  linkCompanyToBureau,
  unlinkCompanyFromBureau,
  userIsBureauMember,
} from '@/modules/bureau/services/bureauService';

async function isBureauOwner(userId: string, bureauId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM bureaus
     WHERE id = ${bureauId} AND owner_user_id = ${userId}
     LIMIT 1
  `) as unknown as Array<{ '?column?': number }>;
  return rows.length > 0;
}

const PostBody = z.object({
  bureauId: UUID,
  companyId: UUID,
}).strict();

const DeleteBody = z.object({
  bureauId: UUID,
  companyId: UUID,
}).strict();

async function handler(req: UserAuthedRequest, res: NextApiResponse) {
  const userId = req.user.id;

  if (req.method === 'GET') {
    const bureauId = String(req.query.bureauId ?? '');
    if (!bureauId) return apiResponse.badRequest(res, 'bureauId is required');
    if (!(await userIsBureauMember(userId, bureauId))) {
      return apiResponse.forbidden(res, 'Not a member of this bureau');
    }
    const companies = await listBureauCompanies(bureauId);
    return apiResponse.success(res, { companies });
  }

  if (req.method === 'POST') {
    const parsed = PostBody.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'Invalid input');
    }
    if (!(await isBureauOwner(userId, parsed.data.bureauId))) {
      return apiResponse.forbidden(res, 'Only the bureau owner can link clients');
    }
    const authorized = await linkCompanyToBureau({
      bureauId: parsed.data.bureauId,
      companyId: parsed.data.companyId,
      addedBy: userId,
    });
    if (!authorized) {
      return apiResponse.forbidden(res, 'Company management authority is required to link clients');
    }
    // bureau_companies has no change capture; a link changes pool eligibility, so record who made it.
    log.info('Bureau client link authorized (new or already linked)', { bureauId: parsed.data.bureauId, companyId: parsed.data.companyId, userId }, 'bureau');
    return apiResponse.success(res, { linked: true });
  }

  if (req.method === 'DELETE') {
    const parsed = DeleteBody.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'Invalid input');
    }
    const authorized = await unlinkCompanyFromBureau({
      bureauId: parsed.data.bureauId,
      companyId: parsed.data.companyId,
      removedBy: userId,
    });
    if (!authorized) {
      return apiResponse.forbidden(res, "Only the bureau owner or the company's owner or admin can unlink a client");
    }
    log.info('Bureau client unlink authorized (removed or not linked)', { bureauId: parsed.data.bureauId, companyId: parsed.data.companyId, userId }, 'bureau');
    return apiResponse.success(res, { unlinked: true });
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST', 'DELETE']);
}

export default withUserAuth(withErrorHandler(withCsrf(handler)));

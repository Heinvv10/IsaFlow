/**
 * GET    /api/bureau/clients?bureauId=...   — list companies linked to a bureau
 * POST   /api/bureau/clients                — link a company { bureauId, companyId }
 * DELETE /api/bureau/clients                — unlink { bureauId, companyId }
 *
 * Auth: caller must be a member of the bureau (any role) for GET; for POST/DELETE
 * caller must be the bureau owner.
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withUserAuth, type UserAuthedRequest } from '@/lib/auth/withUserAuth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { sql } from '@/lib/neon';
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
  bureauId: z.string().uuid(),
  companyId: z.string().uuid(),
}).strict();

const DeleteBody = z.object({
  bureauId: z.string().uuid(),
  companyId: z.string().uuid(),
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
    await linkCompanyToBureau({
      bureauId: parsed.data.bureauId,
      companyId: parsed.data.companyId,
      addedBy: userId,
    });
    return apiResponse.success(res, { linked: true });
  }

  if (req.method === 'DELETE') {
    const parsed = DeleteBody.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'Invalid input');
    }
    if (!(await isBureauOwner(userId, parsed.data.bureauId))) {
      return apiResponse.forbidden(res, 'Only the bureau owner can unlink clients');
    }
    await unlinkCompanyFromBureau({
      bureauId: parsed.data.bureauId,
      companyId: parsed.data.companyId,
    });
    return apiResponse.success(res, { unlinked: true });
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST', 'DELETE']);
}

export default withUserAuth(withErrorHandler(withCsrf(handler)));

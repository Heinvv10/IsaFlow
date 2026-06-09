/**
 * GET /api/auth/landing
 *
 * Returns the post-login default landing path for the authenticated user.
 * Auth: withUserAuth (user-scoped — no active company required). The user id
 * comes only from the verified session; no URL input is trusted.
 */
import type { NextApiResponse } from 'next';
import { withUserAuth, type UserAuthedRequest } from '@/lib/auth/withUserAuth';
import { resolveDefaultLanding } from '@/lib/auth/resolveLanding';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { getUserCompanies } from '@/modules/accounting/services/core/companyService';
import { listBureausForUser } from '@/modules/bureau/services/bureauService';

async function handler(req: UserAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const [companies, bureaus] = await Promise.all([
    getUserCompanies(req.user.id),
    listBureausForUser(req.user.id),
  ]);

  const defaultTarget = resolveDefaultLanding({
    hasCompanies: companies.length > 0,
    isBureauMember: bureaus.length > 0,
  });

  return apiResponse.success(res, { defaultTarget });
}

export default withUserAuth(withErrorHandler(handler));

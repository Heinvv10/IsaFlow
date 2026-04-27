/**
 * DELETE /api/auth/personal-tokens/:id — revoke one of this user's PATs.
 * Cookie-only auth: a stolen PAT must never be able to revoke its siblings.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { revokePat } from '@/lib/auth/personalAccessTokens';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'DELETE') {
    return apiResponse.methodNotAllowed(res, req.method ?? '', ['DELETE']);
  }

  const { id } = req.query;
  if (typeof id !== 'string' || !id) {
    return apiResponse.badRequest(res, 'id is required');
  }

  const ok = await revokePat(id, req.user.id, req.companyId);
  if (!ok) return apiResponse.notFound(res, 'Token not found or already revoked');

  return apiResponse.success(res, { revoked: true });
}

export default withAuth(withErrorHandler(withCsrf(handler as Parameters<typeof withErrorHandler>[0])));

/**
 * DELETE /api/oauth/authorisations/:id — revoke a connected app.
 *
 * Cookie-only. Owner-scoped: a user can only revoke their own authorisations
 * for the currently active company.
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { revokeAuthorisation } from '@/lib/auth/oauth';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'DELETE') {
    return apiResponse.methodNotAllowed(res, req.method ?? '', ['DELETE']);
  }
  const { id } = req.query;
  if (typeof id !== 'string' || !id) return apiResponse.badRequest(res, 'id is required');

  const ok = await revokeAuthorisation(id, req.user.id, req.companyId);
  if (!ok) return apiResponse.notFound(res, 'Authorisation not found or already revoked');
  return apiResponse.success(res, { revoked: true });
}

export default withAuth(withErrorHandler(handler as Parameters<typeof withErrorHandler>[0]));

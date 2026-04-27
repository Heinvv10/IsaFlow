/**
 * DELETE /api/developer/oauth-apps/:id — soft-revoke a registered OAuth app.
 * Cascades: existing access/refresh tokens stop working immediately because
 * validateOauthAccessToken joins through oauth_apps via oauth_app_id and the
 * revoked app's authorisations remain `revoked_at IS NULL` but lookups by
 * client_id during refresh return null (filtered by oauth_apps.revoked_at).
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { revokeOauthApp } from '@/lib/auth/oauth';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'DELETE') {
    return apiResponse.methodNotAllowed(res, req.method ?? '', ['DELETE']);
  }
  const { id } = req.query;
  if (typeof id !== 'string' || !id) return apiResponse.badRequest(res, 'id is required');

  const ok = await revokeOauthApp(id, req.user.id);
  if (!ok) return apiResponse.notFound(res, 'OAuth app not found or already revoked');
  return apiResponse.success(res, { revoked: true });
}

export default withAuth(withErrorHandler(withCsrf(handler as Parameters<typeof withErrorHandler>[0])));

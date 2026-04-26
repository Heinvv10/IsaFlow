/**
 * GET /api/oauth/connected-apps — list OAuth integrations the current user
 * has authorised for the active company.
 *
 * Cookie-only — managing connections is a browser-side activity. A leaked
 * OAuth access token must never be able to enumerate or revoke its siblings.
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { listConnectedApps } from '@/lib/auth/oauth';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET']);
  }
  const apps = await listConnectedApps(req.user.id, req.companyId);
  return apiResponse.success(res, apps);
}

export default withAuth(withErrorHandler(handler as Parameters<typeof withErrorHandler>[0]));

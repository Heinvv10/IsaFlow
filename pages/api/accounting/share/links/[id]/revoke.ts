/** POST /api/accounting/share/links/[id]/revoke — immediate, server-side withdrawal. */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withCsrf, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { revokeShareLink } from '@/modules/accounting/services/share/shareLinkService';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  const { companyId, user } = req as CompanyAuthedRequest;
  const id = req.query.id;
  if (typeof id !== 'string' || !UUID.test(id)) return apiResponse.notFound(res, 'Share link');
  const revoked = await revokeShareLink(companyId, id, user.id);
  // A link belonging to another company, an already-revoked link and a
  // non-existent id all answer 404: no probe distinguishes them.
  if (!revoked) return apiResponse.notFound(res, 'Share link');
  return apiResponse.success(res, { revoked: true });
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler, { allowedRoles: ['owner', 'admin'] }))));

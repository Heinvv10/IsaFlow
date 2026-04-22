/**
 * DELETE /api/accounting/audit-exports/[id]/sessions/[sessionId]
 * Revokes a portal session — auditor can no longer access the pack.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { revokePortalSession } from '@/modules/accounting/services/capture/auditTrailExportService';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'DELETE') return apiResponse.methodNotAllowed(res, req.method ?? '', ['DELETE']);
  const sessionId = req.query.sessionId as string;
  const { companyId } = req;
  if (!sessionId || !UUID_RE.test(sessionId)) return apiResponse.notFound(res, 'Portal session', sessionId);

  const ok = await revokePortalSession(sessionId, companyId);
  if (!ok) return apiResponse.notFound(res, 'Portal session', sessionId);
  return apiResponse.success(res, { revoked: true });
}

export default withAuth(withErrorHandler(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0])));

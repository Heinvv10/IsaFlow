/**
 * /api/accounting/audit-exports/[id]/sessions
 *   GET  — list portal sessions issued for this export (owner / admin / manager)
 *   POST — mint a new session (returns access token exactly once); owner / admin — the link hands an outsider the
 *          pack, which carries the snapshot's ledger rows (forensic step 4)
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import {
  listPortalSessions,
  createPortalSession,
  getExport,
} from '@/modules/accounting/services/capture/auditTrailExportService';
import { mayReadAudit, mayTakeAudit } from '@/modules/accounting/services/audit/auditAccess';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface CreateBody {
  auditorEmail?: string;
  ttlHours?: number;
}

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const id = req.query.id as string;
  const { companyId } = req;
  if (!id || !UUID_RE.test(id)) return apiResponse.notFound(res, 'Audit export', id);

  if (req.method === 'GET') {
    if (!mayReadAudit(req.companyRole)) return apiResponse.forbidden(res, 'Only an owner, admin or manager can see auditor sessions.');
    const sessions = await listPortalSessions(id, companyId);
    return apiResponse.success(res, { sessions, total: sessions.length });
  }

  if (req.method === 'POST') {
    if (!mayTakeAudit(req.companyRole)) return apiResponse.forbidden(res, 'Only an owner or admin can invite an auditor.');
    const body = (req.body ?? {}) as CreateBody;
    if (!body.auditorEmail) return apiResponse.badRequest(res, 'auditorEmail is required');

    const ex = await getExport(id, companyId);
    if (!ex) return apiResponse.notFound(res, 'Audit export', id);
    if (ex.status !== 'ready') {
      return apiResponse.badRequest(res, `Cannot invite auditor — export is ${ex.status}`);
    }

    const { session, accessToken } = await createPortalSession(
      id, companyId, body.auditorEmail,
      { issuedBy: req.user?.id ?? null, ttlHours: body.ttlHours },
    );

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.isaflow.co.za';
    const portalUrl = `${appUrl}/audit-portal/${session.id}?token=${accessToken}`;

    return apiResponse.created(res, { session, accessToken, portalUrl });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0]))));

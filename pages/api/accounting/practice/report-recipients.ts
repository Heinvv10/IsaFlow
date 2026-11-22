/**
 * Practice Report Recipients API
 * GET  /api/accounting/practice/report-recipients        - List recipients
 * POST /api/accounting/practice/report-recipients        - Create a recipient
 */

import type { NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess } from '@/lib/auth';
import { isFullAccessRole } from '@/lib/auth/companyRoles';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  listReportRecipients,
  createReportRecipient,
} from '@/modules/accounting/services/practice/practiceReportRecipientsService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId, companyRole } = req as CompanyAuthedRequest;
  const actorId = req.user.id;

  if (req.method === 'GET') {
    const { activeOnly } = req.query;
    const result = await listReportRecipients(
      companyId,
      activeOnly === 'true' ? true : undefined,
    );
    return apiResponse.success(res, result);
  }

  if (req.method === 'POST') {
    // Who receives the monthly report (which can carry per-client margins) is an owner / admin decision (#1656 round 9).
    if (!isFullAccessRole(companyRole)) return apiResponse.forbidden(res, 'Only an owner or admin can add report recipients.');
    const { email, name, reportTypes } = req.body as Record<string, unknown>;
    if (!email) return apiResponse.badRequest(res, 'email is required');

    const created = await createReportRecipient(companyId, actorId, {
      email: email as string,
      name: name as string | null | undefined,
      reportTypes: Array.isArray(reportTypes) ? (reportTypes as string[]) : undefined,
    });
    return apiResponse.created(res, created);
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));

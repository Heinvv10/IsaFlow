/**
 * Practice Report Recipient Detail API
 * GET    /api/accounting/practice/report-recipients/[id]  - Get a single recipient
 * PUT    /api/accounting/practice/report-recipients/[id]  - Update a recipient
 * DELETE /api/accounting/practice/report-recipients/[id]  - Delete a recipient
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { isFullAccessRole } from '@/lib/auth/companyRoles';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  updateReportRecipient,
  deleteReportRecipient,
} from '@/modules/accounting/services/practice/practiceReportRecipientsService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId, companyRole } = req as CompanyAuthedRequest;
  const { id } = req.query;

  if (req.method === 'PUT') {
    // Who receives the monthly report (which can carry per-client margins) is an owner / admin decision (#1656 round 9).
    if (!isFullAccessRole(companyRole)) return apiResponse.forbidden(res, 'Only an owner or admin can change report recipients.');
    const { email, name, reportTypes, isActive } = req.body as Record<string, unknown>;
    const updated = await updateReportRecipient(companyId, id as string, {
      email: email as string | undefined,
      name: name as string | null | undefined,
      reportTypes: Array.isArray(reportTypes) ? (reportTypes as string[]) : undefined,
      isActive: isActive !== undefined ? Boolean(isActive) : undefined,
    });
    return apiResponse.success(res, updated);
  }

  if (req.method === 'DELETE') {
    if (!isFullAccessRole(companyRole)) return apiResponse.forbidden(res, 'Only an owner or admin can remove report recipients.');
    await deleteReportRecipient(companyId, id as string);
    return apiResponse.success(res, { deleted: true });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['PUT', 'DELETE']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));

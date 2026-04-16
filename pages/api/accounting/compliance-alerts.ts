/**
 * Compliance Alerts API
 * GET  /api/accounting/compliance-alerts  — read alerts (all authenticated users)
 * POST /api/accounting/compliance-alerts  — dismiss alert (write access only — owner/admin/manager)
 *
 * GET combines statutory-document alerts (from statutoryDocService) with
 * AFS-specific alerts (PIS thresholds, filing deadlines) from complianceAlertService.
 *
 * Note: withWriteAccess only blocks POST/PUT/PATCH/DELETE — GET requests pass through unchanged.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, withWriteAccess } from '@/lib/auth';
import type { AuthenticatedNextApiRequest } from '@/lib/auth/middleware';
import { checkComplianceAlerts } from '@/modules/accounting/services/reports/statutoryDocService';
import {
  getActiveAfsAlerts,
  dismissAfsAlert,
} from '@/modules/accounting/services/afs/complianceAlertService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method === 'GET') {
    const [statutoryAlerts, afsAlerts] = await Promise.all([
      checkComplianceAlerts(companyId),
      getActiveAfsAlerts(companyId),
    ]);
    return apiResponse.success(res, { alerts: [...statutoryAlerts, ...afsAlerts] });
  }

  if (req.method === 'POST') {
    const body = req.body as { alertId?: string };
    if (typeof body.alertId !== 'string') {
      return apiResponse.badRequest(res, 'alertId is required');
    }
    const userId = (req as unknown as AuthenticatedNextApiRequest).user.id;
    await dismissAfsAlert(companyId, body.alertId, userId);
    return apiResponse.success(res, { dismissed: true });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

// withWriteAccess passes GET through; blocks POST for viewer role
export default withCompany(withErrorHandler(withWriteAccess(handler as never)));

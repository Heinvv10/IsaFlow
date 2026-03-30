/**
 * Admin Company Data Export API
 * GET /api/admin/companies/[id]/export-data
 * Returns all company accounting data as a downloadable JSON file.
 */

import type { NextApiResponse } from 'next';
import { withAuth, withRole, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { exportCompanyData } from '@/modules/admin/services/dataExportService';
import { logAdminAction } from '@/modules/admin/services/auditService';

function getIp(req: AuthenticatedNextApiRequest): string | null {
  return (
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    null
  );
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const companyId = req.query.id as string;

  try {
    const { filename, data } = await exportCompanyData(companyId);

    await logAdminAction(
      req.user.id,
      'company.export_data',
      'company',
      companyId,
      { filename },
      getIp(req)
    );

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).json({ filename, data });
  } catch (err) {
    log.error('Failed to export company data', { companyId, error: err }, 'admin-api');
    return apiResponse.badRequest(res, 'Failed to export company data');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withRole('super_admin')(withErrorHandler(handler as any) as any) as any);

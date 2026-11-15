/**
 * Admin Company Data Export API
 * GET /api/admin/companies/[id]/export-data
 * Returns all company accounting data as a downloadable JSON file.
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { adminUuid } from '@/modules/admin/middleware/adminRequestErrors';
import { apiResponse } from '@/lib/apiResponse';
import { exportCompanyData } from '@/modules/admin/services/dataExportService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';


async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const companyId = adminUuid(req.query.id, 'company id');

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
}

export default withAdmin(handler);

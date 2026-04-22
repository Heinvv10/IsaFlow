/**
 * /api/accounting/audit-exports/[id]
 *   GET — export metadata + current status
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { getExport } from '@/modules/accounting/services/capture/auditTrailExportService';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET']);
  const id = req.query.id as string;
  const { companyId } = req;
  if (!id || !UUID_RE.test(id)) return apiResponse.notFound(res, 'Audit export', id);

  const row = await getExport(id, companyId);
  if (!row) return apiResponse.notFound(res, 'Audit export', id);
  return apiResponse.success(res, { export: row });
}

export default withAuth(withErrorHandler(handler));

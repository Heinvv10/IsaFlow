/**
 * /api/payroll/parallel-run/imports/[id]
 *
 * GET    — import summary + its payslip rows.
 * DELETE — remove the import (payslips cascade).
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withCsrf } from '@/lib/auth/withCsrf';
import { apiResponse } from '@/lib/apiResponse';
import {
  withAuth,
  type AuthenticatedNextApiRequest,
  type CompanyAuthedRequest,
} from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  deleteExternalImport,
  getExternalImport,
  getExternalImportPayslips,
} from '@/modules/accounting/services/payroll/payrollExternalImportService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  const { companyId } = req as CompanyAuthedRequest;
  const id = String(req.query.id ?? '');
  if (!id) return apiResponse.badRequest(res, 'Missing import id');

  if (req.method === 'GET') {
    const summary = await getExternalImport(companyId, id);
    if (!summary) return apiResponse.notFound(res, 'Import not found');
    const payslips = await getExternalImportPayslips(companyId, id);
    return apiResponse.success(res, { import: summary, payslips });
  }

  if (req.method === 'DELETE') {
    const deleted = await deleteExternalImport(companyId, id);
    if (!deleted) return apiResponse.notFound(res, 'Import not found');
    log.info('External payslip import deleted', { companyId, importId: id }, 'parallelRunImports');
    return apiResponse.success(res, { deleted: true });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'DELETE']);
}

export default withAuth(withErrorHandler(withCsrf(handler)));

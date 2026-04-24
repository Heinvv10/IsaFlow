/**
 * GET    /api/payroll/batches/:id  - fetch batch + lines
 * DELETE /api/payroll/batches/:id  - delete (draft only)
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  withAuth,
  withCsrf,
  withWriteAccess,
  type AuthenticatedNextApiRequest,
  type CompanyAuthedRequest,
} from '@/lib/auth';
import {
  getBatch,
  deleteBatch,
  BatchNotFoundError,
  BatchNotEditableError,
} from '@/modules/accounting/services/payroll/payrollBatchService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  const { companyId } = req as CompanyAuthedRequest;
  const id = String(req.query.id ?? '');
  if (!id) return apiResponse.badRequest(res, 'Missing batch id');

  try {
    if (req.method === 'GET') {
      const result = await getBatch(companyId, id);
      return apiResponse.success(res, result);
    }

    if (req.method === 'DELETE') {
      await deleteBatch(companyId, id);
      return apiResponse.success(res, { deleted: true });
    }

    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'DELETE']);
  } catch (err) {
    if (err instanceof BatchNotFoundError) return apiResponse.notFound(res, err.message);
    if (err instanceof BatchNotEditableError) return apiResponse.badRequest(res, err.message);
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));

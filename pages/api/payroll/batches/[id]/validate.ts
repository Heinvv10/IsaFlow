/**
 * POST /api/payroll/batches/:id/validate
 * Checks every line (employee active, values numeric) and flips status
 * to 'validated' if clean. Per-line error messages returned in the response
 * and stored on payroll_batch_lines.error for the UI to render.
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
  validateBatch,
  BatchNotFoundError,
  BatchNotEditableError,
} from '@/modules/accounting/services/payroll/payrollBatchService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const id = String(req.query.id ?? '');
  if (!id) return apiResponse.badRequest(res, 'Missing batch id');

  try {
    const result = await validateBatch(companyId, id);
    return apiResponse.success(res, result);
  } catch (err) {
    if (err instanceof BatchNotFoundError) return apiResponse.notFound(res, err.message);
    if (err instanceof BatchNotEditableError) return apiResponse.badRequest(res, err.message);
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));

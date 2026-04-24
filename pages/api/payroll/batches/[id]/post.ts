/**
 * POST /api/payroll/batches/:id/post
 * Commits a validated batch into payroll_employee_components. One row per line
 * for component_values batches; two rows per line (3702 taxable + 3703 non-
 * taxable) for reimbursive_travel batches, subject to positive portions.
 *
 * Only admins/managers can post. Batch must be in 'validated' status.
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
  postBatch,
  BatchNotFoundError,
  BatchNotEditableError,
} from '@/modules/accounting/services/payroll/payrollBatchService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const { companyId, user } = req as CompanyAuthedRequest;
  const role = String((user as { role?: string }).role ?? '');
  if (!['super_admin', 'admin', 'manager'].includes(role)) {
    return apiResponse.forbidden(res, 'Only admins and managers can post payroll batches');
  }

  const id = String(req.query.id ?? '');
  if (!id) return apiResponse.badRequest(res, 'Missing batch id');

  try {
    const result = await postBatch(companyId, id, user.id);
    return apiResponse.success(res, result);
  } catch (err) {
    if (err instanceof BatchNotFoundError) return apiResponse.notFound(res, err.message);
    if (err instanceof BatchNotEditableError) return apiResponse.badRequest(res, err.message);
    return apiResponse.badRequest(res, err instanceof Error ? err.message : 'Post failed');
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));

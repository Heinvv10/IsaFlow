/**
 * Payroll GL account mappings.
 * GET  /api/payroll/settings/gl-accounts — list current mappings
 * PUT  /api/payroll/settings/gl-accounts — replace all mappings (body: { mappings: PayrollGlMapping[] })
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
import {
  getPayrollGlMappings,
  upsertPayrollGlMappings,
  type PayrollGlMapping,
} from '@/modules/accounting/services/payroll/payrollGlConfigService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const list = await getPayrollGlMappings(companyId);
    return apiResponse.success(res, list);
  }
  if (req.method === 'PUT') {
    const { mappings } = req.body as { mappings?: PayrollGlMapping[] };
    if (!Array.isArray(mappings)) return apiResponse.badRequest(res, 'mappings must be an array');
    const updated = await upsertPayrollGlMappings(companyId, mappings);
    return apiResponse.success(res, updated);
  }
  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'PUT']);
}

export default withAuth(withErrorHandler(withCsrf(handler)));

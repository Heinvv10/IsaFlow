/**
 * Payroll Components API
 * GET  /api/payroll/components  - List payroll components (catalogue)
 * POST /api/payroll/components  - Create a new payroll component
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  withAuth,
  type AuthenticatedNextApiRequest,
  type CompanyAuthedRequest,
} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import {
  listComponents,
  createComponent,
} from '@/modules/accounting/services/payroll/payrollComponentService';
import type { PayrollComponent } from '@/modules/accounting/services/payroll/payrollTypes';

async function handler(
  req: AuthenticatedNextApiRequest,
  res: NextApiResponse
): Promise<void> {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const components = await listComponents(companyId);
    return apiResponse.success(res, components);
  }

  if (req.method === 'POST') {
    const { name, sarsSourceCode, componentType, isTaxable, isUifApplicable, isSdlApplicable } =
      req.body as Record<string, unknown>;

    if (!name || !sarsSourceCode || !componentType) {
      return apiResponse.badRequest(res, 'name, sarsSourceCode, componentType are required');
    }

    const data: Omit<PayrollComponent, 'id'> = {
      name: String(name),
      sarsSourceCode: String(sarsSourceCode),
      componentType: String(componentType) as PayrollComponent['componentType'],
      isTaxable: isTaxable !== false,
      isUifApplicable: isUifApplicable !== false,
      isSdlApplicable: isSdlApplicable !== false,
    };

    const component = await createComponent(companyId, data);
    return apiResponse.created(res, component);
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(handler)));

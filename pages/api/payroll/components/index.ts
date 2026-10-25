/**
 * Payroll Components API
 * GET  /api/payroll/components  - List payroll components (catalogue)
 * POST /api/payroll/components  - Create a new payroll component
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { normaliseSarsCode } from '@/modules/accounting/services/payroll/payeAnnualPayment';
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
import { withWriteAccess } from '@/lib/auth/withWriteAccess';

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

    const code = normaliseSarsCode(sarsSourceCode == null ? '' : String(sarsSourceCode));
    if (!name || !code || !componentType) {
      return apiResponse.badRequest(res, 'name, sarsSourceCode, componentType are required');
    }
    // The calculator processes earnings and deductions only: an employer contribution would show on the pay run
    // and change nothing (no cost, journal line or EMP201/IRP5 figure), so it is refused until it is modelled.
    if (componentType === 'employer_contribution') {
      return apiResponse.badRequest(res, 'Employer contributions are not supported yet: payroll does not cost, post or declare them. '
        + 'Record an employer share as a separate taxable earning.');
    }
    if (componentType !== 'earning' && componentType !== 'deduction') {
      return apiResponse.badRequest(res, "componentType must be 'earning' or 'deduction'");
    }

    const data: Parameters<typeof createComponent>[1] = {
      name: String(name),
      // Normalised as PAYE classifies it (normaliseSarsCode), so the stored code is the one every reader sees.
      sarsSourceCode: code,
      componentType,
      isTaxable: isTaxable !== false,
      isUifApplicable: isUifApplicable !== false,
      isSdlApplicable: isSdlApplicable !== false,
    };

    const component = await createComponent(companyId, data);
    return apiResponse.created(res, component);
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));

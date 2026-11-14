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
import { paidOutsidePayrollRefusal } from '@/modules/accounting/services/payroll/retirementFund';
import {
  componentRfiRefusal, defaultCountsAsRfi, DEFINED_BENEFIT_REFUSAL, logDefinedBenefitRefusal,
} from '@/modules/accounting/services/payroll/payrollComponentRfi';

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
    const { name, sarsSourceCode, componentType, isTaxable, isUifApplicable, isSdlApplicable, paidOutsidePayroll, countsAsRfi, fundType } =
      req.body as Record<string, unknown>;

    const code = normaliseSarsCode(sarsSourceCode == null ? '' : String(sarsSourceCode));
    if (!name || !code || !componentType) {
      return apiResponse.badRequest(res, 'name, sarsSourceCode, componentType are required');
    }
    // An invisible character (a pasted no-break space) would hide a code from every rule keyed on it, such as 4030.
    if (!/^[A-Za-z0-9]+$/.test(code)) {
      return apiResponse.badRequest(res, 'sarsSourceCode may contain only letters and digits');
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

    // The loan instalment is never a tax deduction (Hein): a taxable LOAN deduction would lower PAYE by the repayment.
    // A LOAN-coded earning is not the loan deduction (loadLoanComponents) and keeps the usual default.
    const loan = code === 'LOAN' && componentType === 'deduction';
    if (loan && isTaxable === true) {
      return apiResponse.badRequest(res, 'A LOAN component cannot be taxable: a loan repayment is not a tax deduction. Send isTaxable: false.');
    }
    // A boolean or absent: "true" or 1 read as false would take a private contribution out of net pay.
    if (paidOutsidePayroll !== undefined && typeof paidOutsidePayroll !== 'boolean') {
      return apiResponse.badRequest(res, 'paidOutsidePayroll must be true or false');
    }

    const data: Parameters<typeof createComponent>[1] = {
      name: String(name),
      // Normalised as PAYE classifies it (normaliseSarsCode), so the stored code is the one every reader sees.
      sarsSourceCode: code,
      componentType,
      isTaxable: loan ? false : isTaxable !== false,
      isUifApplicable: isUifApplicable !== false,
      isSdlApplicable: isSdlApplicable !== false,
      paidOutsidePayroll: paidOutsidePayroll === true,
      // RF (migration 975): an earning coded 3601 counts as retirement-funding income unless the request says otherwise.
      countsAsRfi: typeof countsAsRfi === 'boolean' ? countsAsRfi : defaultCountsAsRfi(componentType, code),
    };
    // RF: an employer's fund contribution (3817 / 3825 / 3828) is taxable and for a defined-contribution fund only.
    const rfiRefused = componentRfiRefusal({ componentType, code, isTaxable: data.isTaxable, isUifApplicable: data.isUifApplicable, isSdlApplicable: data.isSdlApplicable, countsAsRfi, fundType });
    if (rfiRefused === DEFINED_BENEFIT_REFUSAL) logDefinedBenefitRefusal(companyId, code);
    if (rfiRefused) return apiResponse.badRequest(res, rfiRefused);
    // A contribution the employee pays the fund directly (PAYE 4c): retirement fund deductions only.
    const refused = data.paidOutsidePayroll ? paidOutsidePayrollRefusal(componentType, code) : null;
    if (refused) return apiResponse.badRequest(res, refused);

    const component = await createComponent(companyId, data);
    return apiResponse.created(res, component);
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));

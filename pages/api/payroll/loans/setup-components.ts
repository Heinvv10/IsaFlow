/**
 * POST /api/payroll/loans/setup-components
 *
 * Idempotent bootstrap — creates the 'LOAN' deduction component and the
 * '3801' fringe-benefit earning component if either is missing. Both are
 * referenced by payrollRunService.appendLoanComponents when a payroll run
 * is calculated; without them loan payments are still recorded on
 * payroll_loan_payments but never show up on the payslip.
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
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

interface ComponentSpec {
  sarsSourceCode: string;
  name: string;
  componentType: 'earning' | 'deduction' | 'employer_contribution';
  isTaxable: boolean;
  isUifApplicable: boolean;
  isSdlApplicable: boolean;
}

const LOAN_COMPONENTS: ComponentSpec[] = [
  {
    sarsSourceCode: 'LOAN',
    name: 'Loan repayment',
    componentType: 'deduction',
    isTaxable: false,
    isUifApplicable: false,
    isSdlApplicable: false,
  },
  {
    sarsSourceCode: '3801',
    name: 'Low-interest loan — fringe benefit',
    componentType: 'earning',
    isTaxable: true,
    isUifApplicable: false,
    isSdlApplicable: true,
  },
];

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const created: string[] = [];
  const existing: string[] = [];

  for (const spec of LOAN_COMPONENTS) {
    const rows = (await sql`
      SELECT id FROM payroll_components
       WHERE company_id = ${companyId}::uuid
         AND sars_source_code = ${spec.sarsSourceCode}
       LIMIT 1
    `) as DbRow[];
    if (rows.length > 0) {
      existing.push(spec.sarsSourceCode);
      continue;
    }
    await sql`
      INSERT INTO payroll_components (
        company_id, name, sars_source_code, component_type,
        is_taxable, is_uif_applicable, is_sdl_applicable, is_active
      ) VALUES (
        ${companyId}::uuid,
        ${spec.name},
        ${spec.sarsSourceCode},
        ${spec.componentType},
        ${spec.isTaxable},
        ${spec.isUifApplicable},
        ${spec.isSdlApplicable},
        true
      )
    `;
    created.push(spec.sarsSourceCode);
  }

  log.info('Loan components setup', { companyId, created, existing }, 'payroll-api');
  return apiResponse.success(res, { created, existing });
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));

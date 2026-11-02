/**
 * POST /api/payroll/loans/setup-components
 *
 * Idempotent bootstrap — creates the 'LOAN' deduction component and the
 * '3801' fringe-benefit earning component if either is missing. "Present"
 * is what a run can use (payrollRunLoanComponents.loadLoanComponents): an
 * ACTIVE component of that TYPE whose code is that after the calculator's
 * trim. A LOAN-coded earning or an inactive deduction is not one. Without
 * them a run withholds the loans that need them and approval is refused.
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
         AND BTRIM(sars_source_code, E' \t\r\n') = ${spec.sarsSourceCode}
         AND component_type = ${spec.componentType}
         AND is_active = TRUE
       LIMIT 1
    `) as DbRow[];
    if (rows.length > 0) {
      existing.push(spec.sarsSourceCode);
      continue;
    }
    // The name is unique per company, and a component that does not count (an earning coded LOAN, an
    // inactive one) may already hold it: then the new one says what it is.
    const taken = ((await sql`
      SELECT 1 FROM payroll_components WHERE company_id = ${companyId}::uuid AND name = ${spec.name}
    `) as DbRow[]).length > 0;
    await sql`
      INSERT INTO payroll_components (
        company_id, name, sars_source_code, component_type,
        is_taxable, is_uif_applicable, is_sdl_applicable, is_active
      ) VALUES (
        ${companyId}::uuid,
        ${taken ? `${spec.name} (${spec.sarsSourceCode} ${spec.componentType})` : spec.name},
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

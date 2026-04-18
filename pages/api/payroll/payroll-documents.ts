/**
 * Payroll Documents API
 * GET /api/payroll/payroll-documents?runId=xxx&type=pay-register|emp201|leave-report|remuneration|batch-payslips
 * Generates professional payroll PDFs matching Sage/VIP standard output.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { buildPayrollPdf } from '@/modules/accounting/services/core/payrollPdfService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const VALID_TYPES = ['pay-register', 'emp201', 'leave-report', 'remuneration', 'batch-payslips'] as const;
type DocType = typeof VALID_TYPES[number];

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);

  const { runId, type } = req.query;
  if (!runId || !type) return apiResponse.badRequest(res, 'runId and type are required');
  if (!VALID_TYPES.includes(type as DocType)) {
    return apiResponse.badRequest(res, `type must be one of: ${VALID_TYPES.join(', ')}`);
  }

  const docType = type as DocType;

  try {
    const companies = await sql`
      SELECT name, registration_number, vat_number
      FROM companies WHERE id = ${companyId}
    ` as Row[];
    const rawCompany = companies[0] || {};
    const company = {
      name: String(rawCompany.name || 'Unknown Company'),
      registration_number: rawCompany.registration_number ? String(rawCompany.registration_number) : '',
      vat_number: rawCompany.vat_number ? String(rawCompany.vat_number) : '',
    };

    const runs = await sql`
      SELECT * FROM payroll_runs
      WHERE id = ${runId as string}::UUID AND company_id = ${companyId}
    ` as Row[];
    if (!runs[0]) return apiResponse.notFound(res, 'Payroll Run', runId as string);
    const run = runs[0];

    const payslips = await sql`
      SELECT ps.*, e.employee_number, e.first_name, e.last_name,
        e.id_number, e.tax_number, e.department, e.position,
        e.bank_name, e.bank_account_number, e.bank_branch_code
      FROM payslips ps
      JOIN employees e ON e.id = ps.employee_id
      WHERE ps.payroll_run_id = ${runId as string}::UUID
      ORDER BY e.employee_number
    ` as Row[];

    // Leave data only needed for leave-report
    let leaveData: Row[] = [];
    if (docType === 'leave-report') {
      leaveData = await sql`
        SELECT lb.*, e.employee_number, e.first_name, e.last_name, e.department,
               lt.name as leave_type_name
        FROM leave_balances lb
        JOIN employees e ON e.id = lb.employee_id
        JOIN leave_types lt ON lt.code = lb.leave_type_code
        WHERE e.company_id = ${companyId}
        ORDER BY e.employee_number, lb.leave_type_code
      ` as Row[];
    }

    const { buffer, filename } = await buildPayrollPdf({ company, run, payslips, leaveData, docType });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.status(200).end(buffer);

    log.info('Payroll document generated', { type: docType, runId, employees: payslips.length }, 'payroll');
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error('Payroll document generation failed', { runId, type, error: errMsg }, 'payroll');
    const clientMessage = process.env.NODE_ENV === 'development'
      ? `Failed to generate payroll document: ${errMsg}`
      : 'Failed to generate payroll document';
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: clientMessage } });
  }
}

export default withAuth(withErrorHandler(handler));

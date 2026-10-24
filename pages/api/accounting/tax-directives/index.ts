/**
 * Tax Directives API — collection
 * GET  — list directives (?status=, ?search=)
 * POST — create a new directive. employee_id is required and must be one of
 *        the company's payroll employees (400): a run pays a directive only to
 *        its employee and the stand-alone payment refuses one without. The name
 *        is that employee's (a body name is ignored); the tax number defaults
 *        from it, and a different one is 400. An 'inactive' employee is 400.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import {
  listTaxDirectives,
  createTaxDirective,
  type TaxDirectiveCreateInput,
  type DirectiveStatus,
} from '@/modules/accounting/services/payroll/taxDirectiveService';
import { withPayrollDetailAccess } from '@/lib/auth/withPayrollDetailAccess';
import { isIsoDate } from '@/modules/accounting/services/payroll/taxDirectiveDates';
import { getDirectivePayee } from '@/modules/accounting/services/payroll/payrollEmployeeService';

const VALID_TYPES = ['lump_sum', 'retirement', 'severance', 'death'] as const;
const VALID_STATUSES = ['pending', 'approved', 'expired', 'cancelled'] as const;
const TEXT_FIELDS = [
  'employee_name', 'employee_tax_number', 'directive_number', 'effective_date', 'issued_date', 'expiry_date', 'sars_reference', 'notes',
] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId, user } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const status =
      req.query.status && VALID_STATUSES.includes(req.query.status as DirectiveStatus)
        ? (req.query.status as DirectiveStatus)
        : undefined;
    const search = req.query.search ? String(req.query.search) : undefined;

    const directives = await listTaxDirectives(companyId, { status, search });
    return apiResponse.success(res, directives);
  }

  if (req.method === 'POST') {
    const body = req.body as Partial<TaxDirectiveCreateInput>;

    // A non-string here reached .trim() or a DATE cast: a 500. Every text field is text or absent.
    for (const k of TEXT_FIELDS) {
      if (body[k] != null && typeof body[k] !== 'string') return apiResponse.badRequest(res, `${k} must be text`);
    }
    // Checked before any query: a malformed id would be a 22P02 (a 500) in the lookup.
    if (typeof body.employee_id !== 'string' || !UUID_RE.test(body.employee_id)) {
      return apiResponse.badRequest(res, 'employee_id is required: choose the payroll employee the directive is paid to');
    }
    const employee = await getDirectivePayee(companyId, body.employee_id);
    if (!employee) {
      return apiResponse.badRequest(res, 'employee_id is not an employee of this company');
    }
    // The picker offers active employees and leavers; an 'inactive' one is neither (breaker REPRO 2).
    if (employee.status !== 'active' && employee.status !== 'terminated') {
      return apiResponse.badRequest(res, `employee_id is an ${employee.status} employee: a directive is for an active employee or a leaver`);
    }
    // The name is the employee record's, whatever the body says (breaker REPRO 3: the body could name
    // someone else); the tax number defaults from the record, and one that is not the record's would file
    // the payment against someone else.
    const suppliedTaxNumber = body.employee_tax_number?.trim() || '';
    if (suppliedTaxNumber && employee.taxNumber && suppliedTaxNumber !== employee.taxNumber) {
      return apiResponse.badRequest(res, 'employee_tax_number is not the tax number on this employee\'s payroll record');
    }
    if (!body.directive_type || !VALID_TYPES.includes(body.directive_type)) {
      return apiResponse.badRequest(
        res,
        `directive_type must be one of: ${VALID_TYPES.join(', ')}`,
      );
    }
    if (body.amount == null || isNaN(Number(body.amount)) || Number(body.amount) <= 0) {
      return apiResponse.badRequest(res, 'amount must be a positive number');
    }
    if (!body.effective_date) {
      return apiResponse.badRequest(res, 'effective_date is required');
    }
    if (body.issued_date != null && !isIsoDate(body.issued_date)) {
      return apiResponse.badRequest(res, 'issued_date must be a date in YYYY-MM-DD format from 2000 to today');
    }
    // A rate is a fraction of the gross (0.18 = 18%): above 1 the PAYE would exceed the lump sum.
    if (body.tax_rate != null && (isNaN(Number(body.tax_rate)) || Number(body.tax_rate) < 0 || Number(body.tax_rate) > 1)) {
      return apiResponse.badRequest(res, 'tax_rate must be a fraction between 0 and 1 (0.18 = 18%)');
    }

    const input: TaxDirectiveCreateInput = {
      employee_id: body.employee_id,
      employee_name: employee.name,
      employee_tax_number: suppliedTaxNumber || employee.taxNumber || undefined,
      directive_number: body.directive_number,
      directive_type: body.directive_type,
      amount: Number(body.amount),
      tax_rate: body.tax_rate != null ? Number(body.tax_rate) : undefined,
      effective_date: body.effective_date,
      issued_date: body.issued_date ?? undefined,
      expiry_date: body.expiry_date,
      sars_reference: body.sars_reference,
      notes: body.notes,
    };

    const directive = await createTaxDirective(companyId, input, user.id);
    return apiResponse.created(res, directive);
  }

  return apiResponse.badRequest(res, 'Method not allowed');
}

export default withAuth(withErrorHandler(withCsrf(withPayrollDetailAccess(handler))));

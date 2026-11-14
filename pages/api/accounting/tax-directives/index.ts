/**
 * Tax Directives API — collection
 * GET  — list directives (?status=, ?search=)
 * POST — create a new directive. employee_id is required and must be one of
 *        the company's payroll employees (400): a run pays a directive only to
 *        its employee and the stand-alone payment refuses one without. The name
 *        and tax number are that employee's record's (body values are
 *        ignored). An 'inactive' employee is 400.
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
import { DIRECTIVE_TYPES, isRegularPayDirectiveType } from '@/modules/accounting/services/payroll/taxDirectiveKinds';
import { directiveBodyProblem, regularPayDirectiveBodyProblem } from '@/modules/accounting/services/payroll/taxDirectiveRegularPayBody';
import { respondIfImpersonationForbidden } from '@/lib/auth/impersonationGuard';
import { TaxDirectiveWindowError } from '@/modules/accounting/services/payroll/taxDirectiveOverlap';

const VALID_TYPES = DIRECTIVE_TYPES;
const VALID_STATUSES = ['pending', 'approved', 'expired', 'cancelled'] as const;
// employee_name and employee_tax_number are not among them: both are ignored (the record's are stored).
const TEXT_FIELDS = [
  'directive_number', 'effective_date', 'issued_date', 'expiry_date', 'sars_reference', 'notes',
] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isNumeric = (v: unknown): boolean =>
  (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)));

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
    // The picker offers active employees and leavers (status CHECK: active, inactive, terminated, mig 380);
    // an 'inactive' one is neither (breaker REPRO 2).
    if (employee.status === 'inactive') {
      return apiResponse.badRequest(res, 'employee_id is an inactive employee: a directive is for an active employee or a leaver');
    }
    // Name and tax number are the employee record's, whatever the body says (breaker REPRO 3 and round 2:
    // the body could name someone else, or carry a number the record does not hold).
    if (!body.directive_type || !VALID_TYPES.includes(body.directive_type)) {
      return apiResponse.badRequest(
        res,
        `directive_type must be one of: ${VALID_TYPES.join(', ')}`,
      );
    }
    // Lengths, date ranges ("" included) and the rate's precision, for every type (taxDirectiveRegularPayBody).
    const common = directiveBodyProblem(body);
    if (common) return apiResponse.badRequest(res, common);
    // A fixed-percentage or fixed-amount directive (IRP3(b)/(c)) states a rate or a tax amount, not a gross: its own rules.
    const regular = isRegularPayDirectiveType(body.directive_type);
    const regularProblem = regular ? regularPayDirectiveBodyProblem({ ...body, directive_type: body.directive_type as 'fixed_percentage' | 'fixed_amount' }) : null;
    if (regularProblem) return apiResponse.badRequest(res, regularProblem);
    // A number or a numeric string only: Number([]) is 0 and Number([5]) is 5, so an array slipped through.
    // NUMERIC(15,2): 1e13 and above would overflow the column (a 500).
    if (!regular && (!isNumeric(body.amount) || Number(body.amount) <= 0 || Number(body.amount) >= 1e13)) {
      return apiResponse.badRequest(res, 'amount must be a positive number below R10 000 000 000 000');
    }
    if (!body.effective_date) {
      return apiResponse.badRequest(res, 'effective_date is required');
    }
    if (body.issued_date != null && !isIsoDate(body.issued_date)) {
      return apiResponse.badRequest(res, 'issued_date must be a date in YYYY-MM-DD format from 2000 to today');
    }

    const input: TaxDirectiveCreateInput = {
      employee_id: body.employee_id,
      employee_name: employee.name,
      employee_tax_number: employee.taxNumber ?? undefined,
      directive_number: body.directive_number,
      directive_type: body.directive_type,
      amount: regular ? 0 : Number(body.amount),
      tax_rate: body.tax_rate != null ? Number(body.tax_rate) : undefined,
      tax_amount: regular && body.tax_amount != null ? Number(body.tax_amount) : undefined,
      effective_date: body.effective_date,
      issued_date: body.issued_date ?? undefined,
      expiry_date: body.expiry_date,
      sars_reference: body.sars_reference,
      notes: body.notes,
    };

    try {
      return apiResponse.created(res, await createTaxDirective(companyId, input, user.id));
    } catch (err) {
      // Judged under the employee's lock before the insert: nothing written (taxDirectiveRegularPayChange).
      if (respondIfImpersonationForbidden(res, err)) return;
      if (err instanceof TaxDirectiveWindowError) return apiResponse.badRequest(res, err.message);
      throw err;
    }
  }

  return apiResponse.badRequest(res, 'Method not allowed');
}

// The body names the employee, so what it says about the payment (and any notes on why) is about that person.
const MASKED_KEYS = ['amount', 'tax_rate', 'tax_amount', 'notes', 'directive_number', 'sars_reference'];

export default withAuth(withErrorHandler(withCsrf(withPayrollDetailAccess(handler)), { maskBodyKeys: MASKED_KEYS }));

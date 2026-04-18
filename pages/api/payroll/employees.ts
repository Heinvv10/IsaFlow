/**
 * Payroll Employees API
 * GET  /api/payroll/employees  - List employees with pay structures
 * POST /api/payroll/employees  - Create a new employee
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { listEmployees, createEmployee } from '@/modules/payroll/payrollService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    try {
      const { q, status } = req.query;
      const employees = await listEmployees(
        companyId,
        typeof q === 'string' ? q : undefined,
        typeof status === 'string' ? status : undefined
      );
      return apiResponse.success(res, employees);
    } catch (err) {
      log.error('payroll employees GET failed', { error: err }, 'payroll-api');
      return apiResponse.internalError(res, err, 'Failed to fetch employees');
    }
  }

  if (req.method === 'POST') {
    try {
      const {
        employee_number, first_name, last_name, id_number, tax_number,
        start_date, termination_date, bank_name, bank_account_number,
        bank_branch_code, department, position, employment_type,
        pay_frequency, status: empStatus, basic_salary, travel_allowance,
        housing_allowance, cell_allowance, other_allowances,
        annual_bonus, commission,
        medical_aid_contribution, medical_aid_main_member, medical_aid_dependants,
        travel_logbook_kept, travel_taxable_pct,
        eti_employment_start_date, eti_is_connected_person,
        retirement_fund_contribution_pct, custom_deductions,
      } = req.body;

      if (!employee_number?.trim()) {
        return apiResponse.badRequest(res, 'Employee number is required');
      }
      if (!first_name?.trim()) {
        return apiResponse.badRequest(res, 'First name is required');
      }
      if (!last_name?.trim()) {
        return apiResponse.badRequest(res, 'Last name is required');
      }
      if (!start_date) {
        return apiResponse.badRequest(res, 'Start date is required');
      }
      if (basic_salary === undefined || basic_salary === null) {
        return apiResponse.badRequest(res, 'Basic salary is required');
      }

      const { validateSaIdNumber, validateSaTaxNumber, isDuplicateIdNumber } =
        await import('@/modules/payroll/payrollValidationService');

      if (id_number) {
        const r = validateSaIdNumber(String(id_number).trim());
        if (!r.valid) return apiResponse.badRequest(res, `ID number: ${r.reason}`);
        const dup = await isDuplicateIdNumber(companyId, String(id_number).trim());
        if (dup) return apiResponse.badRequest(res, 'An employee with this ID number already exists');
      }
      if (tax_number) {
        const r = validateSaTaxNumber(String(tax_number).trim());
        if (!r.valid) return apiResponse.badRequest(res, `Tax number: ${r.reason}`);
      }

      const userId = (req as CompanyAuthedRequest).user?.id ?? null;

      const employee = await createEmployee(companyId, {
        employee_number: employee_number.trim(),
        first_name: first_name.trim(),
        last_name: last_name.trim(),
        id_number: id_number?.trim() || undefined,
        tax_number: tax_number?.trim() || undefined,
        start_date,
        termination_date: termination_date || undefined,
        bank_name: bank_name?.trim() || undefined,
        bank_account_number: bank_account_number?.trim() || undefined,
        bank_branch_code: bank_branch_code?.trim() || undefined,
        department: department?.trim() || undefined,
        position: position?.trim() || undefined,
        employment_type: employment_type || 'permanent',
        pay_frequency: pay_frequency || 'monthly',
        status: empStatus || 'active',
        medical_aid_main_member: Boolean(medical_aid_main_member),
        medical_aid_dependants: Number(medical_aid_dependants || 0),
        travel_logbook_kept: Boolean(travel_logbook_kept),
        travel_taxable_pct: Number(travel_taxable_pct || 80),
        eti_employment_start_date: eti_employment_start_date || undefined,
        eti_is_connected_person: Boolean(eti_is_connected_person),
        basic_salary: Number(basic_salary),
        travel_allowance: Number(travel_allowance || 0),
        housing_allowance: Number(housing_allowance || 0),
        cell_allowance: Number(cell_allowance || 0),
        other_allowances: Number(other_allowances || 0),
        annual_bonus: Number(annual_bonus || 0),
        commission: Number(commission || 0),
        medical_aid_contribution: Number(medical_aid_contribution || 0),
        retirement_fund_contribution_pct: Number(retirement_fund_contribution_pct || 0),
        custom_deductions: custom_deductions || [],
      }, userId);

      return apiResponse.created(res, employee);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create employee';
      log.error('payroll employees POST failed', { error: err }, 'payroll-api');
      return apiResponse.badRequest(res, message);
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

 
export default withAuth(withErrorHandler(withCsrf(handler)));

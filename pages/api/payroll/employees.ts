/**
 * Payroll Employees API
 * GET  /api/payroll/employees  - List employees with pay structures
 * POST /api/payroll/employees  - Create a new employee
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { listEmployees, createEmployee } from '@/modules/payroll/payrollService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

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
        medical_aid_contribution, retirement_fund_contribution_pct,
        custom_deductions,
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
        basic_salary: Number(basic_salary),
        travel_allowance: Number(travel_allowance || 0),
        housing_allowance: Number(housing_allowance || 0),
        cell_allowance: Number(cell_allowance || 0),
        other_allowances: Number(other_allowances || 0),
        medical_aid_contribution: Number(medical_aid_contribution || 0),
        retirement_fund_contribution_pct: Number(retirement_fund_contribution_pct || 0),
        custom_deductions: custom_deductions || [],
      });

      return apiResponse.created(res, employee);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create employee';
      log.error('payroll employees POST failed', { error: err }, 'payroll-api');
      return apiResponse.badRequest(res, message);
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));

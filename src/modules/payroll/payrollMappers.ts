/**
 * Payroll Mappers
 * Pure row-to-type mapping functions. No DB calls.
 */

import type {
  EmployeeWithPay,
  PayStructure,
  PayrollRun,
  Payslip,
} from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export function mapEmployeeWithPay(row: Row): EmployeeWithPay {
  return {
    id: String(row.id),
    employee_number: String(row.employee_number),
    first_name: String(row.first_name),
    last_name: String(row.last_name),
    id_number: row.id_number ? String(row.id_number) : null,
    tax_number: row.tax_number ? String(row.tax_number) : null,
    start_date: String(row.start_date),
    termination_date: row.termination_date ? String(row.termination_date) : null,
    bank_name: row.bank_name ? String(row.bank_name) : null,
    bank_account_number: row.bank_account_number ? String(row.bank_account_number) : null,
    bank_branch_code: row.bank_branch_code ? String(row.bank_branch_code) : null,
    department: row.department ? String(row.department) : null,
    position: row.position ? String(row.position) : null,
    employment_type: String(row.employment_type) as EmployeeWithPay['employment_type'],
    pay_frequency: String(row.pay_frequency) as EmployeeWithPay['pay_frequency'],
    status: String(row.status) as EmployeeWithPay['status'],
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    pay_structure: row.ps_id ? {
      id: String(row.ps_id),
      employee_id: String(row.id),
      basic_salary: Number(row.basic_salary) || 0,
      travel_allowance: Number(row.travel_allowance) || 0,
      housing_allowance: Number(row.housing_allowance) || 0,
      cell_allowance: Number(row.cell_allowance) || 0,
      other_allowances: Number(row.other_allowances) || 0,
      medical_aid_contribution: Number(row.medical_aid_contribution) || 0,
      retirement_fund_contribution_pct: Number(row.retirement_fund_contribution_pct) || 0,
      custom_deductions: Array.isArray(row.custom_deductions)
        ? row.custom_deductions
        : (typeof row.custom_deductions === 'string'
          ? JSON.parse(row.custom_deductions)
          : []),
      effective_from: String(row.effective_from),
      effective_to: row.effective_to ? String(row.effective_to) : null,
      created_at: String(row.created_at),
    } : null,
  };
}

export function mapPayStructure(row: Row): PayStructure {
  return {
    id: String(row.id),
    employee_id: String(row.employee_id),
    basic_salary: Number(row.basic_salary) || 0,
    travel_allowance: Number(row.travel_allowance) || 0,
    housing_allowance: Number(row.housing_allowance) || 0,
    cell_allowance: Number(row.cell_allowance) || 0,
    other_allowances: Number(row.other_allowances) || 0,
    medical_aid_contribution: Number(row.medical_aid_contribution) || 0,
    retirement_fund_contribution_pct: Number(row.retirement_fund_contribution_pct) || 0,
    custom_deductions: Array.isArray(row.custom_deductions)
      ? row.custom_deductions
      : (typeof row.custom_deductions === 'string'
        ? JSON.parse(row.custom_deductions)
        : []),
    effective_from: String(row.effective_from),
    effective_to: row.effective_to ? String(row.effective_to) : null,
    created_at: String(row.created_at),
  };
}

export function mapPayrollRun(row: Row): PayrollRun {
  return {
    id: String(row.id),
    period_start: String(row.period_start),
    period_end: String(row.period_end),
    run_date: String(row.run_date),
    status: String(row.status) as PayrollRun['status'],
    total_gross: Number(row.total_gross) || 0,
    total_paye: Number(row.total_paye) || 0,
    total_uif_employee: Number(row.total_uif_employee) || 0,
    total_uif_employer: Number(row.total_uif_employer) || 0,
    total_sdl: Number(row.total_sdl) || 0,
    total_net: Number(row.total_net) || 0,
    total_company_cost: Number(row.total_company_cost) || 0,
    journal_entry_id: row.journal_entry_id ? String(row.journal_entry_id) : null,
    created_by: row.created_by ? String(row.created_by) : null,
    created_at: String(row.created_at),
  };
}

export function mapPayslip(row: Row): Payslip {
  return {
    id: String(row.id),
    payroll_run_id: String(row.payroll_run_id),
    employee_id: String(row.employee_id),
    basic_salary: Number(row.basic_salary) || 0,
    travel_allowance: Number(row.travel_allowance) || 0,
    housing_allowance: Number(row.housing_allowance) || 0,
    cell_allowance: Number(row.cell_allowance) || 0,
    other_allowances: Number(row.other_allowances) || 0,
    gross_pay: Number(row.gross_pay) || 0,
    paye: Number(row.paye) || 0,
    uif_employee: Number(row.uif_employee) || 0,
    uif_employer: Number(row.uif_employer) || 0,
    sdl: Number(row.sdl) || 0,
    medical_aid: Number(row.medical_aid) || 0,
    retirement_fund: Number(row.retirement_fund) || 0,
    other_deductions: Number(row.other_deductions) || 0,
    total_deductions: Number(row.total_deductions) || 0,
    net_pay: Number(row.net_pay) || 0,
    ytd_gross: Number(row.ytd_gross) || 0,
    ytd_paye: Number(row.ytd_paye) || 0,
    ytd_uif: Number(row.ytd_uif) || 0,
    created_at: String(row.created_at),
  };
}

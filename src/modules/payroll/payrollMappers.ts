/**
 * Payroll Mappers
 * Pure row-to-type mapping functions. No DB calls.
 */

import type {
  EmployeeWithPay,
  PayStructure,
  PayrollRun,
  Payslip,
  SarsBreakdownLine,
} from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

function parseJsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === 'string') {
    try { return JSON.parse(value) as T[]; } catch { return []; }
  }
  return [];
}

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
    medical_aid_main_member: Boolean(row.medical_aid_main_member),
    medical_aid_dependants: Number(row.medical_aid_dependants) || 0,
    travel_logbook_kept: Boolean(row.travel_logbook_kept),
    travel_taxable_pct: Number(row.travel_taxable_pct) || 80,
    eti_employment_start_date: row.eti_employment_start_date ? String(row.eti_employment_start_date) : null,
    eti_is_connected_person: Boolean(row.eti_is_connected_person),
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
      annual_bonus: Number(row.annual_bonus) || 0,
      commission: Number(row.commission) || 0,
      medical_aid_contribution: Number(row.medical_aid_contribution) || 0,
      retirement_fund_contribution_pct: Number(row.retirement_fund_contribution_pct) || 0,
      custom_deductions: parseJsonArray(row.custom_deductions),
      basic_salary_code: String(row.basic_salary_code || '3601'),
      travel_allowance_code: String(row.travel_allowance_code || '3713'),
      housing_allowance_code: String(row.housing_allowance_code || '3802'),
      cell_allowance_code: String(row.cell_allowance_code || '3713'),
      other_allowances_code: String(row.other_allowances_code || '3601'),
      annual_bonus_code: String(row.annual_bonus_code || '3605'),
      commission_code: String(row.commission_code || '3606'),
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
    annual_bonus: Number(row.annual_bonus) || 0,
    commission: Number(row.commission) || 0,
    medical_aid_contribution: Number(row.medical_aid_contribution) || 0,
    retirement_fund_contribution_pct: Number(row.retirement_fund_contribution_pct) || 0,
    custom_deductions: parseJsonArray(row.custom_deductions),
    basic_salary_code: String(row.basic_salary_code || '3601'),
    travel_allowance_code: String(row.travel_allowance_code || '3713'),
    housing_allowance_code: String(row.housing_allowance_code || '3802'),
    cell_allowance_code: String(row.cell_allowance_code || '3713'),
    other_allowances_code: String(row.other_allowances_code || '3601'),
    annual_bonus_code: String(row.annual_bonus_code || '3605'),
    commission_code: String(row.commission_code || '3606'),
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
    total_eti: Number(row.total_eti) || 0,
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
    annual_bonus: Number(row.annual_bonus) || 0,
    commission: Number(row.commission) || 0,
    gross_pay: Number(row.gross_pay) || 0,
    paye: Number(row.paye) || 0,
    uif_employee: Number(row.uif_employee) || 0,
    uif_employer: Number(row.uif_employer) || 0,
    sdl: Number(row.sdl) || 0,
    medical_aid: Number(row.medical_aid) || 0,
    medical_aid_credit: Number(row.medical_aid_credit) || 0,
    retirement_fund: Number(row.retirement_fund) || 0,
    other_deductions: Number(row.other_deductions) || 0,
    total_deductions: Number(row.total_deductions) || 0,
    net_pay: Number(row.net_pay) || 0,
    ytd_gross: Number(row.ytd_gross) || 0,
    ytd_paye: Number(row.ytd_paye) || 0,
    ytd_uif: Number(row.ytd_uif) || 0,
    eti_amount: Number(row.eti_amount) || 0,
    eti_months: Number(row.eti_months) || 0,
    sars_breakdown: parseJsonArray<SarsBreakdownLine>(row.sars_breakdown),
    created_at: String(row.created_at),
  };
}

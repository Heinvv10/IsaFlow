/**
 * Payroll Module Type Definitions
 */

export type EmploymentType = 'permanent' | 'contract' | 'temporary';
export type PayFrequency = 'monthly' | 'weekly';
export type EmployeeStatus = 'active' | 'inactive';
export type PayrollRunStatus = 'draft' | 'processing' | 'completed' | 'reversed';

export interface CustomDeduction {
  name: string;
  amount: number;
}

export interface Employee {
  id: string;
  employee_number: string;
  first_name: string;
  last_name: string;
  id_number: string | null;
  tax_number: string | null;
  start_date: string;
  termination_date: string | null;
  bank_name: string | null;
  bank_account_number: string | null;
  bank_branch_code: string | null;
  department: string | null;
  position: string | null;
  employment_type: EmploymentType;
  pay_frequency: PayFrequency;
  status: EmployeeStatus;
  created_at: string;
  updated_at: string;
}

export interface PayStructure {
  id: string;
  employee_id: string;
  basic_salary: number;
  travel_allowance: number;
  housing_allowance: number;
  cell_allowance: number;
  other_allowances: number;
  medical_aid_contribution: number;
  retirement_fund_contribution_pct: number;
  custom_deductions: CustomDeduction[];
  effective_from: string;
  effective_to: string | null;
  created_at: string;
}

export interface EmployeeWithPay extends Employee {
  pay_structure: PayStructure | null;
}

export interface PayrollRun {
  id: string;
  period_start: string;
  period_end: string;
  run_date: string;
  status: PayrollRunStatus;
  total_gross: number;
  total_paye: number;
  total_uif_employee: number;
  total_uif_employer: number;
  total_sdl: number;
  total_net: number;
  total_company_cost: number;
  journal_entry_id: string | null;
  created_by: string | null;
  created_at: string;
}

export interface Payslip {
  id: string;
  payroll_run_id: string;
  employee_id: string;
  basic_salary: number;
  travel_allowance: number;
  housing_allowance: number;
  cell_allowance: number;
  other_allowances: number;
  gross_pay: number;
  paye: number;
  uif_employee: number;
  uif_employer: number;
  sdl: number;
  medical_aid: number;
  retirement_fund: number;
  other_deductions: number;
  total_deductions: number;
  net_pay: number;
  ytd_gross: number;
  ytd_paye: number;
  ytd_uif: number;
  created_at: string;
  // Joined fields
  employee_number?: string;
  first_name?: string;
  last_name?: string;
  id_number?: string;
  tax_number?: string;
  department?: string;
  position?: string;
}

export interface PayrollRunWithPayslips extends PayrollRun {
  payslips: Payslip[];
}

export interface CreateEmployeeInput {
  employee_number: string;
  first_name: string;
  last_name: string;
  id_number?: string;
  tax_number?: string;
  start_date: string;
  termination_date?: string;
  bank_name?: string;
  bank_account_number?: string;
  bank_branch_code?: string;
  department?: string;
  position?: string;
  employment_type?: EmploymentType;
  pay_frequency?: PayFrequency;
  status?: EmployeeStatus;
  // Initial pay structure
  basic_salary: number;
  travel_allowance?: number;
  housing_allowance?: number;
  cell_allowance?: number;
  other_allowances?: number;
  medical_aid_contribution?: number;
  retirement_fund_contribution_pct?: number;
  custom_deductions?: CustomDeduction[];
}

export interface UpdateEmployeeInput {
  first_name?: string;
  last_name?: string;
  id_number?: string;
  tax_number?: string;
  termination_date?: string;
  bank_name?: string;
  bank_account_number?: string;
  bank_branch_code?: string;
  department?: string;
  position?: string;
  employment_type?: EmploymentType;
  pay_frequency?: PayFrequency;
  status?: EmployeeStatus;
  // Pay structure update (creates new record)
  basic_salary?: number;
  travel_allowance?: number;
  housing_allowance?: number;
  cell_allowance?: number;
  other_allowances?: number;
  medical_aid_contribution?: number;
  retirement_fund_contribution_pct?: number;
  custom_deductions?: CustomDeduction[];
}

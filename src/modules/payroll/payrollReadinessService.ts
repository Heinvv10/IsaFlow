/**
 * IRP5 Readiness Service
 * Produces per-employee submission-readiness snapshots
 * + a company roll-up (ready/not ready counts).
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { validateSaIdNumber, validateSaTaxNumber } from './payrollValidationService';

export interface EmployeeReadinessInput {
  id: string;
  employee_number: string;
  first_name: string;
  last_name: string;
  id_number: string | null;
  tax_number: string | null;
  bank_account_number: string | null;
  bank_branch_code: string | null;
  payslipCount: number;
  etiClaimed: number;
  etiEligible: boolean;
}

export interface EmployeeReadiness {
  id: string;
  employee_number: string;
  name: string;
  blocking: string[];
  warnings: string[];
  ready: boolean;
}

export interface CompanyReadiness {
  taxYear: number;
  totalEmployees: number;
  readyCount: number;
  blockingCount: number;
  warningCount: number;
  employees: EmployeeReadiness[];
}

export function scoreEmployeeReadiness(input: EmployeeReadinessInput): EmployeeReadiness {
  const blocking: string[] = [];
  const warnings: string[] = [];

  if (!input.tax_number) blocking.push('Missing tax number');
  else {
    const t = validateSaTaxNumber(input.tax_number);
    if (!t.valid) blocking.push(`Invalid tax number: ${t.reason}`);
  }

  if (!input.id_number) blocking.push('Missing SA ID number');
  else {
    const i = validateSaIdNumber(input.id_number);
    if (!i.valid) blocking.push(`Invalid SA ID: ${i.reason}`);
  }

  if (input.payslipCount === 0) blocking.push('No payslips for the tax year');

  if (!input.bank_account_number) warnings.push('Missing bank account number');
  if (!input.bank_branch_code) warnings.push('Missing bank branch code');

  if (input.etiClaimed > 0 && !input.etiEligible) {
    warnings.push('ETI claimed but employee not currently ETI-eligible — review');
  }

  return {
    id: input.id,
    employee_number: input.employee_number,
    name: `${input.first_name} ${input.last_name}`.trim(),
    blocking,
    warnings,
    ready: blocking.length === 0,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

/** SA tax year runs March → February. 2026 = Mar 2025 – Feb 2026. */
function taxYearRange(yr: number): { start: string; end: string } {
  return { start: `${yr - 1}-03-01`, end: `${yr}-02-28` };
}

export async function computeCompanyReadiness(
  companyId: string,
  taxYear: number
): Promise<CompanyReadiness> {
  const { start, end } = taxYearRange(taxYear);
  try {
    const rows = (await sql`
      SELECT
        e.id,
        e.employee_number,
        e.first_name,
        e.last_name,
        e.id_number,
        e.tax_number,
        e.bank_account_number,
        e.bank_branch_code,
        e.eti_employment_start_date,
        e.eti_is_connected_person,
        COUNT(ps.id)::INTEGER AS payslip_count,
        COALESCE(SUM(ps.eti_amount), 0)::NUMERIC AS eti_claimed
      FROM employees e
      LEFT JOIN payslips ps ON ps.employee_id = e.id
      LEFT JOIN payroll_runs pr
        ON ps.payroll_run_id = pr.id
       AND pr.company_id = ${companyId}::UUID
       AND pr.period_end >= ${start}::DATE
       AND pr.period_end <= ${end}::DATE
       AND pr.status = 'completed'
      WHERE e.company_id = ${companyId}::UUID
      GROUP BY e.id
      ORDER BY e.employee_number
      LIMIT 500
    `) as Row[];

    const periodEnd = new Date(end);
    const { isEtiEligible } = await import('./payrollEtiService');

    const employees: EmployeeReadiness[] = rows.map((r) => {
      const elig = isEtiEligible({
        idNumber: r.id_number ? String(r.id_number) : null,
        etiStartDate: r.eti_employment_start_date ? String(r.eti_employment_start_date) : null,
        isConnectedPerson: Boolean(r.eti_is_connected_person),
        periodEnd,
      });
      return scoreEmployeeReadiness({
        id: String(r.id),
        employee_number: String(r.employee_number),
        first_name: String(r.first_name),
        last_name: String(r.last_name),
        id_number: r.id_number ? String(r.id_number) : null,
        tax_number: r.tax_number ? String(r.tax_number) : null,
        bank_account_number: r.bank_account_number ? String(r.bank_account_number) : null,
        bank_branch_code: r.bank_branch_code ? String(r.bank_branch_code) : null,
        payslipCount: Number(r.payslip_count) || 0,
        etiClaimed: Number(r.eti_claimed) || 0,
        etiEligible: elig.eligible,
      });
    });

    return {
      taxYear,
      totalEmployees: employees.length,
      readyCount: employees.filter((e) => e.ready).length,
      blockingCount: employees.filter((e) => e.blocking.length > 0).length,
      warningCount: employees.filter((e) => e.warnings.length > 0).length,
      employees,
    };
  } catch (err) {
    log.error('computeCompanyReadiness failed', { error: err }, 'payroll-readiness');
    throw err;
  }
}

/**
 * Payroll Employee Service
 * Employee CRUD, pay structures, and per-employee payslip history.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type {
  EmployeeWithPay,
  PayStructure,
  Payslip,
  CreateEmployeeInput,
  UpdateEmployeeInput,
} from './types';
import { mapEmployeeWithPay, mapPayStructure, mapPayslip } from './payrollMappers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const EMPLOYEE_PAY_SELECT = sql`
  SELECT e.*,
    ps.id AS ps_id, ps.basic_salary, ps.travel_allowance,
    ps.housing_allowance, ps.cell_allowance, ps.other_allowances,
    ps.medical_aid_contribution, ps.retirement_fund_contribution_pct,
    ps.custom_deductions, ps.effective_from, ps.effective_to
  FROM employees e
  LEFT JOIN LATERAL (
    SELECT * FROM pay_structures p
    WHERE p.employee_id = e.id
      AND p.effective_from <= CURRENT_DATE
      AND (p.effective_to IS NULL OR p.effective_to >= CURRENT_DATE)
    ORDER BY p.effective_from DESC
    LIMIT 1
  ) ps ON TRUE
`;

export async function listEmployees(
  companyId: string,
  search?: string,
  statusFilter?: string
): Promise<EmployeeWithPay[]> {
  try {
    const searchTerm = search ? `%${search}%` : null;
    let rows: Row[];

    if (searchTerm && statusFilter) {
      rows = (await sql`
        ${EMPLOYEE_PAY_SELECT}
        WHERE e.company_id = ${companyId}::UUID
          AND e.status = ${statusFilter}
          AND (
            e.first_name ILIKE ${searchTerm} OR e.last_name ILIKE ${searchTerm}
            OR e.employee_number ILIKE ${searchTerm} OR e.department ILIKE ${searchTerm}
          )
        ORDER BY e.employee_number ASC LIMIT 200
      `) as Row[];
    } else if (searchTerm) {
      rows = (await sql`
        ${EMPLOYEE_PAY_SELECT}
        WHERE e.company_id = ${companyId}::UUID
          AND (
            e.first_name ILIKE ${searchTerm} OR e.last_name ILIKE ${searchTerm}
            OR e.employee_number ILIKE ${searchTerm} OR e.department ILIKE ${searchTerm}
          )
        ORDER BY e.employee_number ASC LIMIT 200
      `) as Row[];
    } else if (statusFilter) {
      rows = (await sql`
        ${EMPLOYEE_PAY_SELECT}
        WHERE e.company_id = ${companyId}::UUID AND e.status = ${statusFilter}
        ORDER BY e.employee_number ASC LIMIT 200
      `) as Row[];
    } else {
      rows = (await sql`
        ${EMPLOYEE_PAY_SELECT}
        WHERE e.company_id = ${companyId}::UUID
        ORDER BY e.employee_number ASC LIMIT 200
      `) as Row[];
    }

    return rows.map(mapEmployeeWithPay);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('does not exist')) return [];
    log.error('listEmployees failed', { error: message }, 'payroll');
    throw err;
  }
}

export async function getEmployee(companyId: string, id: string): Promise<EmployeeWithPay | null> {
  try {
    const rows = (await sql`
      ${EMPLOYEE_PAY_SELECT}
      WHERE e.id = ${id} AND e.company_id = ${companyId}::UUID
    `) as Row[];
    if (rows.length === 0) return null;
    return mapEmployeeWithPay(rows[0]!);
  } catch (err) {
    log.error('getEmployee failed', { id, error: err }, 'payroll');
    throw err;
  }
}

export async function getEmployeePayHistory(
  companyId: string,
  employeeId: string
): Promise<PayStructure[]> {
  try {
    const rows = (await sql`
      SELECT ps.* FROM pay_structures ps
      JOIN employees e ON e.id = ps.employee_id
      WHERE ps.employee_id = ${employeeId}
        AND e.company_id = ${companyId}::UUID
      ORDER BY ps.effective_from DESC
    `) as Row[];
    return rows.map(mapPayStructure);
  } catch (err) {
    log.error('getEmployeePayHistory failed', { employeeId, error: err }, 'payroll');
    throw err;
  }
}

export async function getEmployeePayslips(
  companyId: string,
  employeeId: string
): Promise<Payslip[]> {
  try {
    const rows = (await sql`
      SELECT ps.*, pr.period_start, pr.period_end
      FROM payslips ps
      JOIN payroll_runs pr ON pr.id = ps.payroll_run_id
      JOIN employees e ON e.id = ps.employee_id
      WHERE ps.employee_id = ${employeeId}
        AND e.company_id = ${companyId}::UUID
      ORDER BY pr.period_end DESC
    `) as Row[];
    return rows.map(mapPayslip);
  } catch (err) {
    log.error('getEmployeePayslips failed', { employeeId, error: err }, 'payroll');
    throw err;
  }
}

export async function createEmployee(
  companyId: string,
  input: CreateEmployeeInput
): Promise<EmployeeWithPay> {
  try {
    const empRows = (await sql`
      INSERT INTO employees (
        company_id, employee_number, first_name, last_name, id_number, tax_number,
        start_date, termination_date, bank_name, bank_account_number,
        bank_branch_code, department, position, employment_type, pay_frequency, status
      ) VALUES (
        ${companyId}::UUID, ${input.employee_number}, ${input.first_name}, ${input.last_name},
        ${input.id_number || null}, ${input.tax_number || null}, ${input.start_date},
        ${input.termination_date || null}, ${input.bank_name || null},
        ${input.bank_account_number || null}, ${input.bank_branch_code || null},
        ${input.department || null}, ${input.position || null},
        ${input.employment_type || 'permanent'}, ${input.pay_frequency || 'monthly'},
        ${input.status || 'active'}
      )
      RETURNING *
    `) as Row[];

    const employeeId = String(empRows[0]!.id);

    await sql`
      INSERT INTO pay_structures (
        employee_id, basic_salary, travel_allowance, housing_allowance,
        cell_allowance, other_allowances, medical_aid_contribution,
        retirement_fund_contribution_pct, custom_deductions, effective_from
      ) VALUES (
        ${employeeId}::UUID, ${input.basic_salary}, ${input.travel_allowance || 0},
        ${input.housing_allowance || 0}, ${input.cell_allowance || 0},
        ${input.other_allowances || 0}, ${input.medical_aid_contribution || 0},
        ${input.retirement_fund_contribution_pct || 0},
        ${JSON.stringify(input.custom_deductions || [])}::JSONB,
        ${input.start_date}
      )
    `;

    log.info('Employee created', { id: employeeId, number: input.employee_number }, 'payroll');

    const employee = await getEmployee(companyId, employeeId);
    if (!employee) throw new Error('Failed to retrieve created employee');
    return employee;
  } catch (err) {
    log.error('createEmployee failed', { error: err }, 'payroll');
    throw err;
  }
}

export async function updateEmployee(
  companyId: string,
  id: string,
  input: UpdateEmployeeInput
): Promise<EmployeeWithPay> {
  try {
    await sql`
      UPDATE employees SET
        first_name = COALESCE(${input.first_name ?? null}, first_name),
        last_name = COALESCE(${input.last_name ?? null}, last_name),
        id_number = COALESCE(${input.id_number ?? null}, id_number),
        tax_number = COALESCE(${input.tax_number ?? null}, tax_number),
        termination_date = COALESCE(${input.termination_date ?? null}, termination_date),
        bank_name = COALESCE(${input.bank_name ?? null}, bank_name),
        bank_account_number = COALESCE(${input.bank_account_number ?? null}, bank_account_number),
        bank_branch_code = COALESCE(${input.bank_branch_code ?? null}, bank_branch_code),
        department = COALESCE(${input.department ?? null}, department),
        position = COALESCE(${input.position ?? null}, position),
        employment_type = COALESCE(${input.employment_type ?? null}, employment_type),
        pay_frequency = COALESCE(${input.pay_frequency ?? null}, pay_frequency),
        status = COALESCE(${input.status ?? null}, status),
        updated_at = NOW()
      WHERE id = ${id} AND company_id = ${companyId}::UUID
    `;

    if (input.basic_salary !== undefined) {
      await sql`
        UPDATE pay_structures
        SET effective_to = CURRENT_DATE - INTERVAL '1 day'
        WHERE employee_id = ${id}::UUID AND effective_to IS NULL
      `;
      await sql`
        INSERT INTO pay_structures (
          employee_id, basic_salary, travel_allowance, housing_allowance,
          cell_allowance, other_allowances, medical_aid_contribution,
          retirement_fund_contribution_pct, custom_deductions, effective_from
        ) VALUES (
          ${id}::UUID, ${input.basic_salary}, ${input.travel_allowance || 0},
          ${input.housing_allowance || 0}, ${input.cell_allowance || 0},
          ${input.other_allowances || 0}, ${input.medical_aid_contribution || 0},
          ${input.retirement_fund_contribution_pct || 0},
          ${JSON.stringify(input.custom_deductions || [])}::JSONB,
          CURRENT_DATE
        )
      `;
    }

    log.info('Employee updated', { id }, 'payroll');

    const employee = await getEmployee(companyId, id);
    if (!employee) throw new Error('Employee not found');
    return employee;
  } catch (err) {
    log.error('updateEmployee failed', { id, error: err }, 'payroll');
    throw err;
  }
}

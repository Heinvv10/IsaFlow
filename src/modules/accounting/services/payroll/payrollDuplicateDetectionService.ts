/**
 * Duplicate detection across payroll employees — VIP-style
 * "List/Query Various Numbers" screen. Flags potential data-entry errors or
 * outright fraud where two employees share ID number, tax number, passport,
 * bank account, or employee number.
 *
 * One SQL round-trip per field. NULL / empty strings are never considered
 * duplicates.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

type Row = DbRow;

export interface DuplicateEmployee {
  id: string;
  employeeNumber: string;
  name: string;
  status: string;
}

export interface DuplicateGroup {
  value: string;
  employees: DuplicateEmployee[];
}

export interface DuplicateResult {
  idNumber: DuplicateGroup[];
  taxNumber: DuplicateGroup[];
  passportNumber: DuplicateGroup[];
  employeeNumber: DuplicateGroup[];
  bankAccount: DuplicateGroup[];
  totals: {
    totalConflicts: number;
    affectedEmployees: number;
  };
}

export interface FindDuplicatesOptions {
  includeTerminated?: boolean;
}

function mapEmployee(e: Row): DuplicateEmployee {
  return {
    id: String(e.id),
    employeeNumber: String(e.employee_number ?? ''),
    name: String(e.name ?? ''),
    status: String(e.status ?? ''),
  };
}

function mapGroup(r: Row): DuplicateGroup {
  const emps = Array.isArray(r.employees)
    ? (r.employees as Row[])
    : [];
  return {
    value: String(r.value),
    employees: emps.map(mapEmployee),
  };
}

async function scanEmployeeField(
  companyId: string,
  field: 'id_number' | 'tax_number' | 'passport_number' | 'employee_number',
  includeTerminated: boolean,
): Promise<DuplicateGroup[]> {
  const statusFilter = includeTerminated ? '' : "status <> 'terminated'";

  // Can't parameterise column names; field is from a fixed allowlist.
  // The WHERE fragments are literal strings built from trusted input only.
  const rows = (await sql.unsafe(
    `
    SELECT value, jsonb_agg(
             jsonb_build_object(
               'id', id,
               'employee_number', employee_number,
               'name', first_name || ' ' || last_name,
               'status', status
             ) ORDER BY employee_number
           ) AS employees
      FROM (
        SELECT ${field} AS value,
               id, employee_number, first_name, last_name, status
          FROM payroll_employees
         WHERE company_id = $1::uuid
           AND ${field} IS NOT NULL
           AND ${field} <> ''
           ${statusFilter ? `AND ${statusFilter}` : ''}
      ) e
     GROUP BY value
    HAVING COUNT(*) > 1
     ORDER BY value
    `,
    [companyId],
  )) as Row[];

  return rows.map(mapGroup);
}

async function scanBankAccount(companyId: string, includeTerminated: boolean): Promise<DuplicateGroup[]> {
  const statusFilter = includeTerminated ? '' : "AND e.status <> 'terminated'";

  const rows = (await sql.unsafe(
    `
    SELECT account_number AS value,
           jsonb_agg(
             jsonb_build_object(
               'id', e.id,
               'employee_number', e.employee_number,
               'name', e.first_name || ' ' || e.last_name,
               'status', e.status
             ) ORDER BY e.employee_number
           ) AS employees
      FROM payroll_bank_details b
      JOIN payroll_employees e ON e.id = b.employee_id
     WHERE e.company_id = $1::uuid
       AND b.account_number IS NOT NULL
       AND b.account_number <> ''
       AND b.is_active = true
       ${statusFilter}
     GROUP BY account_number
    HAVING COUNT(DISTINCT e.id) > 1
     ORDER BY account_number
    `,
    [companyId],
  )) as Row[];

  return rows.map(mapGroup);
}

export async function findDuplicates(
  companyId: string,
  opts: FindDuplicatesOptions = {},
): Promise<DuplicateResult> {
  const includeTerminated = opts.includeTerminated === true;

  const [idNumber, taxNumber, passportNumber, employeeNumber, bankAccount] = await Promise.all([
    scanEmployeeField(companyId, 'id_number', includeTerminated),
    scanEmployeeField(companyId, 'tax_number', includeTerminated),
    scanEmployeeField(companyId, 'passport_number', includeTerminated),
    scanEmployeeField(companyId, 'employee_number', includeTerminated),
    scanBankAccount(companyId, includeTerminated),
  ]);

  const groups = [idNumber, taxNumber, passportNumber, employeeNumber, bankAccount];
  const totalConflicts = groups.reduce((n, g) => n + g.length, 0);
  const affectedEmployees = new Set<string>();
  for (const g of groups) {
    for (const group of g) {
      for (const e of group.employees) affectedEmployees.add(e.id);
    }
  }

  return {
    idNumber,
    taxNumber,
    passportNumber,
    employeeNumber,
    bankAccount,
    totals: {
      totalConflicts,
      affectedEmployees: affectedEmployees.size,
    },
  };
}

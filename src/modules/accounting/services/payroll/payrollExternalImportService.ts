/**
 * External payslip import persistence (parallel-run comparison).
 *
 * Stores one imported external (Sage/VIP) payslip dataset per period.
 * Amounts are integer cents (BIGINT); a NULL column means the source CSV did
 * not provide that component, which the comparator then skips.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type {
  ComparisonComponentKey,
  ExternalPayslipRow,
} from './payrollParallelRunTypes';

export interface ExternalImportSummary {
  id: string;
  periodMonth: number;
  periodYear: number;
  source: string;
  fileName: string | null;
  payslipCount: number;
  componentsPresent: ComparisonComponentKey[];
  createdAt: string;
}

export interface CreateExternalImportInput {
  periodMonth: number;
  periodYear: number;
  source: string;
  fileName: string | null;
  componentsPresent: ComparisonComponentKey[];
  rows: ExternalPayslipRow[];
  createdBy: string | null;
}

function toSummary(row: DbRow): ExternalImportSummary {
  return {
    id: String(row.id),
    periodMonth: Number(row.period_month),
    periodYear: Number(row.period_year),
    source: String(row.source),
    fileName: row.file_name ? String(row.file_name) : null,
    payslipCount: Number(row.payslip_count),
    componentsPresent: (row.components_present ?? []) as ComparisonComponentKey[],
    createdAt: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : String(row.created_at),
  };
}

export async function createExternalImport(
  companyId: string,
  input: CreateExternalImportInput,
): Promise<ExternalImportSummary> {
  const headerRows = (await sql`
    INSERT INTO payroll_external_imports
      (company_id, period_month, period_year, source, file_name,
       payslip_count, components_present, created_by)
    VALUES
      (${companyId}::uuid, ${input.periodMonth}, ${input.periodYear},
       ${input.source}, ${input.fileName}, ${input.rows.length},
       ${JSON.stringify(input.componentsPresent)}::jsonb, ${input.createdBy}::uuid)
    RETURNING *
  `) as DbRow[];
  const header = headerRows[0];
  if (!header) throw new Error('Failed to create external import');
  const importId = String(header.id);

  if (input.rows.length > 0) {
    const num = input.rows.map((r) => r.employeeNumber);
    const name = input.rows.map((r) => r.employeeName);
    const cents = (key: ComparisonComponentKey) =>
      input.rows.map((r) => r.amounts[key] ?? null);
    await sql`
      INSERT INTO payroll_external_payslips
        (import_id, company_id, employee_number, employee_name,
         gross_cents, paye_cents, uif_employee_cents, uif_employer_cents,
         uif_total_cents, sdl_cents, eti_cents, net_cents)
      SELECT ${importId}::uuid, ${companyId}::uuid, *
        FROM unnest(
          ${num}::text[], ${name}::text[],
          ${cents('gross')}::bigint[], ${cents('paye')}::bigint[],
          ${cents('uifEmployee')}::bigint[], ${cents('uifEmployer')}::bigint[],
          ${cents('uifTotal')}::bigint[], ${cents('sdl')}::bigint[],
          ${cents('eti')}::bigint[], ${cents('net')}::bigint[]
        )
    `;
  }

  return toSummary(header);
}

export async function listExternalImports(
  companyId: string,
): Promise<ExternalImportSummary[]> {
  const rows = (await sql`
    SELECT * FROM payroll_external_imports
     WHERE company_id = ${companyId}::uuid
     ORDER BY period_year DESC, period_month DESC, created_at DESC
  `) as DbRow[];
  return rows.map(toSummary);
}

export async function getExternalImport(
  companyId: string,
  importId: string,
): Promise<ExternalImportSummary | null> {
  const rows = (await sql`
    SELECT * FROM payroll_external_imports
     WHERE id = ${importId}::uuid AND company_id = ${companyId}::uuid
     LIMIT 1
  `) as DbRow[];
  return rows[0] ? toSummary(rows[0]) : null;
}

const PAYSLIP_COLUMNS: Array<[string, ComparisonComponentKey]> = [
  ['gross_cents', 'gross'],
  ['paye_cents', 'paye'],
  ['uif_employee_cents', 'uifEmployee'],
  ['uif_employer_cents', 'uifEmployer'],
  ['uif_total_cents', 'uifTotal'],
  ['sdl_cents', 'sdl'],
  ['eti_cents', 'eti'],
  ['net_cents', 'net'],
];

export async function getExternalImportPayslips(
  companyId: string,
  importId: string,
): Promise<ExternalPayslipRow[]> {
  const rows = (await sql`
    SELECT * FROM payroll_external_payslips
     WHERE import_id = ${importId}::uuid AND company_id = ${companyId}::uuid
     ORDER BY employee_number
  `) as DbRow[];
  return rows.map((row) => {
    const amounts: ExternalPayslipRow['amounts'] = {};
    for (const [col, key] of PAYSLIP_COLUMNS) {
      const v = row[col];
      if (v !== null && v !== undefined) amounts[key] = Number(v);
    }
    return {
      employeeNumber: String(row.employee_number),
      employeeName: row.employee_name ? String(row.employee_name) : null,
      amounts,
    };
  });
}

export async function deleteExternalImport(
  companyId: string,
  importId: string,
): Promise<boolean> {
  const rows = (await sql`
    DELETE FROM payroll_external_imports
     WHERE id = ${importId}::uuid AND company_id = ${companyId}::uuid
     RETURNING id
  `) as DbRow[];
  return rows.length > 0;
}

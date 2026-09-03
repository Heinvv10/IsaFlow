/**
 * Paged, status-aware reads over payroll employees, shaped for a
 * `ReportEnvelope`.
 *
 * WHY NOT `listPayrollEmployees`. That one filters `status = 'active'` and
 * returns a bare array. The filter is correct for its caller —
 * `calculatePayrollRun` must not pay a terminated employee — and wrong for a
 * listing, where a status filter that drops rows silently is the defect
 * (docs/mcp/CONTRACTS.md §4). Widening it in place would change what a pay run
 * pays, so this is an addition and the original is untouched.
 *
 * PII. `id_number` and `tax_number` are SA identity numbers under POPIA. This
 * service returns them only when the caller explicitly asks, and the MCP tool
 * above it defaults to masked — an agent listing staff to reconcile headcount
 * has no need for either, and a connector transcript is not a place to spill
 * them by default.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';

type Row = DbRow;

export interface PayrollEmployeeRow {
  id: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  status: string;
  employmentType: string;
  startDate: string;
  endDate: string | null;
  costCentreId: string | null;
  uifExcluded: boolean;
  /** Last 4 digits only, unless the caller asked for the full value. */
  idNumber: string | null;
  taxNumber: string | null;
  idNumberMasked: boolean;
}

export interface PayrollEmployeePage {
  rows: PayrollEmployeeRow[];
  rowsTotal: number;
  universeTotal: number;
  postedThrough: string | null;
  hasMore: boolean;
}

export interface PayrollEmployeeFilters {
  /** Omit for EVERY status — a listing states its own completeness. */
  status?: string;
  limit: number;
  /** Keyset cursor parts: [last_name, first_name, id] of the last row served. */
  after?: readonly string[];
  /** Return full SA ID and tax numbers instead of the last four digits. */
  revealIdentityNumbers?: boolean;
}

function maskTail(value: unknown, reveal: boolean): string | null {
  if (value == null) return null;
  const s = String(value);
  if (reveal) return s;
  return s.length <= 4 ? '*'.repeat(s.length) : `${'*'.repeat(s.length - 4)}${s.slice(-4)}`;
}

export async function listPayrollEmployeesPage(
  companyId: string,
  filters: PayrollEmployeeFilters,
): Promise<PayrollEmployeePage> {
  const status = filters.status ?? null;
  const reveal = filters.revealIdentityNumbers === true;
  const afterLast = filters.after?.[0] ?? null;
  const afterFirst = filters.after?.[1] ?? null;
  const afterId = filters.after?.[2] ?? null;

  const [counts] = (await sql`
    SELECT
      COUNT(*) AS universe_total,
      COUNT(*) FILTER (WHERE ${status}::TEXT IS NULL OR status = ${status}::TEXT) AS rows_total,
      MAX(created_at) AS posted_through
    FROM payroll_employees
    WHERE company_id = ${companyId}::UUID
  `) as Row[];

  const rows = (await sql`
    SELECT id, employee_number, first_name, last_name, status, employment_type,
           start_date, end_date, cost_centre_id, uif_excluded, id_number, tax_number
    FROM payroll_employees
    WHERE company_id = ${companyId}::UUID
      AND (${status}::TEXT IS NULL OR status = ${status}::TEXT)
      AND (
        ${afterId}::TEXT IS NULL
        OR (COALESCE(last_name, ''), COALESCE(first_name, ''), id::TEXT)
           > (${afterLast}::TEXT, ${afterFirst}::TEXT, ${afterId}::TEXT)
      )
    ORDER BY COALESCE(last_name, ''), COALESCE(first_name, ''), id::TEXT
    LIMIT ${filters.limit + 1}
  `) as Row[];

  const hasMore = rows.length > filters.limit;
  const page = hasMore ? rows.slice(0, filters.limit) : rows;

  return {
    rows: page.map((r) => ({
      id: String(r.id),
      employeeNumber: String(r.employee_number ?? ''),
      firstName: String(r.first_name ?? ''),
      lastName: String(r.last_name ?? ''),
      status: String(r.status ?? ''),
      employmentType: String(r.employment_type ?? ''),
      startDate: fmtDate(r.start_date),
      endDate: r.end_date ? fmtDate(r.end_date) : null,
      costCentreId: r.cost_centre_id == null ? null : String(r.cost_centre_id),
      uifExcluded: Boolean(r.uif_excluded),
      idNumber: maskTail(r.id_number, reveal),
      taxNumber: maskTail(r.tax_number, reveal),
      idNumberMasked: !reveal,
    })),
    rowsTotal: Number(counts?.rows_total ?? 0),
    universeTotal: Number(counts?.universe_total ?? 0),
    postedThrough: counts?.posted_through ? new Date(String(counts.posted_through)).toISOString() : null,
    hasMore,
  };
}

/** Cursor parts for an employee row, in the order the page orders by. */
export function payrollEmployeeCursorParts(row: PayrollEmployeeRow): string[] {
  return [row.lastName, row.firstName, row.id];
}

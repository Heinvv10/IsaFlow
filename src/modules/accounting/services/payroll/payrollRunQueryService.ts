/**
 * Paged, filtered reads over pay runs and payroll employees, shaped for a
 * `ReportEnvelope`.
 *
 * WHY THESE ARE NOT `listPayrollRuns` / `listPayrollEmployees`. Those two return
 * a bare array with no total, no cursor and no `posted_through`, and
 * `listPayrollEmployees` filters `status = 'active'`, which is wrong for a
 * listing that has to state its own completeness. (The run no longer reads it:
 * `calculatePayrollRun` uses `listPayrollRunEmployees`, by end date.) So these
 * are additions; the originals are untouched and still own their callers.
 *
 * `universeTotal` is the count BEFORE the status filter, so
 * `rowsTotal + excludedRows === universeTotal` is arithmetic a reader can check
 * rather than a claim the report makes about itself.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { mapRunRow, type PayrollRunSummary } from './payrollRunService';
import { EMP201_DECLARABLE_STATUSES } from '@/lib/constants/payrollRunStatuses';

type Row = DbRow;

export interface PayRunPage {
  rows: Array<PayrollRunSummary & { journalEntryId: string | null }>;
  /** Runs matching the filters, before paging. */
  rowsTotal: number;
  /** Runs in the company before ANY filter — the completeness denominator. */
  universeTotal: number;
  /** MAX(created_at) over the rows consumed, ISO-8601, or null when there are none. */
  postedThrough: string | null;
  /** True when more rows follow the page. */
  hasMore: boolean;
}

export interface PayRunFilters {
  year?: number;
  status?: string;
  limit: number;
  /** Keyset cursor parts: [period_year, period_month, id] of the last row served. */
  after?: readonly string[];
}

/** Ordered newest period first, then by id so the key is total and stable. */
export async function listPayRunsPage(
  companyId: string,
  filters: PayRunFilters,
): Promise<PayRunPage> {
  const year = filters.year ?? null;
  const status = filters.status ?? null;
  const afterYear = filters.after?.[0] ?? null;
  const afterMonth = filters.after?.[1] ?? null;
  const afterId = filters.after?.[2] ?? null;

  const [counts] = (await sql`
    SELECT
      COUNT(*) AS universe_total,
      COUNT(*) FILTER (
        WHERE (${year}::INT IS NULL OR period_year = ${year}::INT)
          AND (${status}::TEXT IS NULL OR status = ${status}::TEXT)
      ) AS rows_total,
      MAX(created_at) AS posted_through
    FROM payroll_run_headers
    WHERE company_id = ${companyId}::UUID
  `) as Row[];

  // Descending order, so "after" means strictly LESS THAN the cursor key.
  const rows = (await sql`
    SELECT * FROM payroll_run_headers
    WHERE company_id = ${companyId}::UUID
      AND (${year}::INT IS NULL OR period_year = ${year}::INT)
      AND (${status}::TEXT IS NULL OR status = ${status}::TEXT)
      AND (
        ${afterId}::TEXT IS NULL
        OR (
          LPAD(period_year::TEXT, 6, '0'),
          LPAD(period_month::TEXT, 2, '0'),
          id::TEXT
        ) < (${afterYear}::TEXT, ${afterMonth}::TEXT, ${afterId}::TEXT)
      )
    ORDER BY LPAD(period_year::TEXT, 6, '0') DESC,
             LPAD(period_month::TEXT, 2, '0') DESC,
             id::TEXT DESC
    LIMIT ${filters.limit + 1}
  `) as Row[];

  const hasMore = rows.length > filters.limit;
  const page = hasMore ? rows.slice(0, filters.limit) : rows;

  return {
    rows: page.map((r) => ({
      ...mapRunRow(r),
      journalEntryId: r.journal_entry_id == null ? null : String(r.journal_entry_id),
    })),
    rowsTotal: Number(counts?.rows_total ?? 0),
    universeTotal: Number(counts?.universe_total ?? 0),
    postedThrough: counts?.posted_through ? new Date(String(counts.posted_through)).toISOString() : null,
    hasMore,
  };
}

/** The cursor parts for a run row, in the order `listPayRunsPage` orders by. */
export function payRunCursorParts(run: { periodYear: number; periodMonth: number; id: string }): string[] {
  return [
    String(run.periodYear).padStart(6, '0'),
    String(run.periodMonth).padStart(2, '0'),
    run.id,
  ];
}

/**
 * The pay run a statutory figure would be taken from: only the statuses an EMP201 declares, the latest period first, and
 * within a period the latest created. `month` narrows to one calendar month; null is the latest run overall.
 */
export async function getDeclarablePayRun(
  companyId: string,
  month: { year: number; month: number } | null,
): Promise<PayrollRunSummary | null> {
  const statuses: string[] = [...EMP201_DECLARABLE_STATUSES];
  const year = month ? month.year : null;
  const m = month ? month.month : null;
  const rows = (await sql`
    SELECT * FROM payroll_run_headers
    WHERE company_id = ${companyId}::UUID
      AND status = ANY(${statuses}::TEXT[])
      AND (${year}::INT IS NULL OR (period_year = ${year}::INT AND period_month = ${m}::INT))
    ORDER BY period_year DESC, period_month DESC, created_at DESC, id DESC
    LIMIT 1
  `) as Row[];
  return rows[0] ? { ...mapRunRow(rows[0]) } : null;
}

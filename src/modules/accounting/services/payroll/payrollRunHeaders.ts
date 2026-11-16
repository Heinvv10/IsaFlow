/**
 * Payroll run headers: the summary shape, listing, creation and lookup.
 * Split out of payrollRunService.ts (which re-exports all of it) to keep that file under the 300-line cap.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { PayrollPeriod } from './payrollTypes';
import type { OffCycleReason, PayFrequency, RunKind } from './payrollTypesRun';
import { dateColumnOf, offCycleReasonOf, payFrequencyOf, runKindOf } from './payrollFrequency';

type Row = DbRow;

export interface PayrollRunSummary {
  id: string;
  companyId: string;
  periodMonth: number;
  periodYear: number;
  status: string;
  totalGross: number;
  totalPaye: number;
  totalUif: number;
  totalSdl: number;
  totalEti: number;
  totalNet: number;
  employeeCount: number;
  /** The GL entry posted at approval, still set after reopenPayrollRun. */
  journalEntryId: string | null;
  /** Migration 999a. This release creates and costs only monthly regular runs (payrollRunKindGuard). */
  payFrequency: PayFrequency;
  runKind: RunKind;
  offCycleReason: OffCycleReason | null;
  /** The dates the run pays for, 'YYYY-MM-DD'; for a monthly regular run, its calendar month. */
  periodStart: string | null;
  periodEnd: string | null;
}

export function mapRunRow(r: Row): PayrollRunSummary {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    periodMonth: Number(r.period_month),
    periodYear: Number(r.period_year),
    status: String(r.status),
    totalGross: Number(r.total_gross) || 0,
    totalPaye: Number(r.total_paye) || 0,
    totalUif: Number(r.total_uif) || 0,
    totalSdl: Number(r.total_sdl) || 0,
    totalEti: Number(r.total_eti) || 0,
    totalNet: Number(r.total_net) || 0,
    employeeCount: Number(r.employee_count) || 0,
    journalEntryId: r.journal_entry_id == null ? null : String(r.journal_entry_id),
    payFrequency: payFrequencyOf(r.pay_frequency),
    runKind: runKindOf(r.run_kind),
    offCycleReason: offCycleReasonOf(r.off_cycle_reason),
    periodStart: dateColumnOf(r.period_start),
    periodEnd: dateColumnOf(r.period_end),
  };
}

export async function listPayrollRuns(companyId: string): Promise<PayrollRunSummary[]> {
  const rows = (await sql`
    SELECT * FROM payroll_run_headers
    WHERE company_id = ${companyId}::uuid
    ORDER BY period_year DESC, period_month DESC
  `) as Row[];
  return rows.map(mapRunRow);
}

export class PayrollRunDuplicateError extends Error {
  readonly month: number;
  readonly year: number;
  constructor(month: number, year: number) {
    super(`A payroll run for ${month}/${year} already exists.`);
    this.name = 'PayrollRunDuplicateError';
    this.month = month;
    this.year = year;
  }
}

/** A monthly regular run for the calendar month (the only kind this release creates; migration 999a). */
export async function createPayrollRun(
  companyId: string,
  period: PayrollPeriod,
  createdBy?: string,
): Promise<PayrollRunSummary> {
  log.info('Creating payroll run', { companyId, period }, 'payrollRunService');
  const rows = (await sql`
    INSERT INTO payroll_run_headers (
      company_id, period_month, period_year, created_by, pay_frequency, run_kind, period_start, period_end
    )
    VALUES (
      ${companyId}::uuid, ${period.month}, ${period.year}, ${createdBy ?? null}::uuid, 'monthly', 'regular',
      public.payroll_month_period_start(${period.year}::int, ${period.month}::int),
      public.payroll_month_period_end(${period.year}::int, ${period.month}::int)
    )
    ON CONFLICT (company_id, period_year, period_month) DO NOTHING
    RETURNING *
  `) as Row[];
  if (rows.length === 0) {
    throw new PayrollRunDuplicateError(period.month, period.year);
  }
  if (!rows[0]) throw new Error('INSERT returned no row');
  return mapRunRow(rows[0]);
}

export async function getPayrollRun(
  id: string,
  companyId: string,
): Promise<PayrollRunSummary | null> {
  const rows = (await sql`
    SELECT * FROM payroll_run_headers
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
  `) as Row[];
  return rows.length > 0 && rows[0] ? mapRunRow(rows[0]) : null;
}

/**
 * Payroll run headers: the summary shape, listing, creation and lookup.
 * Split out of payrollRunService.ts (which re-exports all of it) to keep that file under the 300-line cap.
 */
import { sql, withTransaction } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { PayrollPeriod } from './payrollTypes';
import type { OffCycleReason, PayFrequency, RunKind, UnsupportedValue } from './payrollTypesRun';
import { dateColumnOf, offCycleReasonOf, payFrequencyOf, runKindOf } from './payrollFrequency';
import { runOrderKeySql } from './payrollRunOrder';

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
  /** 'unsupported': a value a later release added; the run lists, and the guard refuses to act on it. */
  payFrequency: PayFrequency | UnsupportedValue;
  runKind: RunKind | UnsupportedValue;
  offCycleReason: OffCycleReason | UnsupportedValue | null;
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
    SELECT * FROM payroll_run_headers h
    WHERE h.company_id = ${companyId}::uuid
    ORDER BY ${runOrderKeySql('h')} DESC
  `) as Row[];
  return rows.map(mapRunRow);
}

/** The company's latest run in pay order that is not cancelled (the payroll period bar). Null: none yet. */
export async function latestPayrollRun(companyId: string): Promise<{ id: string; periodMonth: number; periodYear: number; status: string } | null> {
  const rows = (await sql`
    SELECT h.id, h.period_month, h.period_year, h.status
      FROM payroll_run_headers h
     WHERE h.company_id = ${companyId}::uuid AND h.status <> 'cancelled'
     ORDER BY ${runOrderKeySql('h')} DESC
     LIMIT 1
  `) as Row[];
  const r = rows[0];
  return r ? { id: String(r.id), periodMonth: Number(r.period_month), periodYear: Number(r.period_year), status: String(r.status) } : null;
}

export class PayrollRunDuplicateError extends Error {
  readonly month: number;
  readonly year: number;
  constructor(month: number, year: number, message = `A payroll run for ${month}/${year} already exists.`) {
    super(message);
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
  const rows = await insertMonthlyRun(companyId, period, createdBy);
  if (rows.length === 0) {
    throw new PayrollRunDuplicateError(period.month, period.year);
  }
  if (!rows[0]) throw new Error('INSERT returned no row');
  return mapRunRow(rows[0]);
}

/** The per-month unique (company, year, month) that FQx drops; until then it also refuses a month holding an off-cycle run. */
const MONTH_UNIQUE = 'payroll_run_headers_company_id_period_year_period_month_key';

async function insertMonthlyRun(companyId: string, period: PayrollPeriod, createdBy?: string): Promise<Row[]> {
  try {
    // Its own savepoint inside a request transaction (withTransaction nests one), so the refusal below leaves the
    // request's transaction usable.
    return await withTransaction(async (tx) => (await tx`
    INSERT INTO payroll_run_headers (
      company_id, period_month, period_year, created_by, pay_frequency, run_kind, period_start, period_end
    )
    VALUES (
      ${companyId}::uuid, ${period.month}, ${period.year}, ${createdBy ?? null}, 'monthly', 'regular',
      public.payroll_month_period_start(${period.year}::int, ${period.month}::int),
      public.payroll_month_period_end(${period.year}::int, ${period.month}::int)
    )
    -- The regular-period key (migration 999a), not the per-month unique FQx drops: an off-cycle run of the month is no clash.
    ON CONFLICT (company_id, pay_frequency, period_start) WHERE run_kind = 'regular' DO NOTHING
    RETURNING *
  `) as Row[]);
  } catch (err) {
    // Between this release and FQx: a month whose only run is not regular has no regular-key conflict, so the old
    // per-month unique refuses it. That is the same duplicate, named, not a raw 23505 (review #1507).
    const e = err as { code?: string; constraint?: string };
    if (e.code === '23505' && e.constraint === MONTH_UNIQUE) throw new PayrollRunDuplicateError(period.month, period.year);
    throw err;
  }
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

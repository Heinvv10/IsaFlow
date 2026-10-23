/**
 * The fiscal-year registry: the ONE answer to "which financial year holds this
 * date / has this label, and what are its dates".
 *
 * WHY. Every reader used to rebuild a year's dates from the CURRENT
 * `companies.financial_year_start` (fiscalYearStart / fiscalYearRange), so a
 * change of year end silently re-cut every historical year in every report.
 * A year is now a stored row (`fiscal_years`, migration 940) and keeps its own
 * dates; a 14-month transition year is simply a row that is 14 months long.
 *
 * WHERE NO ROW EXISTS YET (a date beyond the last stored year, or a company
 * with no periods), the range comes from the database's template
 * (`fiscal_year_template`: twelve months on from the nearest stored year, else
 * the declared month). Readers get the same range the generator will create,
 * flagged `stored: false`; nothing here writes. The census in
 * tests/unit/guards/fiscalYearBoundaryCensus.test.ts fails the build when code
 * outside this file and the template derives a year from the start month.
 *
 * Dates are 'YYYY-MM-DD' strings throughout (fmtDate, never toISOString: this
 * host runs at UTC+2).
 */

import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { FiscalPeriodStatus } from '../../types/gl.types';

export type FiscalYearKind = 'normal' | 'transition';

export interface FiscalYearRecord {
  /** The fiscal_years row, or null for a template year not yet created. */
  id: string | null;
  /** The label: the calendar year the year ends in (FY2027 = Mar 2026 - Feb 2027). */
  fiscalYear: number;
  startDate: string;
  endDate: string;
  status: FiscalPeriodStatus;
  kind: FiscalYearKind;
  /** False for a template year: no row yet, created on its first posting. */
  stored: boolean;
  /** Whole calendar months the year spans (12 normally, 1-15 for a transition year). */
  months: number;
  /**
   * True only for a template year of a company with no usable
   * financial_year_start: its range ASSUMES a March start (the read-path
   * default). Strict readers (the AFS) refuse it — see assertDeclaredBasis.
   */
  assumed: boolean;
}

/** A strict reader met a year built on an assumed (March) start month. */
export class StartMonthAssumedError extends Error {
  constructor(readonly companyId: string, readonly fiscalYear: number) {
    super(`Company ${companyId} has no usable financial_year_start and no stored financial year covering FY${fiscalYear}; `
      + 'set the month its financial year begins (Settings > General) rather than have the statements assume March.');
    this.name = 'StartMonthAssumedError';
  }
}

/** For readers that must not guess (the AFS, filed with CIPC): refuse an assumed year. */
export function assertDeclaredBasis(companyId: string, year: FiscalYearRecord): FiscalYearRecord {
  if (year.assumed) throw new StartMonthAssumedError(companyId, year.fiscalYear);
  return year;
}

/** Whole months from the first to the last day, both inclusive ('2026-01-01'..'2027-02-28' is 14). */
export function monthsSpanned(startDate: string, endDate: string): number {
  const [sy, sm] = startDate.split('-').map(Number) as [number, number];
  const [ey, em] = endDate.split('-').map(Number) as [number, number];
  return (ey * 12 + em) - (sy * 12 + sm) + 1;
}

/** The day before a 'YYYY-MM-DD' date, by integer components (no Date round-trip through UTC). */
export function dayBefore(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const prev = new Date(y, m - 1, d - 1);
  return fmtDate(prev);
}

function mapYear(r: DbRow): FiscalYearRecord {
  const startDate = fmtDate(r.start_date);
  const endDate = fmtDate(r.end_date);
  return {
    id: r.id ? String(r.id) : null,
    fiscalYear: Number(r.fiscal_year),
    startDate,
    endDate,
    status: String(r.status) as FiscalPeriodStatus,
    kind: String(r.kind) as FiscalYearKind,
    stored: Boolean(r.stored),
    months: monthsSpanned(startDate, endDate),
    assumed: r.assumed === true,
  };
}

/** The financial year holding `date`: the stored year, else the template year. */
export async function fiscalYearForDate(companyId: string, date: string): Promise<FiscalYearRecord> {
  // In a savepoint: the template can refuse (no free label, no usable start
  // month on a write path), and a raised error must not poison the caller's
  // request transaction.
  const rows = (await withSavepoint('fy_for_date', () => sql`
    SELECT * FROM public.fiscal_year_for_date(${companyId}::UUID, ${fmtDate(date)}::DATE)
  `)) as DbRow[];
  if (rows.length === 0) throw new Error(`fiscalYearForDate: no fiscal year for company ${companyId} on ${date}`);
  return mapYear(rows[0]!);
}

/** The financial year labelled `fiscalYear`, or null when the template skips that label. */
export async function getFiscalYear(companyId: string, fiscalYear: number): Promise<FiscalYearRecord | null> {
  if (!Number.isInteger(fiscalYear)) throw new Error(`getFiscalYear: invalid fiscal year ${String(fiscalYear)}`);
  const rows = (await withSavepoint('fy_for_label', () => sql`
    SELECT * FROM public.fiscal_year_for_label(${companyId}::UUID, ${fiscalYear}::INT)
  `)) as DbRow[];
  return rows[0] ? mapYear(rows[0]) : null;
}

/** As getFiscalYear, refusing a label no year carries. */
export async function requireFiscalYear(companyId: string, fiscalYear: number): Promise<FiscalYearRecord> {
  const year = await getFiscalYear(companyId, fiscalYear);
  if (!year) throw new Error(`Company ${companyId} has no financial year labelled ${fiscalYear}`);
  return year;
}

/** The year immediately before `year`: the one holding the day before it starts. */
export async function priorFiscalYear(companyId: string, year: FiscalYearRecord): Promise<FiscalYearRecord> {
  return fiscalYearForDate(companyId, dayBefore(year.startDate));
}

/** Every stored year, oldest first. */
export async function listFiscalYears(companyId: string): Promise<FiscalYearRecord[]> {
  const rows = (await sql`
    -- assumed as fiscal_year_for_date reads it: the stored flag counts only while
    -- the company still declares no usable start month.
    SELECT fy.id, fy.fiscal_year, fy.start_date, fy.end_date, fy.status, fy.kind, true AS stored,
           fy.assumed_start AND NOT COALESCE(c.financial_year_start BETWEEN 1 AND 12, false) AS assumed
      FROM fiscal_years fy JOIN companies c ON c.id = fy.company_id
     WHERE fy.company_id = ${companyId}::UUID
     ORDER BY fy.start_date
  `) as DbRow[];
  return rows.map(mapYear);
}

export interface PeriodForDate {
  id: string;
  fiscalYearId: string;
  fiscalYear: number;
  periodNumber: number;
  startDate: string;
  endDate: string;
  status: FiscalPeriodStatus;
}

/** The fiscal period whose range holds `date`, or null when none exists yet. */
export async function periodForDate(companyId: string, date: string): Promise<PeriodForDate | null> {
  const rows = (await sql`
    SELECT id, fiscal_year_id, fiscal_year, period_number, start_date, end_date, status
      FROM fiscal_periods
     WHERE company_id = ${companyId}::UUID AND ${fmtDate(date)}::DATE BETWEEN start_date AND end_date
     ORDER BY start_date
     LIMIT 1
  `) as DbRow[];
  const r = rows[0];
  if (!r) return null;
  return {
    id: String(r.id),
    fiscalYearId: String(r.fiscal_year_id),
    fiscalYear: Number(r.fiscal_year),
    periodNumber: Number(r.period_number),
    startDate: fmtDate(r.start_date),
    endDate: fmtDate(r.end_date),
    status: String(r.status) as FiscalPeriodStatus,
  };
}

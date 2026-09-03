/**
 * EMP201 Generation Service
 * Reads SARS EMP201 (PAYE/UIF/SDL) totals from Phase 1 payroll tables
 * (payroll_run_headers). Gracefully returns zero-filled data if the
 * tables have not yet been created (clean-install safety net).
 *
 * Legacy tables (payroll_runs, payslips) were dropped in migration 384.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { EMP201_DECLARABLE_STATUSES } from '@/lib/constants/payrollRunStatuses';

type Row = DbRow;

export interface EMP201Data {
  periodStart: string;
  periodEnd: string;
  /** Gross PAYE withheld from employees, before the ETI offset. */
  totalPAYE: number;
  /** Employment Tax Incentive claimed for the period — an offset against PAYE. */
  totalETI: number;
  /** PAYE actually remitted to SARS: totalPAYE − totalETI, floored at zero. */
  payePayable: number;
  totalUIF_employee: number;
  totalUIF_employer: number;
  totalUIF: number;
  totalSDL: number;
  employeeCount: number;
  totalTaxableRemuneration: number;
  totalDeductions: number;
  payrollRuns: EMP201PayrollRun[];
}

export interface EMP201PayrollRun {
  id: string;
  /** ISO date string constructed from period_year + period_month (first of month) */
  runDate: string;
  employeeCount: number;
  grossPay: number;
  paye: number;
  /** ETI claimed on this run — offsets `paye` when remitting. */
  eti: number;
  uif: number;
  sdl: number;
}

function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Generate EMP201 (monthly PAYE/UIF/SDL) data from Phase 1 payroll_run_headers.
 *
 * Note on UIF split: payroll_run_headers stores total_uif as a single combined
 * value (employee + employer). Phase 4 will aggregate per-line employee/employer
 * UIF from payroll_run_lines. Until then we approximate 50/50.
 */
export async function generateEMP201(
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<EMP201Data> {
  log.info('Generating EMP201', { companyId, periodStart, periodEnd }, 'emp201Service');

  const emptyResult: EMP201Data = {
    periodStart,
    periodEnd,
    totalPAYE: 0,
    totalETI: 0,
    payePayable: 0,
    totalUIF_employee: 0,
    totalUIF_employer: 0,
    totalUIF: 0,
    totalSDL: 0,
    employeeCount: 0,
    totalTaxableRemuneration: 0,
    totalDeductions: 0,
    payrollRuns: [],
  };

  let tablesReady = false;
  try {
    const tables = (await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('payroll_run_headers', 'payroll_run_lines')
    `) as Row[];
    tablesReady = tables.length >= 2;
  } catch (err) {
    log.warn('Could not check payroll tables', { error: err }, 'emp201Service');
  }

  if (!tablesReady) {
    log.info('Payroll tables not found, returning empty EMP201', {}, 'emp201Service');
    return emptyResult;
  }

  try {
    const startDate = periodStart.slice(0, 10);
    const endDate = periodEnd.slice(0, 10);
    // Bound as an array rather than inlined literals so the vocabulary lives in
    // exactly one place (@/lib/constants/payrollRunStatuses).
    const declarableStatuses: string[] = [...EMP201_DECLARABLE_STATUSES];

    const runs = (await sql`
      SELECT
        prh.id,
        prh.period_month,
        prh.period_year,
        prh.employee_count,
        prh.total_gross,
        prh.total_paye,
        prh.total_uif,
        prh.total_sdl,
        prh.total_eti
      FROM payroll_run_headers prh
      WHERE prh.company_id = ${companyId}::uuid
        AND prh.status = ANY(${declarableStatuses}::text[])
        AND make_date(prh.period_year, prh.period_month, 1) >= ${startDate}::date
        AND make_date(prh.period_year, prh.period_month, 1) <= ${endDate}::date
      ORDER BY prh.period_year, prh.period_month
    `) as Row[];

    if (runs.length === 0) return emptyResult;

    let totalPAYE = 0;
    let totalETI = 0;
    let totalUIF = 0;
    let totalSDL = 0;
    let totalGross = 0;
    let maxEmployeeCount = 0;

    const payrollRuns: EMP201PayrollRun[] = runs.map((r: Row) => {
      const paye = Number(r.total_paye) || 0;
      // total_eti is NOT NULL in the schema, but a NULL from a LEFT-joined or
      // legacy row must degrade to 0 rather than NaN-ing the whole declaration.
      const eti = Number(r.total_eti) || 0;
      const uif = Number(r.total_uif) || 0;
      const sdl = Number(r.total_sdl) || 0;
      const gross = Number(r.total_gross) || 0;
      const count = Number(r.employee_count) || 0;

      totalPAYE += paye;
      totalETI += eti;
      totalUIF += uif;
      totalSDL += sdl;
      totalGross += gross;
      maxEmployeeCount = Math.max(maxEmployeeCount, count);

      const month = String(r.period_month).padStart(2, '0');
      return {
        id: String(r.id),
        runDate: `${r.period_year}-${month}-01`,
        employeeCount: count,
        grossPay: roundCents(gross),
        paye: roundCents(paye),
        eti: roundCents(eti),
        uif: roundCents(uif),
        sdl: roundCents(sdl),
      };
    });

    // Phase 1 aggregates total_uif as combined employee+employer.
    // Phase 4 will split these by summing payroll_run_lines per employee/employer UIF.
    // Meanwhile, approximate 50/50.
    const uifEmployee = roundCents(totalUIF / 2);
    const uifEmployer = roundCents(totalUIF / 2);

    // ETI is an offset against PAYE, never a refund: SARS caps the claim at the
    // PAYE withheld for the month, so the payable side floors at zero.
    const payePayable = roundCents(Math.max(0, totalPAYE - totalETI));

    return {
      periodStart,
      periodEnd,
      totalPAYE: roundCents(totalPAYE),
      totalETI: roundCents(totalETI),
      payePayable,
      totalUIF_employee: uifEmployee,
      totalUIF_employer: uifEmployer,
      totalUIF: roundCents(totalUIF),
      totalSDL: roundCents(totalSDL),
      employeeCount: maxEmployeeCount,
      totalTaxableRemuneration: roundCents(totalGross),
      // Total remitted to SARS — PAYE net of ETI, plus UIF and SDL.
      totalDeductions: roundCents(payePayable + totalUIF + totalSDL),
      payrollRuns,
    };
  } catch (err) {
    log.warn('Error generating EMP201 from payroll data', { error: err }, 'emp201Service');
    return emptyResult;
  }
}

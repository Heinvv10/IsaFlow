/**
 * EMP201 Generation Service
 * Generates SARS EMP201 (PAYE/UIF/SDL) data from payroll tables.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = Record<string, unknown>;

export interface EMP201Data {
  periodStart: string;
  periodEnd: string;
  totalPAYE: number;
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
  runDate: string;
  employeeCount: number;
  grossPay: number;
  paye: number;
  uif: number;
  sdl: number;
}

function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Generate EMP201 (monthly PAYE/UIF/SDL) data from payroll tables.
 * Handles missing payroll tables gracefully by returning zero-filled data.
 */
export async function generateEMP201(companyId: string,
  periodStart: string,
  periodEnd: string
): Promise<EMP201Data> {
  log.info('Generating EMP201', { companyId, periodStart, periodEnd }, 'emp201Service');

  const emptyResult: EMP201Data = {
    periodStart,
    periodEnd,
    totalPAYE: 0,
    totalUIF_employee: 0,
    totalUIF_employer: 0,
    totalUIF: 0,
    totalSDL: 0,
    employeeCount: 0,
    totalTaxableRemuneration: 0,
    totalDeductions: 0,
    payrollRuns: [],
  };

  let hasPayrollTables = false;
  try {
    const tables = (await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('payroll_runs', 'payslips')
    `) as Row[];
    hasPayrollTables = tables.length >= 2;
  } catch (err) {
    log.warn('Could not check payroll tables', { error: err }, 'emp201Service');
  }

  if (!hasPayrollTables) {
    log.info('Payroll tables not found, returning empty EMP201', {}, 'emp201Service');
    return emptyResult;
  }

  try {
    const runs = (await sql`
      SELECT
        pr.id,
        pr.run_date,
        COUNT(DISTINCT ps.employee_id) AS employee_count,
        COALESCE(SUM(ps.gross_pay), 0) AS gross_pay,
        COALESCE(SUM(ps.paye), 0) AS paye,
        COALESCE(SUM(ps.uif_employee), 0) AS uif_employee,
        COALESCE(SUM(ps.uif_employer), 0) AS uif_employer,
        COALESCE(SUM(ps.sdl), 0) AS sdl
      FROM payroll_runs pr
      LEFT JOIN payslips ps ON ps.payroll_run_id = pr.id
      WHERE pr.company_id = ${companyId}::UUID
        AND pr.run_date >= ${periodStart}
        AND pr.run_date <= ${periodEnd}
        AND pr.status != 'cancelled'
      GROUP BY pr.id, pr.run_date
      ORDER BY pr.run_date
    `) as Row[];

    if (runs.length === 0) return emptyResult;

    let totalPAYE = 0;
    let totalUIFEmployee = 0;
    let totalUIFEmployer = 0;
    let totalSDL = 0;
    let totalGross = 0;

    const payrollRuns: EMP201PayrollRun[] = runs.map((r: Row) => {
      const paye = Number(r.paye) || 0;
      const uifEmp = Number(r.uif_employee) || 0;
      const uifEr = Number(r.uif_employer) || 0;
      const sdl = Number(r.sdl) || 0;
      const gross = Number(r.gross_pay) || 0;

      totalPAYE += paye;
      totalUIFEmployee += uifEmp;
      totalUIFEmployer += uifEr;
      totalSDL += sdl;
      totalGross += gross;

      return {
        id: String(r.id),
        runDate: String(r.run_date),
        employeeCount: Number(r.employee_count) || 0,
        grossPay: roundCents(gross),
        paye: roundCents(paye),
        uif: roundCents(uifEmp + uifEr),
        sdl: roundCents(sdl),
      };
    });

    const totalUIF = roundCents(totalUIFEmployee + totalUIFEmployer);
    const totalDeductions = roundCents(totalPAYE + totalUIF + totalSDL);

    return {
      periodStart,
      periodEnd,
      totalPAYE: roundCents(totalPAYE),
      totalUIF_employee: roundCents(totalUIFEmployee),
      totalUIF_employer: roundCents(totalUIFEmployer),
      totalUIF,
      totalSDL: roundCents(totalSDL),
      employeeCount: payrollRuns.reduce((max, r) => Math.max(max, r.employeeCount), 0),
      totalTaxableRemuneration: roundCents(totalGross),
      totalDeductions,
      payrollRuns,
    };
  } catch (err) {
    log.warn('Error generating EMP201 from payroll data', { error: err }, 'emp201Service');
    return emptyResult;
  }
}

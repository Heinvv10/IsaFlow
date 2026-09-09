import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { calculateSDL } from './sdlEngine';
import type { PayrollPeriod } from './payrollTypes';

/**
 * Section 4(b) of the Skills Development Levies Act exempts an employer whose
 * total REMUNERATION payable to all employees over a 12-month window does not
 * exceed R500,000. Two things follow, and both are easy to get wrong.
 *
 * 1. The test is on remuneration, not on the leviable subset. Gating on
 *    SDL-applicable earnings alone would let one component flagged
 *    `is_sdl_applicable = false` switch the levy off for the whole employer,
 *    when the flag should only remove that component from the 1% charge.
 * 2. The test spans a year, not a month. Annualising a single run by twelve
 *    makes a 13th-cheque month look like a R1m payroll and a short month look
 *    like an exempt one, so the gate would oscillate with pay.
 *
 * So the basis is the company's own trailing twelve periods of gross pay: the
 * eleven periods before this run plus this run. Periods with no calculated run
 * are not counted as zero — the mean of the periods that do exist is annualised
 * instead, which reduces to `thisRun * 12` for a company's very first run and to
 * the exact twelve-month total once a full year of history exists.
 */

const TRAILING_PERIODS = 12;

export interface SdlLine {
  sdl: number;
  sdlLeviable: number;
}

function periodIndex(year: number, month: number): number {
  return year * 12 + month;
}

export async function estimateAnnualRemuneration(
  companyId: string,
  period: PayrollPeriod,
  currentPeriodGross: number,
): Promise<number> {
  const index = periodIndex(period.year, period.month);
  const rows = (await sql`
    SELECT COALESCE(SUM(total_gross), 0)::float8 AS gross_sum,
           COUNT(*)::int AS period_count
    FROM payroll_run_headers
    WHERE company_id = ${companyId}::uuid
      AND status IN ('calculated', 'approved', 'paid')
      AND total_gross > 0
      AND (period_year * 12 + period_month)
          BETWEEN ${index - (TRAILING_PERIODS - 1)} AND ${index - 1}
  `) as DbRow[];

  const priorGross = Number(rows[0]?.gross_sum ?? 0);
  const priorPeriods = Number(rows[0]?.period_count ?? 0);
  const mean = (priorGross + currentPeriodGross) / (priorPeriods + 1);
  return Math.round(mean * TRAILING_PERIODS * 100) / 100;
}

/**
 * Charge the levy on each line's own leviable remuneration, once the employer's
 * annual remuneration has decided whether it is due at all. Returns the run
 * total. Mutates `sdl` on the lines, which is why the caller builds them first.
 */
export function applySdlToLines(
  lines: SdlLine[],
  annualRemunerationEstimate: number,
  taxYear: number,
): number {
  let total = 0;
  for (const line of lines) {
    line.sdl = calculateSDL(line.sdlLeviable, annualRemunerationEstimate, taxYear);
    total += line.sdl;
  }
  return total;
}

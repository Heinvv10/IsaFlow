import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
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
 * eleven periods before this run plus this run.
 *
 * The denominator is elapsed CALENDAR months, not the number of runs found. A
 * company that has been running payroll for a year is measured over twelve
 * months whether or not it paid in every one of them, so a seasonal employer
 * paying R60,000 in six months of the year is read as R360,000 and stays
 * exempt. Dividing by the rows found instead would read it as R720,000 and levy
 * it. Only a company younger than twelve months extrapolates, because for it a
 * missing month is genuinely absent history rather than a month of no pay.
 *
 * This remains a proxy. Section 4(b) is a test the employer applies when it
 * registers, on the estimate for the FOLLOWING twelve months, and once
 * registered an employer declares SDL on every EMP201 until it deregisters —
 * SARS does not re-run the exemption monthly. An employer sitting on the line
 * can therefore flip between months here. A company-level "registered for SDL"
 * flag is the real answer; until there is one, the basis is logged so that a
 * nil-SDL month can be explained.
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
  runId: string,
): Promise<number> {
  const index = periodIndex(period.year, period.month);
  const windowStart = index - (TRAILING_PERIODS - 1);
  const rows = (await sql`
    SELECT COALESCE(SUM(total_gross) FILTER (
             WHERE (period_year * 12 + period_month) BETWEEN ${windowStart} AND ${index - 1}
           ), 0)::float8 AS window_gross,
           COUNT(*) FILTER (
             WHERE (period_year * 12 + period_month) BETWEEN ${windowStart} AND ${index - 1}
           )::int AS window_periods,
           MIN(period_year * 12 + period_month)::int AS first_index
    FROM payroll_run_headers
    WHERE company_id = ${companyId}::uuid
      AND status IN ('calculated', 'approved', 'paid')
      AND total_gross > 0
      AND (period_year * 12 + period_month) <= ${index}
  `) as DbRow[];

  const priorGross = Number(rows[0]?.window_gross ?? 0);
  const priorPeriods = Number(rows[0]?.window_periods ?? 0);
  const firstIndex = rows[0]?.first_index == null ? index : Number(rows[0].first_index);
  // Elapsed months of payroll history, this period included, capped at a year.
  const elapsedPeriods = Math.min(TRAILING_PERIODS, Math.max(1, index - firstIndex + 1));
  const annual = Math.round(
    ((priorGross + currentPeriodGross) / elapsedPeriods) * TRAILING_PERIODS * 100,
  ) / 100;

  // The estimate is not stored on the run, and it looks strictly backwards, so
  // recalculating an old period once later ones exist gives a different figure.
  // Log it or a nil-SDL month cannot be explained after the fact.
  log.info(
    'SDL leviability basis',
    { runId, companyId, annual, priorGross, priorPeriods, elapsedPeriods },
    'sdlLeviabilityService',
  );
  return annual;
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

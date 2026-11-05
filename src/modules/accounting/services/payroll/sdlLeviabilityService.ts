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
 * So the basis is the company's own trailing twelve periods of remuneration: the
 * eleven periods before this run plus this run.
 *
 * The 1% itself is charged on each line's leviable amount AFTER the para 2(4)
 * retirement deduction (payrollCalculator), but the threshold stays on
 * remuneration before it. The SDL guide's registration test speaks of the
 * "total leviable amount", so an after-deduction basis is arguably the stricter
 * reading; it is not used because the run header stores only total_gross, so
 * the trailing eleven periods could not be measured on that basis without a
 * migration, and mixing an after-deduction current month with gross history
 * would skew the estimate. Remuneration is never below the leviable amount, so
 * the error, when there is one, is towards levying: an employer just over
 * R500 000 whose leviable amount is not is still charged. Same proxy caveat as
 * below.
 *
 * Remuneration, not cash gross. A non-cash fringe benefit (the 3801 low-interest
 * loan benefit) is remuneration (Fourth Schedule para 1 (a): para (i) of "gross
 * income") but is not paid, so a run stores it outside gross_pay / total_gross,
 * as a breakdown item with `isNonCash: true` (payrollCalculator's design note).
 * An earlier month therefore counts as its total_gross PLUS its lines' non-cash
 * items, the same figure this month passes in (`currentPeriodRemuneration`).
 * Summing total_gross alone read eleven months of R41,000 + R1,000 benefit and
 * an identical month as R493,000 instead of R504,000, and exempted the employer.
 * A line from before the benefit was non-cash has it inside gross_pay and no
 * flag, so it is counted once; a breakdown that is not an array adds nothing.
 * The flag is on the line as it was costed, never re-read from the catalogue.
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
  currentPeriodRemuneration: number,
  runId: string,
): Promise<number> {
  const index = periodIndex(period.year, period.month);
  const windowStart = index - (TRAILING_PERIODS - 1);
  const rows = (await sql`
    WITH runs AS (
      SELECT prh.period_year * 12 + prh.period_month AS idx,
             -- The breakdown is read only inside the window: an older run counts only for the first
             -- month of history, which its cash gross decides (a run of benefits alone is not one).
             COALESCE(prh.total_gross, 0) + CASE WHEN prh.period_year * 12 + prh.period_month < ${windowStart} THEN 0 ELSE COALESCE((
               SELECT SUM((item->>'amount')::numeric)
                 FROM payroll_run_lines prl
                 CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(prl.component_breakdown) = 'array'
                   THEN prl.component_breakdown ELSE '[]'::jsonb END) item
                WHERE prl.run_id = prh.id
                  AND item->>'isNonCash' = 'true'
             ), 0) END AS remuneration
        FROM payroll_run_headers prh
       WHERE prh.company_id = ${companyId}::uuid
         AND prh.status IN ('calculated', 'approved', 'paid')
         AND (prh.period_year * 12 + prh.period_month) <= ${index}
    )
    SELECT COALESCE(SUM(remuneration) FILTER (WHERE idx BETWEEN ${windowStart} AND ${index - 1}), 0)::float8 AS window_remuneration,
           COUNT(*) FILTER (WHERE idx BETWEEN ${windowStart} AND ${index - 1})::int AS window_periods,
           MIN(idx)::int AS first_index
      FROM runs
     WHERE remuneration > 0
  `) as DbRow[];

  const priorRemuneration = Number(rows[0]?.window_remuneration ?? 0);
  const priorPeriods = Number(rows[0]?.window_periods ?? 0);
  const firstIndex = rows[0]?.first_index == null ? index : Number(rows[0].first_index);
  // Elapsed months of payroll history, this period included, capped at a year.
  // An empty window means there is no history to spread this month over, however
  // old the company is: a dormant shell resuming payroll, or migrated data
  // carrying one ancient run, would otherwise divide a R60,000 month by twelve
  // and read as exempt while paying R720,000 a year.
  const elapsedPeriods = priorPeriods === 0
    ? 1
    : Math.min(TRAILING_PERIODS, Math.max(1, index - firstIndex + 1));
  const annual = Math.round(
    ((priorRemuneration + currentPeriodRemuneration) / elapsedPeriods) * TRAILING_PERIODS * 100,
  ) / 100;

  // The estimate is not stored on the run, and it looks strictly backwards, so
  // recalculating an old period once later ones exist gives a different figure.
  // Log it or a nil-SDL month cannot be explained after the fact.
  log.info(
    'SDL leviability basis',
    { runId, companyId, annual, priorRemuneration, priorPeriods, elapsedPeriods },
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

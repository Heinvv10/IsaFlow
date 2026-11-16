import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { calculateSDL, isSdlExempt } from './sdlEngine';
import { withSdlCharge } from './statutoryExplain';
import type { LineExplanations } from './payrollExplainTypes';
import type { PayrollPeriod } from './payrollTypes';
import { contractorLineFlag } from './payrollOutsideTables';

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
  /** Set by applySdlToLines: the run was SDL-exempt (s4(b)), stored as sdl_exempt (migration 957). */
  sdlExempt?: boolean;
  /** The line's explanation (EX-core): applySdlToLines completes its SDL charge with the run's threshold decision. */
  explanation?: LineExplanations;
}

function periodIndex(year: number, month: number): number {
  return year * 12 + month;
}

/**
 * The employer's annual remuneration estimate for SDLA s4(b), as at `runId`'s month. `currentPeriodRemuneration`: the
 * figure the calculation is costing now, or 'stored' to take the run's own stored remuneration (the approval-time
 * re-judgement, payrollSdlMonthGate), so a calculation and its later re-judgement read the month the same way.
 */
export async function estimateAnnualRemuneration(
  companyId: string,
  period: PayrollPeriod,
  currentPeriodRemuneration: number | 'stored',
  runId: string,
): Promise<number> {
  const index = periodIndex(period.year, period.month);
  const windowStart = index - (TRAILING_PERIODS - 1);
  const rows = (await sql`
    WITH runs AS (
      SELECT prh.period_year * 12 + prh.period_month AS idx,
             -- The month's OTHER calculated, approved or paid runs (an off-cycle run beside the regular one): their
             -- remuneration is this month's too, whatever order they were calculated or paid in (wave 6 FQb1).
             (prh.period_year * 12 + prh.period_month = ${index} AND prh.id <> ${runId}::uuid) AS same_month_other,
             (prh.id = ${runId}::uuid) AS is_this_run,
             -- The breakdown is read only inside the window: an older run counts only for the first
             -- month of history, which its cash gross decides (a run of benefits alone is not one).
             -- An independent contractor's fees are not remuneration (G21 p. 26): out of the threshold basis (PAYE_OUTSIDE_TABLES, treatment none).
             COALESCE(prh.total_gross, 0) - COALESCE((
               SELECT SUM(prl.gross_pay) FROM payroll_run_lines prl
                WHERE prl.run_id = prh.id AND prl.validation_results @> ${contractorLineFlag}::jsonb
             ), 0) + CASE WHEN prh.period_year * 12 + prh.period_month < ${windowStart} THEN 0 ELSE COALESCE((
               SELECT SUM((item->>'amount')::numeric)
                 FROM payroll_run_lines prl
                 CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(prl.component_breakdown) = 'array'
                   THEN prl.component_breakdown ELSE '[]'::jsonb END) item
                WHERE prl.run_id = prh.id
                  AND item->>'isNonCash' = 'true'
                  AND NOT COALESCE(prl.validation_results @> ${contractorLineFlag}::jsonb, false)
             ), 0) END AS remuneration
        FROM payroll_run_headers prh
       WHERE prh.company_id = ${companyId}::uuid
         AND prh.status IN ('calculated', 'approved', 'paid')
         AND (prh.period_year * 12 + prh.period_month) <= ${index}
    )
    SELECT COALESCE(SUM(remuneration) FILTER (WHERE idx BETWEEN ${windowStart} AND ${index - 1}), 0)::float8 AS window_remuneration,
           COUNT(*) FILTER (WHERE idx BETWEEN ${windowStart} AND ${index - 1})::int AS window_periods,
           MIN(idx)::int AS first_index,
           COALESCE(SUM(remuneration) FILTER (WHERE same_month_other), 0)::float8 AS month_others,
           (SELECT COALESCE(SUM(t.remuneration), 0) FROM runs t WHERE t.is_this_run)::float8 AS this_run_stored
      FROM runs
     WHERE remuneration > 0
  `) as DbRow[];
  const current = currentPeriodRemuneration === 'stored' ? Number(rows[0]?.this_run_stored ?? 0) : currentPeriodRemuneration;

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
  // One decision per month (wave 6 FQb1, review #1507 B4/B4b/B4c). The levy is due when the employer's remuneration over
  // the next twelve months is reasonably expected to exceed R500 000 (SDLA s4(b)); IsaFlow estimates that from the
  // trailing months' runs plus THIS MONTH's remuneration, and the month's remuneration is every calculated, approved or
  // paid run of it (regular and off-cycle) plus this run's own figure: so the order runs are calculated or paid in does
  // not move the decision, and a large bonus raises the estimate from its own month on. Two runs of a month can still
  // decide differently if one was calculated before the other existed: payrollSdlMonthGate refuses approval until both
  // are recalculated on the same month total.
  const monthOthers = Number(rows[0]?.month_others ?? 0);
  const monthRemuneration = monthOthers + current;
  const annual = Math.round(
    ((priorRemuneration + monthRemuneration) / elapsedPeriods) * TRAILING_PERIODS * 100,
  ) / 100;

  // The estimate is not stored on the run, and it looks strictly backwards, so
  // recalculating an old period once later ones exist gives a different figure.
  // Log it or a nil-SDL month cannot be explained after the fact.
  log.info(
    'SDL leviability basis',
    { runId, companyId, annual, priorRemuneration, priorPeriods, elapsedPeriods, monthOthers },
    'sdlLeviabilityService',
  );
  return annual;
}

/**
 * Charge the levy on each line's own leviable remuneration, once the employer's
 * annual remuneration has decided whether it is due at all. Returns the run
 * total. Mutates `sdl` and `sdlExempt` on the lines (the threshold decision, kept
 * with each line so the year to date knows which months were liable), which is
 * why the caller builds them first.
 */
export function applySdlToLines(
  lines: SdlLine[],
  annualRemunerationEstimate: number,
  taxYear: number,
): number {
  let total = 0;
  const exempt = isSdlExempt(annualRemunerationEstimate, taxYear);
  for (const line of lines) {
    line.sdlExempt = exempt;
    line.sdl = calculateSDL(line.sdlLeviable, annualRemunerationEstimate, taxYear);
    if (line.explanation) {
      line.explanation = {
        ...line.explanation,
        sdl: withSdlCharge(line.explanation.sdl, taxYear, { annualRemuneration: annualRemunerationEstimate, exempt, sdl: line.sdl }),
      };
    }
    total += line.sdl;
  }
  return total;
}

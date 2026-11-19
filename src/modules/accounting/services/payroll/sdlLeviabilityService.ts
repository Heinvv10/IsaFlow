import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { isSdlExempt, SDL_RATE } from './sdlEngine';
import { payRunFinalSql } from './payRunFinalSql';
import { withSdlCharge } from './statutoryExplain';
import type { LineExplanations } from './payrollExplainTypes';
import type { PayrollPeriod } from './payrollTypes';
import { contractorLineFlag } from './payrollOutsideTables';
import { payFrequencyOf } from './payrollFrequency';
import { periodsInYear } from './annualisationFactor';

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
  // The month's estimate (wave 6 FQd, review #1622, coordinator ruling: the month-to-date catch-up): every calculated,
  // approved or paid run of the month plus this one, and, for a weekly or fortnightly REGULAR run, at least this run
  // annualised by its own periods a year (52, 26) beside the month's runs of other frequencies and kinds, so the first
  // week of a month is not read as a whole month's pay. The liability it gives is monotonic within the month and the
  // levy catches up on earlier runs (sdlCatchUp).
  const self = ((await sql`
    SELECT pay_frequency, run_kind FROM payroll_run_headers WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
  `) as DbRow[])[0];
  const frequency = payFrequencyOf(self?.pay_frequency);
  const regular = self?.run_kind === 'regular';
  const rows = (await sql`
    WITH runs AS (
      SELECT prh.period_year * 12 + prh.period_month AS idx, prh.run_kind, prh.pay_frequency,
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
           COALESCE(SUM(remuneration) FILTER (WHERE same_month_other AND run_kind = 'regular' AND pay_frequency = ${self?.pay_frequency == null ? '' : String(self.pay_frequency)}), 0)::float8 AS month_same_frequency,
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
  const sameFrequency = Number(rows[0]?.month_same_frequency ?? 0);
  const periodic = regular && (frequency === 'weekly' || frequency === 'fortnightly') ? frequency : null;
  const projected = periodic ? (current * periodsInYear(periodic)) / TRAILING_PERIODS + monthOthers - sameFrequency : 0;
  const monthRemuneration = Math.max(monthOthers + current, projected);
  const annual = Math.round(
    ((priorRemuneration + monthRemuneration) / elapsedPeriods) * TRAILING_PERIODS * 100,
  ) / 100;

  // The estimate is not stored on the run, and it looks strictly backwards, so
  // recalculating an old period once later ones exist gives a different figure.
  // Log it or a nil-SDL month cannot be explained after the fact.
  log.info(
    'SDL leviability basis',
    {
      runId, companyId, annual, priorRemuneration, priorPeriods, elapsedPeriods, monthOthers, sameFrequency, periodic,
      // Which judgement this is: the run's costing, or the approval gate re-judging its month (payrollSdlMonthGate).
      source: currentPeriodRemuneration === 'stored' ? 'approval-gate' : 'calculation',
    },
    'sdlLeviabilityService',
  );
  return annual;
}

/**
 * The month-to-date catch-up (wave 6 FQd, review #1622, coordinator ruling; the same model as UIF's month cap). OC extends
 * it for off-cycle runs. At each run of a month:
 *   - liable = this run's estimate says liable, OR any other costed run of the month (calculated, approved or paid) was
 *     liable: monotonic within the month, so a run is never sent back to reopen for SDL;
 *   - catch-up = the 1% the month's other FINAL runs' leviable amounts would carry, line by line, less the SDL they did
 *     carry (zero once they were liable; their whole 1% when they were exempt and this run tips the month);
 *   - this run's SDL = each line's own 1% plus the catch-up split by leviable share (applySdlToLines), so the month's
 *     SDL on the EMP201 is 1% of its leviable remuneration whenever the month ends liable.
 */
export interface SdlCatchUp { liable: boolean; catchUp: number; earlierLeviable: number; earlierSdl: number }

export async function sdlCatchUp(companyId: string, runId: string, liableNow: boolean): Promise<SdlCatchUp> {
  const rows = (await sql`
    WITH month AS (
      SELECT o.id, ${sql.unsafe(payRunFinalSql('o'))} AS final
        FROM payroll_run_headers me
        JOIN payroll_run_headers o ON o.company_id = me.company_id AND o.period_year = me.period_year
         AND o.period_month = me.period_month AND o.id <> me.id AND o.status IN ('calculated', 'approved', 'paid')
       WHERE me.id = ${runId}::uuid AND me.company_id = ${companyId}::uuid
    )
    SELECT COALESCE(bool_or(NOT l.sdl_exempt), false) AS liable_before,
           COALESCE(SUM(round(COALESCE(l.sdl_leviable, 0) * ${SDL_RATE}, 2)) FILTER (WHERE m.final), 0)::float8 AS owed,
           COALESCE(SUM(COALESCE(l.sdl_leviable, 0)) FILTER (WHERE m.final), 0)::float8 AS leviable,
           COALESCE(SUM(l.sdl) FILTER (WHERE m.final), 0)::float8 AS charged
      FROM month m JOIN payroll_run_lines l ON l.run_id = m.id
  `) as DbRow[];
  const r = rows[0] ?? {};
  const liable = liableNow || r.liable_before === true;
  const earlierSdl = Number(r.charged ?? 0);
  const catchUp = liable ? Math.max(0, Math.round((Number(r.owed ?? 0) - earlierSdl) * 100) / 100) : 0;
  return { liable, catchUp, earlierLeviable: Number(r.leviable ?? 0), earlierSdl };
}

/** This run's SDL as the catch-up gives it: each line's own 1% plus the catch-up (0 when exempt). */
export function lineSdlShares(leviables: number[], up: SdlCatchUp): number[] {
  if (!up.liable) return leviables.map(() => 0);
  const own = leviables.map((v) => Math.round(v * SDL_RATE * 100) / 100);
  if (up.catchUp === 0 || leviables.length === 0) return own;
  const total = leviables.reduce((a, b) => a + b, 0);
  const cents = Math.round(up.catchUp * 100);
  const shares = leviables.map((v, i) => (total > 0 ? Math.floor((cents * v) / total) : i === 0 ? cents : 0));
  let left = cents - shares.reduce((a, b) => a + b, 0);
  const order = leviables.map((v, i) => [v, i] as const).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left -= 1) shares[order[k]!] = shares[order[k]!]! + 1;
  return own.map((o, i) => Math.round((o * 100 + shares[i]!)) / 100);
}

/**
 * Charge the levy on the run's lines: the month's liability and catch-up (sdlCatchUp), each line's own 1% plus its
 * leviable share of the catch-up. Returns the run total. Mutates `sdl` and `sdlExempt` on the lines (the month's
 * decision, kept with each line), and completes each line's SDL explanation with the catch-up.
 */
export function applySdlToLines(
  lines: SdlLine[],
  annualRemunerationEstimate: number,
  taxYear: number,
  up: SdlCatchUp = { liable: !isSdlExempt(annualRemunerationEstimate, taxYear), catchUp: 0, earlierLeviable: 0, earlierSdl: 0 },
): number {
  const sdl = lineSdlShares(lines.map((l) => l.sdlLeviable), up);
  let total = 0;
  lines.forEach((line, i) => {
    line.sdlExempt = !up.liable;
    line.sdl = sdl[i]!;
    if (line.explanation) {
      line.explanation = {
        ...line.explanation,
        sdl: withSdlCharge(line.explanation.sdl, taxYear, {
          annualRemuneration: annualRemunerationEstimate, exempt: !up.liable, sdl: line.sdl,
          catchUp: up.catchUp > 0 ? { earlierLeviable: up.earlierLeviable, earlierSdl: up.earlierSdl, catchUp: up.catchUp } : undefined,
        }),
      };
    }
    total += line.sdl;
  });
  return Math.round(total * 100) / 100;
}

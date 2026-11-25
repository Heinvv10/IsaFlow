/**
 * The year to date's periods in the current line's pay frequency (wave 7 FQe, Hein ruling 23, engine 23). Pure.
 *
 * PAYE's cumulative annualisation (payeCumulative.ts) takes AE = remuneration to date x F / n and the liability to date
 * tax(AE) x n / F, with F the current line's factor (annualisationFactor.ts). Before FQe, n summed the earlier lines'
 * shares whatever their frequency, so after a mid-year change it added weeks to fortnights or months: four weeks then a
 * fortnight gave n = 5 fortnights (AE 249 600 on R416 000 a year, PAYE nil) instead of 3 (oracle
 * frequency-change-weekly-to-fortnightly; oracle-w7-fqe-diff.md).
 *
 * Sources:
 *  - PAYE-GEN-01-G21 (2027) Rev 1 p. 8-9, "ANNUAL EQUIVALENT CALCULATION" (Fourth Schedule para 9(1)/(2)): AE = "Total
 *    remuneration received/accrued X Total pay periods in tax year / Total pay periods worked", and the tax due is the
 *    annual tax divided "by the ratio which a full year bears to the periods in respect of which the remuneration was
 *    received or accrued". The operative quantity is the share of a year worked.
 *  - PAYE BRS (Employer Reconciliation V25 3.0) p. 33, 3210 "Pay periods worked": "The number of periods indicated in 3200
 *    for which the employee actually worked": the periods worked are counted in one interval, the one the year is divided
 *    into. That fixes the unit, not how a period of another length converts.
 *  - SARS is silent on a change of pay period: G21 has no rule or example for periods of two lengths in one year.
 *    So, UNVERIFIED (ruling 23: the conversion that matches days-based annualisation, wave-6 ruling 5 / AN): each earlier
 *    period counts the share of a year ITS OWN frequency's annualisation gave it, share / F_then (a week 1 / 52, a
 *    fortnight 1 / 26, a month 30.4166 / 365), expressed in the current frequency, x F_now. A constant annual salary then
 *    gives the current frequency's table figure on the first line after the change (the three oracle cases). The s11F cap
 *    periods are a statutory ratio (G21 p. 10, "the same ratio as the period ... bears to a whole year"; coordinator
 *    ruling 2026-11-17), so they convert by P, share x P_now / P_then (a month is 52 / 12 weeks there).
 *  - The line carries PAY_FREQUENCY_CHANGED_IN_YEAR (a warning) so the conversion is visible on the run.
 * A year to date without a breakdown by frequency (a hand-built one) is taken as the current frequency's, as before.
 */
import { annualisationFactor, periodsInYear } from './annualisationFactor';
import type { PayeYearToDate, ValidationResult } from './payrollTypes';
import type { PayFrequency } from './payrollTypesRun';

export const PAY_FREQUENCY_CHANGED = 'PAY_FREQUENCY_CHANGED_IN_YEAR';

const FREQUENCIES: readonly PayFrequency[] = ['weekly', 'fortnightly', 'monthly'];
const UNIT: Record<PayFrequency, string> = { weekly: 'weeks', fortnightly: 'fortnights', monthly: 'months' };
const at4dp = (n: number): string => String(Math.round(n * 10_000) / 10_000);

type ByFrequency = Partial<Record<PayFrequency, number>>;

function convert(by: ByFrequency, now: number, unitOf: (f: PayFrequency) => number): number {
  return FREQUENCIES.reduce((t, f) => t + ((by[f] ?? 0) * now) / unitOf(f), 0);
}

/** The year to date with `periods` and `retirementCapPeriods` in `frequency`'s periods, and the warning when it converted. */
export function ytdInFrequency(ytd: PayeYearToDate, frequency: PayFrequency): { ytd: PayeYearToDate; warnings: ValidationResult[] } {
  const by = ytd.periodsByFrequency;
  const capBy = ytd.retirementCapPeriodsByFrequency;
  const other = FREQUENCIES.filter((f) => f !== frequency && ((by?.[f] ?? 0) !== 0 || (capBy?.[f] ?? 0) !== 0));
  if (!by || other.length === 0) return { ytd, warnings: [] };
  const periods = convert(by, annualisationFactor(frequency), annualisationFactor);
  const retirementCapPeriods = capBy ? convert(capBy, periodsInYear(frequency), periodsInYear) : ytd.retirementCapPeriods;
  const earlier = other.filter((f) => (by[f] ?? 0) !== 0)
    .map((f) => `${at4dp(by[f]!)} ${f} periods`).join(' and ');
  return {
    ytd: { ...ytd, periods, ...(retirementCapPeriods === undefined ? {} : { retirementCapPeriods }) },
    warnings: [{
      code: PAY_FREQUENCY_CHANGED, severity: 'warning',
      message: `The pay frequency changed this tax year${earlier ? ` (earlier: ${earlier})` : ''}: PAYE counts the earlier periods `
        + `as the share of a year each was, ${at4dp(periods)} ${UNIT[frequency]} before this one. SARS's guide (PAYE-GEN-01-G21 (2027) `
        + 'Rev 1 p. 8-9) does not say how to count pay periods across a change of pay frequency, so this conversion is UNVERIFIED.',
    }],
  };
}

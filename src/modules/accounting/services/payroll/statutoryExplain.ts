/**
 * The UIF, SDL and ETI explanations of a line (wave 5 EX-core). Pure; they arrange the engines' figures (the UIF
 * leviable amount, sdlLeviableTrace, the SDL threshold decision, the ETI result with the table and remuneration the
 * engine applied) and compute none. Rates in the text come from the same constants the engines use.
 */
import { formatMoney } from '@/lib/money/formatMoney';
import { UIF_RATE } from './uifEngine';
import { SDL_RATE } from './sdlEngine';
import { getTaxYearConfig } from './taxTables';
import type { EtiBand, EtiTable } from './etiTables';
import { earningStep } from './earningExplain';
import type { EarningPart } from './payrollLineAccumulate';
import type { SdlLeviableTrace } from './sdlLeviableCumulative';
import type { EtiResult, UifResult } from './payrollTypes';
import { SOURCES, footed, pct, sourceFor, type ExplainStep, type FigureExplanation } from './payrollExplainTypes';

const r = (n: number) => formatMoney(n);

export function explainUif(input: {
  taxYear: number; uif: UifResult; leviable: number | null; uifRemuneration: number; parts: EarningPart[]; outsideReason: string | null;
}): FigureExplanation {
  const { uif, taxYear, leviable } = input;
  const base = { figure: 'uif' as const, title: 'How UIF was calculated', result: uif.employeeContribution, resultLabel: 'UIF, employee (the employer pays the same)' };
  if (input.outsideReason || leviable === null) {
    return { ...base, steps: [{ key: 'uif.none', label: input.outsideReason ?? 'No UIF was taken on this line', amount: 0 }] };
  }
  return {
    ...base,
    steps: [
      footed({ key: 'uif.remuneration', label: 'Pay that UIF applies to this period', amount: input.uifRemuneration, note: 'Earnings flagged as UIF-applicable.' },
        input.parts.filter((p) => p.uif).map((p, i) => earningStep(`uif.earning.${i}`, p))),
      { key: 'uif.ceiling', label: 'Monthly ceiling', amount: getTaxYearConfig(taxYear).uifCeiling, source: sourceFor(SOURCES.uif, taxYear) },
      { key: 'uif.leviable', label: 'Pay the contribution is on', amount: leviable, formula: 'the lesser of the pay and the ceiling' },
      { key: 'uif.rate', label: 'Rate, each of employee and employer', amount: UIF_RATE, unit: 'percent' },
      { key: 'uif.employee', label: 'Employee contribution', amount: uif.employeeContribution, formula: `${pct(UIF_RATE)} × ${r(leviable)}, rounded to the cent` },
      { key: 'uif.employer', label: 'Employer contribution', amount: uif.employerContribution },
    ],
  };
}

/** Why SDL is not charged yet on a line costed for a whole run: the run's threshold decision completes it (withSdlCharge). */
const SDL_PENDING = 'sdl.pending';

export function explainSdl(input: {
  taxYear: number; outsideReason: string | null; sdlApplicable: number; parts: EarningPart[]; deduction: number; retirementDeduction: number; donationDeduction: number;
  trace: SdlLeviableTrace | null; charge: { annualRemuneration: number; exempt: boolean; sdl: number } | 'deferred';
}): FigureExplanation {
  const { taxYear, trace } = input;
  const base = { figure: 'sdl' as const, title: 'How SDL was calculated', resultLabel: 'SDL this period' };
  if (input.outsideReason || !trace) {
    return { ...base, result: 0, steps: [{ key: 'sdl.none', label: input.outsideReason ?? 'No SDL on this line', amount: 0 }] };
  }
  const steps: ExplainStep[] = [
    footed({ key: 'sdl.applicable', label: 'SDL-applicable pay this period', amount: input.sdlApplicable, note: 'Earnings flagged as SDL-applicable, to the cent.' },
      input.parts.filter((p) => p.sdl).map((p, i) => earningStep(`sdl.earning.${i}`, p))),
    footed({
      key: 'sdl.deduction', label: 'The para 2(4) deductions this period', amount: input.deduction, formula: 'rounded to the cent',
      source: sourceFor(SOURCES.sdl, taxYear),
    }, [
      { key: 'sdl.deduction.retirement', label: 'Retirement fund deduction (as PAYE recorded it)', amount: input.retirementDeduction },
      { key: 'sdl.deduction.donation', label: 's18A donation allowed', amount: input.donationDeduction },
    ]),
    footed({ key: 'sdl.payToDate', label: 'SDL-applicable pay to date (liable months)', amount: trace.payToDate }, [
      { key: 'sdl.ytdApplicable', label: 'Earlier liable months', amount: trace.ytdSdlApplicable },
      { key: 'sdl.applicableNow', label: 'This period', amount: input.sdlApplicable },
    ]),
    footed({ key: 'sdl.deductionToDate', label: 'Deductions to date (liable months)', amount: trace.deductionToDate }, [
      { key: 'sdl.ytdDeduction', label: 'Earlier liable months', amount: trace.ytdSdlRetirementDeduction },
      { key: 'sdl.deductionNow', label: 'This period', amount: input.deduction },
    ]),
    { key: 'sdl.leviableToDate', label: 'Leviable to date', amount: trace.leviableToDate, formula: 'pay to date − deductions to date, between nil and the pay to date' },
    { key: 'sdl.carried', label: 'Less what earlier liable months were levied on', amount: trace.carried },
    { key: 'sdl.leviable', label: 'Leviable this period', amount: trace.leviable, formula: `${r(trace.leviableToDate)} − ${r(trace.carried)}, rounded to the cent, never below nil` },
  ];
  if (input.charge === 'deferred') {
    return { ...base, result: 0, steps: [...steps, { key: SDL_PENDING, label: 'The run decides whether the employer is liable', amount: null }] };
  }
  return { ...base, result: input.charge.sdl, steps: [...steps, ...chargeSteps(taxYear, trace.leviable, input.charge)] };
}

function chargeSteps(taxYear: number, leviable: number, charge: { annualRemuneration: number; exempt: boolean; sdl: number }): ExplainStep[] {
  return [
    {
      key: 'sdl.threshold', label: charge.exempt ? 'Employer exempt: remuneration at or under the threshold' : 'Employer liable: remuneration over the threshold',
      amount: getTaxYearConfig(taxYear).sdlThresholdAnnual, source: sourceFor(SOURCES.sdlThreshold, taxYear),
      children: [{ key: 'sdl.annualRemuneration', label: 'The employer\'s remuneration over twelve months (estimated)', amount: charge.annualRemuneration }],
    },
    { key: 'sdl.rate', label: 'Rate', amount: SDL_RATE, unit: 'percent' },
    { key: 'sdl.charge', label: 'SDL', amount: charge.sdl, formula: charge.exempt ? 'nil: exempt' : `${pct(SDL_RATE)} × ${r(leviable)}, rounded to the cent` },
  ];
}

/** The SDL explanation of a line costed with the threshold deferred, completed once the run has decided it (applySdlToLines). */
export function withSdlCharge(
  sdl: FigureExplanation, taxYear: number, charge: { annualRemuneration: number; exempt: boolean; sdl: number },
): FigureExplanation {
  const pending = sdl.steps.findIndex(s => s.key === SDL_PENDING);
  if (pending < 0) return { ...sdl, result: charge.sdl };
  const leviable = sdl.steps.find(s => s.key === 'sdl.leviable')?.amount ?? 0;
  return { ...sdl, result: charge.sdl, steps: [...sdl.steps.slice(0, pending), ...chargeSteps(taxYear, leviable, charge)] };
}

const BAND_ROW: Record<EtiBand, (t: EtiTable) => { label: string; formula: string }> = {
  low: (t) => ({ label: `Under ${r(t.lowBandCeiling)}: ${pct(t.lowBandRate)} of remuneration`, formula: `${pct(t.lowBandRate)} × remuneration` }),
  flat: (t) => ({ label: `${r(t.lowBandCeiling)} to under ${r(t.taperStart)}: a flat ${r(t.maxMonthlyEti)}`, formula: r(t.maxMonthlyEti) }),
  taper: (t) => ({
    label: `${r(t.taperStart)} to under ${r(t.wageCeiling)}: tapering`,
    formula: `${r(t.maxMonthlyEti)} − ${pct(t.taperRate)} × (remuneration − ${r(t.taperStart)})`,
  }),
  nil: (t) => ({ label: `${r(t.wageCeiling)} or more: nil`, formula: 'nil' }),
};

export function explainEti(input: { taxYear: number; eti: EtiResult; periodDate: Date; hasPayeShare: boolean }): FigureExplanation {
  const { eti, taxYear } = input;
  const base = { figure: 'eti' as const, title: 'How ETI was calculated', result: eti.monthlyEti, resultLabel: 'ETI this period' };
  if (!eti.isEligible || !eti.applied || eti.employmentYear === null) {
    const why = !eti.isDeterminable
      ? `Not determined: the employee's ${eti.missingInputs.map(m => m.replace(/_/g, ' ')).join(' and ')} ${eti.missingInputs.length > 1 ? 'are' : 'is'} missing`
      : eti.ineligibilityReason ?? 'Not eligible';
    return { ...base, steps: [{ key: 'eti.ineligible', label: 'No ETI', amount: 0, note: why, source: sourceFor(SOURCES.eti, taxYear) }] };
  }
  const { table, remuneration, hours, tabled, share, band, yearOne } = eti.applied;
  const row = BAND_ROW[band](table);
  const steps: ExplainStep[] = [
    {
      key: 'eti.remuneration', label: 'Monthly remuneration', amount: remuneration,
      note: input.hasPayeShare ? 'Cash remuneration for the month, a travel allowance at its PAYE share.' : 'Cash remuneration for the month.',
    },
    { key: 'eti.monthsEmployed', label: 'Months employed, this one included', amount: eti.monthsEmployed, unit: 'count' },
  ];
  if (hours !== null) {
    steps.push({ key: 'eti.hours', label: 'Hours employed and paid in the month', amount: hours, unit: 'count', source: sourceFor(SOURCES.eti, taxYear) });
    steps.push({
      key: 'eti.tabled', label: 'Remuneration for 160 hours (what the table reads)', amount: tabled,
      formula: hours < 160 ? `${r(remuneration)} × 160 ÷ ${hours}` : 'at least 160 hours: as paid', note: 'ETI Act s7(5).',
    });
  }
  steps.push({
    key: 'eti.band', label: `The table row: ${row.label}`, amount: yearOne, formula: row.formula, source: sourceFor(SOURCES.eti, taxYear),
    children: [
      { key: 'eti.table.lowBandCeiling', label: 'Low band below', amount: table.lowBandCeiling },
      { key: 'eti.table.lowBandRate', label: 'Low-band rate', amount: table.lowBandRate, unit: 'percent' },
      { key: 'eti.table.maxMonthlyEti', label: 'Flat amount', amount: table.maxMonthlyEti },
      { key: 'eti.table.taperStart', label: 'Taper starts at', amount: table.taperStart },
      { key: 'eti.table.taperRate', label: 'Taper rate', amount: table.taperRate, unit: 'percent' },
      { key: 'eti.table.wageCeiling', label: 'Nil at or above', amount: table.wageCeiling },
    ],
  });
  steps.push({
    key: 'eti.employmentYear', label: eti.employmentYear === 1 ? 'First 12 months of employment: the full amount' : 'Second 12 months: half the amount',
    amount: eti.employmentYear, unit: 'count', formula: eti.employmentYear === 1 ? 'the row amount' : 'the row amount ÷ 2',
  });
  if (hours !== null) {
    steps.push({ key: 'eti.share', label: 'Share of a full month (hours ÷ 160, at most all of it)', amount: share, unit: 'percent', formula: `× ${pct(share)}, rounded to the cent` });
  }
  return { ...base, steps };
}

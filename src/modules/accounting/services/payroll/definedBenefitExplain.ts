/**
 * DBF's explanation steps (wave 6, the EX-core contract: each engine PR adds its own explainer and one line in payrollExplain.ts).
 * A defined-benefit fund earning shows how the run valued it, X = A x B - C (definedBenefitFund.ts), with its three inputs as
 * parts, marked unverified; the PAYE explanation carries a caution while any line earning is one. Pure: the figures are the
 * accumulator's (EarningPart.db), never recomputed here.
 */
import { formatMoney } from '@/lib/money/formatMoney';
import { DB_FUND_SOURCE } from './definedBenefitFund';
import { pct, type ExplainStep, type FigureExplanation } from './payrollExplainTypes';
import type { EarningPart } from './payrollLineAccumulate';

/** The earning step of a defined-benefit row: its value with the factor, the RFI and the employee's contributions as parts. */
export function definedBenefitStep(key: string, label: string, p: EarningPart & { db: NonNullable<EarningPart['db']> }): ExplainStep {
  const { factor, rfi, employeeContribution } = p.db;
  return {
    key, label, amount: p.included, status: 'unverified', source: { label: DB_FUND_SOURCE },
    formula: `${pct(factor)} of ${formatMoney(rfi)} less ${formatMoney(employeeContribution)}, to the cent, not below nil`,
    children: [
      { key: `${key}.factor`, label: 'Fund member category factor (A)', amount: factor, unit: 'percent' },
      { key: `${key}.rfi`, label: 'Retirement-funding income (B)', amount: rfi },
      { key: `${key}.own`, label: 'The employee\'s own contributions to the fund (C)', amount: employeeContribution },
    ],
  };
}

/** The PAYE explanation with the defined-benefit caution added, when a line earning was valued from a factor. */
export function withDefinedBenefitCaution(paye: FigureExplanation, parts: readonly EarningPart[]): FigureExplanation {
  if (!parts.some((p) => p.db)) return paye;
  const note = 'A defined-benefit fund contribution on this line was valued from its fund member category factor (para 12D(3)); '
    + 'the formula is not confirmed against the Act. Check it against the fund\'s valuation.';
  return { ...paye, caution: paye.caution ? `${paye.caution} ${note}` : note };
}

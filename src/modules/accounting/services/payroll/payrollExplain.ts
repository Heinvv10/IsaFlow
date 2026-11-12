/**
 * payrollExplain — assembles a line's "How was this calculated?" record (wave 5 EX-core, spec §3a) from the figures
 * the engines expose to calculatePayrollLine. Pure. It never recomputes a figure: every amount comes from an engine
 * (payeCumulative's trace, the UIF result, sdlLeviableTrace, the ETI result); the explainers only arrange them.
 *
 * Each engine PR that merges after this one adds its own rule's steps in its own explainer and one line here.
 */
import { PAYROLL_CALCULATION_VERSION } from './payrollCalculationVersion';
import { explainPaye, type PayeExplainInput } from './payeExplain';
import { explainEti, explainSdl, explainUif } from './statutoryExplain';
import type { SdlLeviableTrace } from './sdlLeviableCumulative';
import type { EtiResult, UifResult } from './payrollTypes';
import type { LineExplanations } from './payrollExplainTypes';
import type { EarningPart } from './payrollLineAccumulate';

export interface LineExplainParts {
  taxYear: number;
  periodDate: Date;
  paye: Omit<PayeExplainInput, 'taxYear'>;
  uif: { uif: UifResult; leviable: number | null; uifRemuneration: number; parts: EarningPart[]; outsideReason: string | null };
  sdl: {
    outsideReason: string | null; sdlApplicable: number; parts: EarningPart[]; deduction: number; retirementDeduction: number; donationDeduction: number;
    trace: SdlLeviableTrace | null; charge: { annualRemuneration: number; exempt: boolean; sdl: number } | 'deferred';
  };
  eti: { eti: EtiResult };
}

export function explainPayrollLine(parts: LineExplainParts): LineExplanations {
  const { taxYear } = parts;
  return {
    schema: 1,
    taxYear,
    calculationVersion: PAYROLL_CALCULATION_VERSION,
    paye: explainPaye({ taxYear, ...parts.paye }),
    uif: explainUif({ taxYear, ...parts.uif }),
    sdl: explainSdl({ taxYear, ...parts.sdl }),
    eti: explainEti({ taxYear, periodDate: parts.periodDate, ...parts.eti }),
  };
}

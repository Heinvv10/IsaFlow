/**
 * payrollExplain — assembles a line's "How was this calculated?" record (wave 5 EX-core, spec §3a) from the figures
 * the engines expose to calculatePayrollLine. Pure. It never recomputes a figure: every amount comes from an engine
 * (payeCumulative's trace, the UIF result, sdlLeviableTrace, the ETI result); the explainers only arrange them.
 *
 * Each engine PR that merges after this one adds its own rule's steps in its own explainer and one line here.
 */
import { PAYROLL_CALCULATION_VERSION } from './payrollCalculationVersion';
import { explainPaye, type PayeExplainInput } from './payeExplain';
import { withDefinedBenefitCaution } from './definedBenefitExplain';
import { explainPspPaye } from './pspExplain';
import type { PspFacts } from './taxStatusTreatment';
import { explainEti, explainSdl, explainUif } from './statutoryExplain';
import { explainOffCycleEti, type OffCycleExplainInput } from './offCycleExplain';
import type { SdlLeviableTrace } from './sdlLeviableCumulative';
import type { EtiResult, UifResult } from './payrollTypes';
import type { LineExplanations } from './payrollExplainTypes';
import type { EarningPart } from './payrollLineAccumulate';

export interface LineExplainParts {
  taxYear: number;
  periodDate: Date;
  /** A personal service provider's entity and rate (wave 6 PSP), else null. */
  /** A PSP's entity and rate, with the flat rate's base (pspLineRules.pspPayeBase). */
  psp: (PspFacts & { base: number }) | null;
  paye: Omit<PayeExplainInput, 'taxYear'>;
  uif: { uif: UifResult; leviable: number | null; uifRemuneration: number; parts: EarningPart[]; outsideReason: string | null; monthToDate?: number;
    month?: { rebuilt: number; earlierPay: { employee: number; employer: number }; liability: { employee: number; employer: number }; booked: { employee: number; employer: number } } };
  sdl: {
    outsideReason: string | null; sdlApplicable: number; parts: EarningPart[]; deduction: number; retirementDeduction: number; donationDeduction: number;
    trace: SdlLeviableTrace | null; charge: { annualRemuneration: number; exempt: boolean; sdl: number } | 'deferred';
  };
  eti: { eti: EtiResult; hasPayeShare: boolean; hoursAssumed: boolean };
  /** An off-cycle line (OC): the month's earlier lines; the line's own ETI after them. */
  offCycle?: OffCycleExplainInput & { eti: number };
  /** A weekly or fortnightly line's period share (FQc); absent on a monthly line. */
  periodShare?: number;
}

export function explainPayrollLine(parts: LineExplainParts): LineExplanations {
  const { taxYear } = parts;
  return {
    schema: 1,
    taxYear,
    calculationVersion: PAYROLL_CALCULATION_VERSION,
    paye: withDefinedBenefitCaution(parts.psp ? explainPspPaye({ taxYear, ...parts.paye }, parts.psp) : explainPaye({ taxYear, ...parts.paye }), parts.paye.earningParts),
    uif: explainUif({ taxYear, ...parts.uif }),
    sdl: explainSdl({ taxYear, ...parts.sdl }),
    eti: ((e) => (parts.offCycle ? explainOffCycleEti(e, parts.offCycle, parts.offCycle.eti) : e))(explainEti({ taxYear, periodDate: parts.periodDate, ...parts.eti })),
    ...(parts.periodShare === undefined ? {} : { periodShare: parts.periodShare }),
  };
}

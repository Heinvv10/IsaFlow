// src/modules/accounting/services/afs/noteGenerators/index.ts
// Barrel export: all 30 note generators + NOTE_GENERATOR_MAP

import type { NoteContent, SectionType, ReportingFramework } from '@/modules/accounting/services/afs/afsTypes';

export type NoteGeneratorFn = (
  companyId: string,
  fiscalYear: number,
  framework: ReportingFramework,
) => Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }>;

// ── Notes 1–10 ───────────────────────────────────────────────────────────────

export {
  generateNote1AccountingPolicies,
  generateNote2SignificantEstimates,
  generateNote3PropertyPlantEquipment,
  generateNote4RightOfUseAssets,
  generateNote5IntangibleAssets,
  generateNote6InvestmentProperty,
  generateNote7InvestmentsInAssociates,
  generateNote8FinancialAssets,
  generateNote9Inventories,
  generateNote10TradeReceivables,
} from './notes1to10';

// ── Notes 11–20 ──────────────────────────────────────────────────────────────

export {
  generateNote11CashAndCashEquivalents,
  generateNote12ShareCapital,
  generateNote13Borrowings,
  generateNote14LeaseLiabilities,
  generateNote15Provisions,
  generateNote16TradePayables,
  generateNote17IncomeTax,
  generateNote18RevenueDisaggregation,
  generateNote19OtherIncome,
  generateNote20OperatingExpenses,
} from './notes11to20';

// ── Notes 21–30 ──────────────────────────────────────────────────────────────

export {
  generateNote21FinanceCosts,
  generateNote22EmployeeBenefits,
  generateNote23RelatedParties,
  generateNote24AuditorRemuneration,
  generateNote25ContingenciesAndCommitments,
  generateNote26EventsAfterReportingDate,
  generateNote27GoingConcern,
  generateNote28SegmentInformation,
  generateNote29FinancialInstrumentsRisk,
  generateNote30StandardsNotYetEffective,
} from './notes21to30';

// ── Adapters: wrap 2-arg generators to match 3-arg NoteGeneratorFn ───────────

import {
  generateNote1AccountingPolicies,
  generateNote2SignificantEstimates,
  generateNote3PropertyPlantEquipment,
  generateNote4RightOfUseAssets,
  generateNote5IntangibleAssets,
  generateNote6InvestmentProperty,
  generateNote7InvestmentsInAssociates,
  generateNote8FinancialAssets,
  generateNote9Inventories,
  generateNote10TradeReceivables,
} from './notes1to10';

import {
  generateNote11CashAndCashEquivalents,
  generateNote12ShareCapital,
  generateNote13Borrowings,
  generateNote14LeaseLiabilities,
  generateNote15Provisions,
  generateNote16TradePayables,
  generateNote17IncomeTax,
  generateNote18RevenueDisaggregation,
  generateNote19OtherIncome,
  generateNote20OperatingExpenses,
} from './notes11to20';

import {
  generateNote21FinanceCosts,
  generateNote22EmployeeBenefits,
  generateNote23RelatedParties,
  generateNote24AuditorRemuneration,
  generateNote25ContingenciesAndCommitments,
  generateNote26EventsAfterReportingDate,
  generateNote27GoingConcern,
  generateNote28SegmentInformation,
  generateNote29FinancialInstrumentsRisk,
  generateNote30StandardsNotYetEffective,
} from './notes21to30';

// Wrap all generators so the map has a uniform 3-arg signature.
// Framework-specific notes (4, 14, 28, 29) are included for all frameworks —
// their implementations already return placeholder content when not applicable.
function wrap(
  fn: (companyId: string, fiscalYear: number) => Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }>,
): NoteGeneratorFn {
  return (companyId, fiscalYear, _framework) => fn(companyId, fiscalYear);
}

export const NOTE_GENERATOR_MAP: Partial<Record<SectionType, NoteGeneratorFn>> = {
  note_1:  wrap(generateNote1AccountingPolicies),
  note_2:  wrap(generateNote2SignificantEstimates),
  note_3:  wrap(generateNote3PropertyPlantEquipment),
  note_4:  wrap(generateNote4RightOfUseAssets),
  note_5:  wrap(generateNote5IntangibleAssets),
  note_6:  wrap(generateNote6InvestmentProperty),
  note_7:  wrap(generateNote7InvestmentsInAssociates),
  note_8:  wrap(generateNote8FinancialAssets),
  note_9:  wrap(generateNote9Inventories),
  note_10: wrap(generateNote10TradeReceivables),
  note_11: wrap(generateNote11CashAndCashEquivalents),
  note_12: wrap(generateNote12ShareCapital),
  note_13: wrap(generateNote13Borrowings),
  note_14: wrap(generateNote14LeaseLiabilities),
  note_15: wrap(generateNote15Provisions),
  note_16: wrap(generateNote16TradePayables),
  note_17: wrap(generateNote17IncomeTax),
  note_18: wrap(generateNote18RevenueDisaggregation),
  note_19: wrap(generateNote19OtherIncome),
  note_20: wrap(generateNote20OperatingExpenses),
  note_21: wrap(generateNote21FinanceCosts),
  note_22: wrap(generateNote22EmployeeBenefits),
  note_23: wrap(generateNote23RelatedParties),
  note_24: wrap(generateNote24AuditorRemuneration),
  note_25: wrap(generateNote25ContingenciesAndCommitments),
  note_26: wrap(generateNote26EventsAfterReportingDate),
  note_27: wrap(generateNote27GoingConcern),
  note_28: wrap(generateNote28SegmentInformation),
  note_29: wrap(generateNote29FinancialInstrumentsRisk),
  note_30: wrap(generateNote30StandardsNotYetEffective),
};

// src/modules/accounting/services/afs/noteGenerators/notes21to30.ts
// Compatibility shim — actual code lives in notes21to25.ts and notes26to30.ts

export {
  generateNote21FinanceCosts,
  generateNote22EmployeeBenefits,
  generateNote23RelatedParties,
  generateNote24AuditorRemuneration,
  generateNote25ContingenciesAndCommitments,
} from './notes21to25';

export {
  generateNote26EventsAfterReportingDate,
  generateNote27GoingConcern,
  generateNote28SegmentInformation,
  generateNote29FinancialInstrumentsRisk,
  generateNote30StandardsNotYetEffective,
} from './notes26to30';

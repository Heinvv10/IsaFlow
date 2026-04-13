/**
 * SARS eFiling Integration Service — Facade
 * Re-exports from vat201Service, emp201Service, and sarsComplianceService
 * for backward compatibility.
 */

export type { VAT201Data, VAT201Invoice } from './vat201Service';
export { generateVAT201 } from './vat201Service';

export type { EMP201Data, EMP201PayrollRun } from './emp201Service';
export { generateEMP201 } from './emp201Service';

export type {
  TaxPeriod,
  ComplianceEvent,
  SARSSubmission,
} from './sarsComplianceService';

export {
  saveDraftSubmission,
  listSubmissions,
  getSubmission,
  markSubmitted,
  getTaxPeriods,
  getComplianceCalendar,
  getComplianceCalendarWithDB,
} from './sarsComplianceService';

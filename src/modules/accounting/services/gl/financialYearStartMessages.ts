/**
 * User-facing wording about changing a company's financial year start, shared
 * by the server's refusals (fiscalYearStartChange.ts) and Settings → General
 * (FinancialYearStartField.tsx). Pure: no imports, safe in the client bundle.
 */

/** The guided change of year end: the "Change financial year end" wizard (owner/admin). */
export const YEAR_END_CHANGE_MESSAGE = 'To change the financial year end, use "Change financial year end" '
  + '(owner or admin); it moves the year end through a transition year.';

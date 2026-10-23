/**
 * User-facing wording about changing a company's financial year start, shared
 * by the server's refusals (fiscalYearStartChange.ts) and Settings → General
 * (FinancialYearStartField.tsx). Pure: no imports, safe in the client bundle.
 */

/** True today: the guided change of year end is being built, not shipped. */
export const YEAR_END_CHANGE_MESSAGE = 'Changing the financial year end will be possible through a guided change of '
  + 'year end (coming soon); contact support if you need it now.';

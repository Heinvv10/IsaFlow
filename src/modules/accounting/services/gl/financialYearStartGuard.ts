/**
 * The compare-and-set on companies.financial_year_start (Hein, PR #1551): a
 * settings save writes the month only while the row still holds the month the
 * caller LOADED. A change of year end (apply / undo) that committed after the
 * page loaded would otherwise be silently reverted by the next save of the
 * whole settings form.
 *
 * The caller sends the month it loaded as `loadedFinancialYearStart`;
 * assertFinancialYearStartChange (fiscalYearStartChange.ts) judges it on the
 * LOCKED row, before anything is written (a 4xx commits the request
 * transaction). Callers that send no `financialYearStart` (MCP company_profile
 * update, admin PATCH) are not judged: the UPDATE keeps the row's own month
 * (COALESCE over the row version it locks), so they cannot write a stale one.
 */

import { normaliseStartMonth } from './fiscalYearCalendar';

export const COMPANY_SETTINGS_STALE_MESSAGE = 'Company settings changed since you loaded them — reload and try again';

/** The row's month is not the one the caller loaded. A 409, nothing was written. */
export class CompanySettingsStaleError extends Error {
  readonly code = 'COMPANY_SETTINGS_STALE';
  constructor() {
    super(COMPANY_SETTINGS_STALE_MESSAGE);
    this.name = 'CompanySettingsStaleError';
  }
}

/** financialYearStart sent without a usable loadedFinancialYearStart: it cannot be judged. A 400, nothing was written. */
export class FinancialYearStartLoadedMissingError extends Error {
  constructor(raw: unknown) {
    super('loadedFinancialYearStart (the month 1-12 the settings were loaded with) is required with financialYearStart, '
      + `got ${JSON.stringify(raw) ?? 'nothing'}. Reload the page and try again.`);
    this.name = 'FinancialYearStartLoadedMissingError';
  }
}

/**
 * The month the caller loaded, normalised as the row is read (NULL and 0 are
 * March): null, or an integer 0-12. Anything else, absence included, refuses.
 */
export function loadedStartMonth(raw: unknown): number {
  if (raw === null) return normaliseStartMonth(raw);
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > 12) {
    throw new FinancialYearStartLoadedMissingError(raw);
  }
  return normaliseStartMonth(raw);
}

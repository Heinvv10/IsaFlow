/**
 * The body Company Settings PUTs to /api/accounting/companies: the whole mapped
 * company, plus the financial year start month it was LOADED with. The server
 * writes financial_year_start only while the row still holds that month, and
 * otherwise answers 409 "Company settings changed since you loaded them"
 * (gl/financialYearStartGuard.ts), so a change of year end made since the page
 * loaded is never reverted by saving the form.
 */
import type { Company } from './settingsTypes';

export function companySavePayload(company: Company, loadedFinancialYearStart: number): Record<string, unknown> {
  return { ...company, loadedFinancialYearStart };
}

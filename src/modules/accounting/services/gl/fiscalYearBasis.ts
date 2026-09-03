/**
 * Fiscal year basis — when does a company's financial year start.
 *
 * Deliberately general-purpose and NOT trial-balance-specific. Five sites
 * already derive this ad hoc (`afs/cipcFilingGuideService.ts`,
 * `afs/pisCalculatorService.ts`, `afs/complianceAlertService.ts`,
 * `pages/api/payroll/period-context.ts`, `pages/api/accounting/afs/pis-score.ts`);
 * they are not migrated here, but a payroll or CIPC caller can import this
 * without importing something called "trialBalanceBasis".
 *
 * THE MARCH DEFAULT IS THE CALLER'S CHOICE, NEVER A SILENT ONE.
 * `companies.financial_year_start` is nullable. A `COALESCE(..., 3)` plus a
 * quiet 1-12 clamp means a December-year-end tenant whose value was never set
 * gets a year-end close a quarter out with nothing flagging it. So:
 * `getFiscalYearStartMonth(companyId)` REFUSES, and
 * `getFiscalYearStartMonth(companyId, { fallback: DEFAULT_FY_START_MONTH })`
 * defaults where a reader can see the assumption. Read paths that must survive
 * a misconfigured tenant may pass the fallback; close and year-end paths must
 * not. This mirrors what yearEndService does for retained earnings — refuse
 * rather than guess.
 *
 * Dates are 'YYYY-MM-DD' strings throughout: parsed by string split, never via
 * `new Date()` and never formatted with `.toISOString()`. On this UTC+2 host a
 * Date round-trip reports the previous day and shifts a year boundary — see
 * src/lib/pgTypes.ts.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/types/db';

/**
 * South African default (March). Every production company is on 3, i.e.
 * 1 March – 28/29 February, and it is the column default. Pass it explicitly
 * as a `fallback`; it is never applied on your behalf.
 */
export const DEFAULT_FY_START_MONTH = 3;

export interface FiscalYearOptions {
  /**
   * Month (1-12) to use when the company has no usable `financial_year_start`.
   * Omit to refuse instead — the right choice for close and year-end paths.
   */
  fallback?: number;
}

function isMonth(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 && n <= 12;
}

/**
 * Validate a raw `companies.financial_year_start` into a month.
 *
 * Shared by `getFiscalYearStartMonth` and by callers that already have the
 * column in hand from a joined query, so there is one implementation of what
 * counts as usable and one place the refusal is worded.
 *
 * @throws when the value is unusable and no `fallback` was given.
 */
export function resolveFiscalYearStartMonth(
  raw: unknown,
  companyId: string,
  options: FiscalYearOptions = {},
): number {
  const { fallback } = options;
  if (fallback !== undefined && !isMonth(Math.trunc(Number(fallback)))) {
    throw new Error(
      `resolveFiscalYearStartMonth: fallback must be a month 1-12, got ${String(fallback)}.`,
    );
  }

  const parsed = Math.trunc(Number(raw));
  if (raw !== null && raw !== undefined && raw !== '' && isMonth(parsed)) return parsed;

  if (fallback !== undefined) return Math.trunc(Number(fallback));

  throw new Error(
    `Company ${companyId} has no usable financial_year_start (found ${JSON.stringify(raw)}). ` +
    `Set companies.financial_year_start to the month its financial year begins (1-12, ` +
    `3 = 1 March for a standard South African year end). ` +
    `Refusing rather than assuming March, which would report this company a whole quarter out.`,
  );
}

/**
 * `companies.financial_year_start` as a month.
 *
 * @throws when the company does not exist — a missing company is a caller bug
 *   or a tenant-scoping failure, not a misconfigured tenant, and a `fallback`
 *   must not paper over it.
 * @throws when the value is unusable and no `fallback` was given.
 */
export async function getFiscalYearStartMonth(
  companyId: string,
  options: FiscalYearOptions = {},
): Promise<number> {
  const rows = (await sql`
    SELECT financial_year_start
    FROM companies
    WHERE id = ${companyId}::UUID
    LIMIT 1
  `) as DbRow[];

  if (rows.length === 0) {
    throw new Error(`getFiscalYearStartMonth: company ${companyId} not found.`);
  }
  return resolveFiscalYearStartMonth(rows[0]!.financial_year_start, companyId, options);
}

/**
 * First day of the fiscal year containing `date`.
 *
 * `fiscal_periods.fiscal_year` is calendar-based and useless for this: February
 * 2026 is stored as fiscal_year 2026 but belongs to the March-2025 fiscal year.
 *
 * @param date         'YYYY-MM-DD'. Parsed by string split, never `new Date()`.
 * @param fyStartMonth an already-resolved month 1-12 — see
 *   `resolveFiscalYearStartMonth`. Out of range throws rather than clamping to
 *   March, so a misconfiguration cannot enter here by the back door either.
 */
export function fiscalYearStart(date: string, fyStartMonth: number): string {
  if (!isMonth(fyStartMonth)) {
    throw new Error(
      `fiscalYearStart: fyStartMonth must be 1-12, got ${String(fyStartMonth)}. ` +
      `Resolve it with resolveFiscalYearStartMonth() first.`,
    );
  }

  const [yearPart, monthPart] = date.slice(0, 10).split('-');
  const year = Number(yearPart);
  const month = Number(monthPart);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    throw new Error(`fiscalYearStart: unparseable date '${date}'`);
  }

  const startMonth = Math.trunc(fyStartMonth);
  const fyYear = month >= startMonth ? year : year - 1;
  return `${String(fyYear).padStart(4, '0')}-${String(startMonth).padStart(2, '0')}-01`;
}

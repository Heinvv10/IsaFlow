/**
 * TEST FIXTURE, never imported by src/: P1's `primaryVersionScopeAndYears` exactly as it was on
 * master before PR #1124 (budgetVersionScope.ts at 8bb78345e~1), trimmed to that function and the
 * helpers it calls. The LB-2(b) adversarial suite runs the facade with this and with the live
 * function to prove the companies whose years all start on the 1st read byte-identically.
 *
 * Removal: this is only the oracle for the LB-2(b) byte-identity fuzz and the before/after repros;
 * delete it together with those suites when they are retired. Never import it from src/.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fiscalYearForDate, type FiscalYearRecord } from '@/modules/accounting/services/gl/fiscalYearRegistry';
import { addDaysISO } from '@/lib/dateUtils';
import { addMonthsToKey, budgetMonthBounds, monthKeyToDate } from '@/modules/accounting/services/reports/budgetPeriodWindow';
import type { VersionScope } from '@/modules/accounting/services/budgets/budgetVersionScope';

const MAX_YEARS_IN_WINDOW = 200;
const dayAfter = (date: string): string => addDaysISO(date, 1);

function clip(year: FiscalYearRecord, first: string, last: string): { first: string; last: string } | null {
  const own = budgetMonthBounds(year.startDate, year.endDate);
  if (!own) return null;
  const f = own.first > first ? own.first : first;
  const l = own.last < last ? own.last : last;
  return f <= l ? { first: f, last: l } : null;
}

async function yearsInWindow(companyId: string, startDate: string, endDate: string) {
  const bounds = budgetMonthBounds(startDate, endDate);
  const parts: Array<{ year: FiscalYearRecord; first: string; last: string }> = [];
  const visited: FiscalYearRecord[] = [];
  let day = startDate;
  let first = bounds?.first ?? startDate;
  while (visited.length === 0 || day <= endDate) {
    if (visited.length >= MAX_YEARS_IN_WINDOW) throw new Error(`budget window ${startDate}..${endDate} spans too many years`);
    const year = await fiscalYearForDate(companyId, day);
    visited.push(year);
    const part = bounds && day <= endDate && first <= bounds.last ? clip(year, first, bounds.last) : null;
    if (part) {
      parts.push({ year, ...part });
      first = monthKeyToDate(addMonthsToKey(part.last.slice(0, 7), 1));
    }
    day = dayAfter(year.endDate);
  }
  return { parts, visited };
}

export async function primaryVersionScopeAndYears(
  companyId: string, startDate: string, endDate: string,
): Promise<{ scope: VersionScope[]; years: FiscalYearRecord[] }> {
  const { parts, visited } = await yearsInWindow(companyId, startDate, endDate);
  if (parts.length === 0) return { scope: [], years: visited };
  const labels = parts.map((y) => y.year.fiscalYear);
  const prim = (await sql`
    SELECT id, fiscal_year FROM budget_versions
     WHERE company_id = ${companyId}::UUID AND is_primary AND fiscal_year = ANY(${labels}::INT[])
  `) as DbRow[];
  const byLabel = new Map(prim.map((r) => [Number(r.fiscal_year), String(r.id)]));
  return {
    scope: parts.map((y) => ({ fiscalYear: y.year.fiscalYear, versionId: byLabel.get(y.year.fiscalYear) ?? null, first: y.first, last: y.last })),
    years: visited,
  };
}

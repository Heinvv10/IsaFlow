/**
 * How the AFS describe the period they cover, when a year need not be twelve
 * months (change-of-year-end programme, Feature D).
 *
 * A 14-month transition year is presented "for the 14 months ended 28 February
 * 2027", and its comparative column says how many months IT covers. IAS 1.36:
 * when the reporting period is longer or shorter than a year, disclose that
 * period, the reason for using it, and the fact that the amounts presented are
 * not entirely comparable. The note is also given for the year AFTER a
 * transition year, whose comparative is the transition year.
 *
 * The reason comes from the change record (gl/financialYearEndChangeApply.ts).
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { assertDeclaredBasis, priorFiscalYear, requireFiscalYear } from '@/modules/accounting/services/gl/fiscalYearRegistry';

export interface PeriodSpan {
  start: string;
  end: string;
  months: number;
  /** "year ended 2027-02-28" or "14 months ended 2027-02-28". */
  phrase: string;
  /** The amount column's header, "Current year (R)" or "14 months to 2027-02-28 (R)". */
  header: string;
}

export interface ReportingPeriod {
  fiscalYear: number;
  current: PeriodSpan;
  prior: PeriodSpan;
  /** False when either period is not twelve months: the comparatives are not entirely comparable. */
  comparable: boolean;
  /** The IAS 1.36 disclosure, or null when both periods are twelve months. */
  comparabilityNote: string | null;
}

export function periodPhrase(months: number, end: string): string {
  return months === 12 ? `year ended ${end}` : `${months} months ended ${end}`;
}

function span(start: string, end: string, months: number, twelveHeader: string): PeriodSpan {
  return {
    start, end, months, phrase: periodPhrase(months, end),
    header: months === 12 ? twelveHeader : `${months} months to ${end} (R)`,
  };
}

async function changeReason(companyId: string, fiscalYearId: string | null): Promise<string | null> {
  if (!fiscalYearId) return null;
  const rows = (await sql`
    SELECT reason FROM fiscal_year_end_changes
     WHERE company_id = ${companyId}::UUID AND fiscal_year_id = ${fiscalYearId}::UUID AND reversed_at IS NULL
     ORDER BY applied_at DESC LIMIT 1
  `) as DbRow[];
  return rows[0] ? String(rows[0].reason) : null;
}

export async function getReportingPeriod(companyId: string, fiscalYear: number): Promise<ReportingPeriod> {
  // Strict, as every AFS range: no statement is built on an assumed start month.
  const year = assertDeclaredBasis(companyId, await requireFiscalYear(companyId, fiscalYear));
  const before = assertDeclaredBasis(companyId, await priorFiscalYear(companyId, year));
  const current = span(year.startDate, year.endDate, year.months, 'Current year (R)');
  const prior = span(before.startDate, before.endDate, before.months, 'Prior year (R)');
  const comparable = current.months === 12 && prior.months === 12;
  if (comparable) return { fiscalYear, current, prior, comparable, comparabilityNote: null };

  const parts: string[] = [];
  if (current.months !== 12) {
    const reason = await changeReason(companyId, year.id);
    parts.push(`These financial statements cover the ${current.months} months from ${current.start} to ${current.end}, `
      + 'because the entity changed its financial year end'
      + (reason ? ` (${reason.replace(/[.\s]+$/, '')}).` : '.'));
  }
  if (prior.months !== 12) {
    parts.push(`The comparative figures cover the ${prior.months} months from ${prior.start} to ${prior.end}.`);
  } else {
    parts.push(`The comparative figures cover the year from ${prior.start} to ${prior.end}.`);
  }
  parts.push('The amounts presented are therefore not entirely comparable (IAS 1.36).');
  return { fiscalYear, current, prior, comparable, comparabilityNote: parts.join(' ') };
}

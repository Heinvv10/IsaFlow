/**
 * Change of financial year end: the assessment shared by the preview (GET) and
 * the apply (POST). Everything a refusal needs is read here, so the preview
 * shows exactly what the apply would refuse.
 *
 * The transition year is the CURRENT financial year (the one holding today, or
 * the next one when that is already closed), stretched or shrunk to end on the
 * new year-end month (financialYearEndChangePlan.ts). Closed and locked periods
 * never move; posted journals keep their periods and dates.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { dayBefore, fiscalYearForDate, type FiscalYearRecord } from './fiscalYearRegistry';
import { planTransition, type TransitionOption } from './financialYearEndChangePlan';
import { budgetRehomeRefusals } from '../budgets/budgetYearRehome';

export interface YearEndChangeRequest {
  newYearEndMonth: number;
  /** Which option when the month allows both a shorter and a longer year. */
  kind?: 'shorten' | 'extend';
}

export interface MovingPeriod {
  id: string;
  periodName: string;
  startDate: string;
  status: string;
  postedJournals: number;
}

export interface YearEndChangeAssessment {
  currentYear: FiscalYearRecord;
  currentStartMonth: number;
  options: TransitionOption[];
  chosen: TransitionOption | null;
  /** Periods that change year: after the transition year's new end (shorten) or after its old end (extend). */
  movingPeriods: MovingPeriod[];
  refusals: string[];
  effects: string[];
}

export function todayLocal(): string {
  return fmtDate(new Date());
}

/** The year a change applies to: the one holding today, else (closed) the next. */
export async function currentFinancialYear(companyId: string, today: string): Promise<FiscalYearRecord> {
  const year = await fiscalYearForDate(companyId, today);
  if (year.status === 'closed' || year.status === 'locked') {
    const [y, m, d] = year.endDate.split('-').map(Number) as [number, number, number];
    return fiscalYearForDate(companyId, fmtDate(new Date(y, m - 1, d + 1)));
  }
  return year;
}

async function readStartMonth(companyId: string): Promise<number> {
  const rows = (await sql`SELECT financial_year_start FROM companies WHERE id = ${companyId}::UUID`) as DbRow[];
  if (!rows[0]) throw new Error(`Company ${companyId} not found`);
  const raw = Number(rows[0].financial_year_start);
  return Number.isInteger(raw) && raw >= 1 && raw <= 12 ? raw : 3;
}

async function readMovingPeriods(companyId: string, after: string): Promise<MovingPeriod[]> {
  const rows = (await sql`
    SELECT fp.id, fp.period_name, fp.start_date, fp.status,
           (SELECT COUNT(*)::int FROM gl_journal_entries je
             WHERE je.company_id = fp.company_id AND je.fiscal_period_id = fp.id AND je.status = 'posted') AS posted
      FROM fiscal_periods fp
     WHERE fp.company_id = ${companyId}::UUID AND fp.start_date > ${after}::DATE
     ORDER BY fp.start_date
  `) as DbRow[];
  return rows.map((r) => ({
    id: String(r.id), periodName: String(r.period_name), startDate: fmtDate(r.start_date),
    status: String(r.status), postedJournals: Number(r.posted),
  }));
}

/**
 * Everything the preview shows and the apply re-checks. `refusals` empty means
 * the change may be applied (the reason and confirmations are the apply's).
 */
export async function assessYearEndChange(
  companyId: string, request: YearEndChangeRequest, today: string = todayLocal(),
): Promise<YearEndChangeAssessment> {
  const currentYear = await currentFinancialYear(companyId, today);
  const currentStartMonth = await readStartMonth(companyId);
  const refusals: string[] = [];

  if (currentYear.assumed) {
    refusals.push('The company has no usable financial year start month; set it in Settings > General before changing the year end.');
  }
  if (currentYear.status !== 'open') {
    refusals.push(`FY${currentYear.fiscalYear} is ${currentYear.status}; only an open year can become a transition year.`);
  }
  const ye = (await sql`
    SELECT COUNT(*)::int AS n FROM gl_journal_entries
     WHERE company_id = ${companyId}::UUID AND source = 'year_end'
       AND entry_date BETWEEN ${currentYear.startDate}::DATE AND ${currentYear.endDate}::DATE
  `) as DbRow[];
  if (Number(ye[0]!.n) > 0) {
    refusals.push(`FY${currentYear.fiscalYear} already has a year-end closing journal; reverse it before changing the year end.`);
  }
  // s27(4)(a): not more than once during any financial year — the year being
  // changed AND the year the notice is filed in (closing a year early must not
  // reopen the allowance). An undone change still counts: the notice it
  // confirmed was filed with CIPC and cannot be unfiled.
  const filingYear = await fiscalYearForDate(companyId, today);
  const prior = (await sql`
    SELECT applied_at FROM fiscal_year_end_changes
     WHERE company_id = ${companyId}::UUID
       AND (applied_at AT TIME ZONE 'Africa/Johannesburg')::date
           BETWEEN LEAST(${filingYear.startDate}::DATE, ${currentYear.startDate}::DATE) AND ${currentYear.endDate}::DATE
     LIMIT 1
  `) as DbRow[];
  if (prior[0]) {
    refusals.push(`The year end was already changed during FY${currentYear.fiscalYear} `
      + `(${fmtDate(prior[0].applied_at)}); the Companies Act s27(4)(a) allows one change per financial year.`);
  }

  const plan = planTransition(currentYear, request.newYearEndMonth, today);
  refusals.push(...plan.refusals);
  let chosen: TransitionOption | null = null;
  if (plan.options.length === 1) chosen = plan.options[0]!;
  else if (plan.options.length > 1) {
    chosen = plan.options.find((o) => o.kind === request.kind) ?? null;
    if (!chosen) refusals.push('That month allows a shorter or a longer transition year: choose one.');
  }

  let movingPeriods: MovingPeriod[] = [];
  if (chosen) {
    const boundary = chosen.endDate < currentYear.endDate ? chosen.endDate : currentYear.endDate;
    movingPeriods = await readMovingPeriods(companyId, boundary);
    const fixed = movingPeriods.filter((p) => p.status !== 'open');
    if (fixed.length > 0) {
      refusals.push(`These periods would change year but are ${[...new Set(fixed.map((p) => p.status))].join('/')}: `
        + `${fixed.slice(0, 6).map((p) => p.periodName).join(', ')}${fixed.length > 6 ? ` and ${fixed.length - 6} more` : ''}. `
        + 'Reopen them first; closed and locked periods never move.');
    }
    refusals.push(...await budgetRehomeRefusals(companyId, boundary, currentYear.fiscalYear));
  }

  return {
    currentYear, currentStartMonth, options: plan.options, chosen, movingPeriods, refusals,
    effects: chosen ? describeEffects(currentYear, chosen, movingPeriods) : [],
  };
}

function describeEffects(year: FiscalYearRecord, chosen: TransitionOption, moving: MovingPeriod[]): string[] {
  const posted = moving.reduce((n, p) => n + p.postedJournals, 0);
  return [
    `FY${year.fiscalYear} becomes a ${chosen.months}-month transition year: ${year.startDate} to ${chosen.endDate} `
      + `(it was ${year.startDate} to ${year.endDate}). It keeps its label FY${year.fiscalYear}.`,
    `The next financial year starts on ${chosen.nextYearStart}; later years run twelve months from there.`,
    `${moving.length} monthly period(s) change year${posted > 0 ? `, holding ${posted} posted journal(s): they keep their periods and dates` : ''}.`,
    `AFS for FY${year.fiscalYear} will cover ${chosen.months} months ended ${chosen.endDate}, with a note that the `
      + 'comparative figures are not entirely comparable (IAS 1.36).',
    'The primary budget\'s months move with the months into their new years (each year\'s primary budget).',
    'Payroll is unaffected: the PAYE tax year always runs 1 March to the end of February.',
    `Earlier years keep their dates (the year before still ends ${dayBefore(year.startDate)}).`,
  ];
}

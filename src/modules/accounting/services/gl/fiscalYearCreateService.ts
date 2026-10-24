/**
 * Create a company's twelve fiscal periods for one year.
 *
 * Split out of `fiscalPeriodService` (which sat exactly on the 300-line cap)
 * when period generation stopped being calendar-shaped.
 *
 * ── WHAT CHANGED AND WHY ────────────────────────────────────────────────────
 *
 * This used to build January–December unconditionally. Every company in
 * production carries `financial_year_start = 3`, so every one of the fiscal
 * periods in the database describes a year that no set of financial statements
 * is ever signed for: Brightsphere's "2026" is 1 Jan – 31 Dec 2026 while its AFS
 * covers 1 Mar 2025 – 28 Feb 2026. `closeFiscalYear` rolls whatever twelve
 * months the periods happen to span into retained earnings, so the year-end
 * journal was wrong by construction before anyone touched a number.
 *
 * The boundaries now come from `fiscalYearCalendar`, which is the one place that
 * reads a start month, and the year label follows the convention already in the
 * codebase (`afs/pisCalculatorService`): a fiscal year is named for the calendar
 * year it ENDS in.
 *
 * ── SINCE THE CHANGE-OF-YEAR-END PROGRAMME ──────────────────────────────────
 *
 * A year is a stored `fiscal_years` row (migration 940). createFiscalYear asks
 * the registry for the year with that label (stored, else the template) and
 * builds it with the one generator (fiscalYearGenerator). It no longer refuses
 * a year whose range overlaps existing periods: those periods already belong
 * to that year by their dates (a company onboarded before #777 holds
 * January-December periods inside its declared March year), and the generator
 * fills only the months nobody covers, continuing the labels the neighbouring
 * periods use.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { fmtDate } from '@/lib/fmtDate';
import type { FiscalPeriod, FiscalPeriodStatus } from '../../types/gl.types';
import { JOURNAL_DATE_MAX, JOURNAL_DATE_MIN, journalDayWindowError } from '../../utils/journalDateWindow';
import { resolveFiscalYearStartMonth } from './fiscalYearBasis';
import { getFiscalYear } from './fiscalYearRegistry';
import { generateFiscalYearForDate } from './fiscalYearGenerator';

/**
 * Which start month a NEW fiscal year for this company should use.
 *
 * Two sources, in this order, and the order is the load-bearing part:
 *
 *   1. The layout the company's EXISTING periods already use — the calendar
 *      month that `period_number = 1` starts in, taken from the most recent
 *      fiscal year.
 *   2. `companies.financial_year_start`, normalised (NULL and 0 become March).
 *
 * Existing periods win because a company with HALF its history on a calendar
 * layout and half on a fiscal one is worse off than a company consistently on
 * the wrong one: every range report would double-count one span and miss
 * another, and no fiscal year would tie to any other. Migrating a live tenant's
 * periods is a data correction with its own approval, explicitly out of scope
 * here; what is in scope is that the misalignment stops being invisible, which
 * `alignment` on `list_fiscal_periods` does.
 *
 * A company with no periods yet — every newly provisioned tenant — gets its own
 * financial year from the first period onward. That is the case this fixes for
 * good.
 */
export async function resolveCompanyPeriodAlignment(companyId: string): Promise<FiscalYearAlignment> {
  const rows = (await sql`
    SELECT c.financial_year_start,
           (SELECT EXTRACT(MONTH FROM fp.start_date)::int
              FROM fiscal_periods fp
             WHERE fp.company_id = c.id AND fp.period_number = 1
             ORDER BY fp.fiscal_year DESC
             LIMIT 1) AS existing_start_month
      FROM companies c
     WHERE c.id = ${companyId}::UUID
     LIMIT 1
  `) as DbRow[];

  if (rows.length === 0) throw new Error(`Company ${companyId} not found`);
  // The shared basis, and NO fallback. createFiscalYear is a write path:
  // building a year on a guessed March start is silent and unrecoverable once
  // journals are posted into the periods. Zero production companies have a NULL
  // financial_year_start today, so the refusal is a guard against future
  // misconfiguration rather than a behaviour change.
  const declared = resolveFiscalYearStartMonth(rows[0]!.financial_year_start, companyId);
  const raw = rows[0]?.existing_start_month;
  const existing = raw === null || raw === undefined ? null : Number(raw);
  const observed = existing !== null && existing >= 1 && existing <= 12 ? existing : null;

  return {
    declaredStartMonth: declared,
    observedStartMonth: observed,
    startMonth: observed ?? declared,
    aligned: observed === null || observed === declared,
  };
}

export interface FiscalYearAlignment {
  /** `companies.financial_year_start`, normalised. What the books SHOULD use. */
  declaredStartMonth: number;
  /** Month period 1 actually starts in today, or null when there are no periods. */
  observedStartMonth: number | null;
  /** The month a new year will be built on. */
  startMonth: number;
  /** False when the existing periods contradict the declared financial year. */
  aligned: boolean;
}

/**
 * Make sure the financial year labelled `year` exists with a period for every
 * month: the stored year, else the template year that carries the label.
 * Refuses a label whose periods already exist, a label the template skips, a
 * year outside the ledger-date window, and a closed or locked year.
 */
export async function createFiscalYear(companyId: string, year: number): Promise<FiscalPeriod[]> {
  const existing = (await sql`
    SELECT COUNT(*) AS cnt FROM fiscal_periods WHERE company_id = ${companyId} AND fiscal_year = ${year}
  `) as DbRow[];
  if (Number(existing[0]!.cnt) > 0) {
    throw new Error(`Fiscal year ${year} already exists`);
  }

  // The label's own calendar year must lie in the ledger-date window before the
  // registry walks to it (it steps year by year from the stored years).
  if (!Number.isInteger(year) || journalDayWindowError(`${year}-01-01`) || journalDayWindowError(`${year}-12-31`)) {
    throw new Error(`Fiscal year ${year} is outside ${JOURNAL_DATE_MIN} to ${JOURNAL_DATE_MAX}`);
  }
  const target = await getFiscalYear(companyId, year);
  if (!target) {
    throw new Error(`Fiscal year ${year} cannot be created: no financial year of this company carries that label`);
  }
  // Ledger-date window (utils/journalDateWindow): a period dates the journals no createJournalEntry check sees (the
  // year-end close, depreciation), so the year's whole range must lie inside it.
  if (journalDayWindowError(target.startDate) ?? journalDayWindowError(target.endDate)) {
    throw new Error(`Fiscal year ${year} is outside ${JOURNAL_DATE_MIN} to ${JOURNAL_DATE_MAX}`);
  }
  if (target.status === 'closed' || target.status === 'locked') {
    throw new Error(`Fiscal year ${year} is ${target.status}`);
  }

  const { fiscalYearId, periodsCreated } = await generateFiscalYearForDate(companyId, target.startDate);
  const rows = (await sql`
    SELECT * FROM fiscal_periods WHERE company_id = ${companyId}::UUID AND fiscal_year_id = ${fiscalYearId}::UUID
     ORDER BY start_date
  `) as DbRow[];

  log.info('Created fiscal year', { companyId, year, range: [target.startDate, target.endDate], periodsCreated }, 'accounting');
  return rows.map(mapFiscalPeriodRow);
}

export function mapFiscalPeriodRow(row: DbRow): FiscalPeriod {
  return {
    id: String(row.id),
    periodName: String(row.period_name),
    periodNumber: Number(row.period_number),
    fiscalYear: Number(row.fiscal_year),
    startDate: fmtDate(row.start_date),
    endDate: fmtDate(row.end_date),
    status: String(row.status) as FiscalPeriodStatus,
    closedBy: row.closed_by ? String(row.closed_by) : undefined,
    closedAt: row.closed_at ? String(row.closed_at) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
